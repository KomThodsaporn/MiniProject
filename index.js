'use strict';

require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require("socket.io");
const line = require('@line/bot-sdk');
const { v4: uuidv4 } = require('uuid');
const SpotifyWebApi = require('spotify-web-api-node');
const { GoogleSpreadsheet } = require('google-spreadsheet');
const { JWT } = require('google-auth-library');
const stringSimilarity = require('string-similarity');

// --- Configuration ---
const lineConfig = {
    channelAccessToken: process.env.CHANNEL_ACCESS_TOKEN,
    channelSecret: process.env.CHANNEL_SECRET,
};
const spotifyApi = new SpotifyWebApi({
    clientId: process.env.SPOTIFY_CLIENT_ID,
    clientSecret: process.env.SPOTIFY_CLIENT_SECRET,
});
const PORT = parseInt(process.env.PORT) || process.argv[3] || 8080;
const SHEET_ID = process.env.GOOGLE_SHEET_ID;

// --- Google Sheet Setup ---
const serviceAccountAuth = new JWT({
    email: require('./credentials.json').client_email,
    key: require('./credentials.json').private_key,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
});
const doc = new GoogleSpreadsheet(SHEET_ID, serviceAccountAuth);
let sheet;

async function initSheet() {
    try {
        await doc.loadInfo();
        sheet = doc.sheetsByIndex[0];
        console.log(`Connected to Google Sheet: "${sheet.title}"`);
    } catch (err) {
        console.error('Failed to connect to Google Sheet:', err);
    }
}

async function hasBeenPlayedToday(songName, artistName) {
    if (!sheet) {
        console.log("Sheet not initialized, skipping duplicate check.");
        return false;
    }
    try {
        const rows = await sheet.getRows();
        const bangkokTimezone = 'Asia/Bangkok';
        const todayString = new Date().toLocaleDateString('en-US', { timeZone: bangkokTimezone });

        for (const row of rows) {
            const timestampStr = row.get('Timestamp');
            if (timestampStr) {
                const playedDateString = new Date(timestampStr).toLocaleDateString('en-US', { timeZone: bangkokTimezone });
                if (playedDateString === todayString && row.get('Song Name') === songName && row.get('Artist') === artistName) {
                    return true;
                }
            }
        }
        return false;
    } catch (err) {
        console.error("Error checking for played song in Google Sheet:", err);
        return false;
    }
}

// --- State ---
let songQueue = [];
const activeConfirmations = {};

// --- Initialization ---
const app = express();
const server = http.createServer(app);
const io = new Server(server);
const lineClient = new line.Client(lineConfig);

// --- Spotify Auth ---
function getSpotifyToken() {
    spotifyApi.clientCredentialsGrant().then(
        (data) => {
            console.log('The access token expires in ' + data.body['expires_in']);
            spotifyApi.setAccessToken(data.body['access_token']);
            setTimeout(getSpotifyToken, (data.body['expires_in'] - 60) * 1000);
        },
        (err) => console.error('Something went wrong when retrieving an access token', err)
    );
}

// --- Middleware & Routes ---
app.use(express.static('public'));
app.get('/stats', (req, res) => res.sendFile(__dirname + '/public/stats.html'));

app.get('/api/stats', async (req, res) => {
    try {
        if (!sheet) {
            return res.status(500).json({ error: 'Sheet not initialized' });
        }
        const rows = await sheet.getRows();

        const songCounts = {};
        const artistCounts = {};

        rows.forEach(row => {
            const songName = row.get('Song Name');
            const artistName = row.get('Artist');

            if (songName) {
                songCounts[songName] = (songCounts[songName] || 0) + 1;
            }
            if (artistName) {
                const artists = artistName.split(', ');
                artists.forEach(artist => {
                    artistCounts[artist] = (artistCounts[artist] || 0) + 1;
                });
            }
        });

        const sortAndSlice = (counts) => {
            return Object.entries(counts)
                .map(([name, count]) => ({ name, count }))
                .sort((a, b) => b.count - a.count) // Sort by most requested
                .slice(0, 20); // Return top 20 most requested
        };

        const mostRequestedSongs = sortAndSlice(songCounts);
        const mostRequestedArtists = sortAndSlice(artistCounts);

        res.json({
            songs: mostRequestedSongs,
            artists: mostRequestedArtists,
        });

    } catch (err) {
        console.error('Failed to get stats from Google Sheet:', err);
        res.status(500).json({ error: 'Failed to retrieve stats' });
    }
});

// --- Main Webhook ---
app.post('/webhook', line.middleware(lineConfig), (req, res) => {
    Promise.all(req.body.events.map(handleEvent))
        .then(result => res.json(result))
        .catch(err => {
            console.error('Webhook Error:', err);
            res.status(500).end();
        });
});

// --- Event Handler ---
async function handleEvent(event) {
    const userId = event.source.userId;

    if (event.type === 'postback') {
        try {
            const postbackData = JSON.parse(event.postback.data);
            const { confirmationId, ...songData } = postbackData;

            if (!activeConfirmations[userId] || activeConfirmations[userId] !== confirmationId) {
                return lineClient.replyMessage(event.replyToken, { type: 'text', text: 'This confirmation has expired.' });
            }
            delete activeConfirmations[userId];

            // Check if already in the live queue
            const isDuplicateInQueue = songQueue.some(song => song.name === songData.name && song.artist === songData.artist);
            if (isDuplicateInQueue) {
                const replyText = `"${songData.name}" is already in the queue.`;
                return lineClient.replyMessage(event.replyToken, { type: 'text', text: replyText });
            }

            const newSong = {
                id: uuidv4(),
                name: songData.name,
                artist: songData.artist,
                albumArt: songData.albumArt,
                wasPlayedToday: songData.wasPlayedToday, // Carry the flag over
            };

            songQueue.push(newSong);
            console.log(`Added to queue: ${newSong.name} (Played today: ${newSong.wasPlayedToday})`);
            io.emit('update_queue', songQueue);

            const replyText = `"${newSong.name}" by ${newSong.artist} has been added to the queue!`;
            return lineClient.replyMessage(event.replyToken, { type: 'text', text: replyText });

        } catch (err) {
            console.error('Postback handling error:', err);
            return Promise.resolve(null);
        }
    }

    if (event.type !== 'message' || event.message.type !== 'text') {
        return Promise.resolve(null);
    }

    const query = event.message.text.trim();
    if (!query) return Promise.resolve(null);

    if (query.toLowerCase() === 'no, search again' || query.toLowerCase() === 'no') {
        delete activeConfirmations[userId];
        return lineClient.replyMessage(event.replyToken, { type: 'text', text: 'Got it. Please enter a new song name.' });
    }

    try {
        const searchResult = await spotifyApi.searchTracks(query, { limit: 1 });
        if (searchResult.body.tracks.items.length === 0) {
            return lineClient.replyMessage(event.replyToken, { type: 'text', text: `Sorry, I couldn't find "${query}".` });
        }

        const track = searchResult.body.tracks.items[0];
        const songData = {
            name: track.name,
            artist: track.artists.map(a => a.name).join(', '),
            albumArt: track.album.images[0]?.url || 'https://via.placeholder.com/150',
        };

        // Check if played today BEFORE sending confirmation
        const wasPlayed = await hasBeenPlayedToday(songData.name, songData.artist);

        let confirmationText = `Artist: ${songData.artist}`;
        if (wasPlayed) {
            confirmationText += '\n(This song has been requested today)';
        }

        const confirmationId = uuidv4();
        activeConfirmations[userId] = confirmationId;
        const postbackPayload = { ...songData, confirmationId, wasPlayedToday: wasPlayed };

        const confirmationMessage = {
            type: 'template',
            altText: `Is this the correct song? ${songData.name}`,
            template: {
                type: 'buttons',
                thumbnailImageUrl: songData.albumArt,
                imageAspectRatio: 'square',
                imageSize: 'cover',
                title: songData.name,
                text: confirmationText,
                actions: [
                    {
                        type: 'postback',
                        label: 'Yes, add to queue',
                        data: JSON.stringify(postbackPayload),
                        displayText: `Adding "${songData.name}"...`,
                    },
                    { type: 'message', label: 'No, search again', text: 'No, search again' },
                ],
            },
        };

        return lineClient.replyMessage(event.replyToken, confirmationMessage);

    } catch (err) {
        console.error('Spotify API or LINE reply error:', err);
        return lineClient.replyMessage(event.replyToken, { type: 'text', text: 'An error occurred.' });
    }
}

// --- Socket.IO Handler ---
io.on('connection', (socket) => {
    console.log('A user connected to the display.');
    socket.emit('update_queue', songQueue);

    socket.on('delete_song', (songId) => {
        songQueue = songQueue.filter(song => song.id !== songId);
        console.log(`Removed song with ID: ${songId}`);
        io.emit('update_queue', songQueue);
    });

    socket.on('song_played', async (songId) => {
        const playedSong = songQueue.find(song => song.id === songId);
        if (playedSong && sheet) {
            try {
                await sheet.addRow({
                    Timestamp: new Date().toLocaleString('en-US', { timeZone: 'Asia/Bangkok' }),
                    'Song Name': playedSong.name,
                    Artist: playedSong.artist,
                });
                console.log(`Logged played song to Google Sheet: ${playedSong.name}`);
                songQueue = songQueue.filter(song => song.id !== songId);
                io.emit('update_queue', songQueue);
            } catch (err) {
                console.error('Error adding played song row:', err);
            }
        }
    });

    socket.on('disconnect', () => console.log('A user disconnected.'));
});

// --- Server Start ---
server.listen(PORT, () => {
    console.log(`Server is listening on port ${PORT}`);
    console.log('Open http://localhost:3000 in your browser.');
    getSpotifyToken();
    initSheet();
});
