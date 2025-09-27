'use strict';

// --- Imports ---
require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require("socket.io");
const line = require('@line/bot-sdk');
const { v4: uuidv4 } = require('uuid');
const SpotifyWebApi = require('spotify-web-api-node');
const { google } = require('googleapis');

// --- Configuration ---
const lineConfig = {
    channelAccessToken: process.env.CHANNEL_ACCESS_TOKEN,
    channelSecret: process.env.CHANNEL_SECRET,
};

const spotifyApi = new SpotifyWebApi({
    clientId: process.env.SPOTIFY_CLIENT_ID,
    clientSecret: process.env.SPOTIFY_CLIENT_SECRET,
});

const SPREADSHEET_ID = process.env.SPREADSHEET_ID;
const argPortIndex = process.argv.indexOf('--port');
const PORT = argPortIndex !== -1 ? process.argv[argPortIndex + 1] : process.env.PORT || 3000;

// --- Application State (In-Memory) ---
let songQueue = []; // Current queue
let songHistory = []; // All songs ever played (for stats)
let playedToday = []; // Songs played today (for the warning)
const activeConfirmations = {};

// --- In-Memory Functions ---
// Reset the "played today" list at midnight
function scheduleDailyReset() {
    const now = new Date();
    const night = new Date(
        now.getFullYear(),
        now.getMonth(),
        now.getDate() + 1, // The next day
        0, 0, 0 // at 00:00:00 hours
    );
    const msToMidnight = night.getTime() - now.getTime();

    setTimeout(() => {
        playedToday = []; // Reset the list
        console.log("Resetting the 'playedToday' list.");
        scheduleDailyReset(); // Schedule the next reset
    }, msToMidnight);
}

// Check if a song was played today (from in-memory list)
function hasBeenPlayedToday(songName, artistName) {
    return playedToday.some(song => song.name === songName && song.artist === artistName);
}

// --- Google Sheets Integration ---
async function loadHistoryFromGoogleSheet() {
    if (!SPREADSHEET_ID) {
        console.log('SPREADSHEET_ID not found in .env, skipping loading history from Google Sheet.');
        return;
    }
    try {
        const auth = new google.auth.GoogleAuth({
            keyFile: 'credentials.json',
            scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
        });

        const sheets = google.sheets({ version: 'v4', auth });

        console.log('Attempting to load history from Google Sheet...');
        const response = await sheets.spreadsheets.values.get({
            spreadsheetId: SPREADSHEET_ID,
            range: 'Sheet1!A:D', // Read columns: Timestamp, Song, Artist, User
        });

        const rows = response.data.values;
        // Start from row 1 to skip header
        if (rows && rows.length > 1) {
            songHistory = rows.slice(1).map(row => ({
                name: row[1],
                artist: row[2],
                userName: row[3],
            })).filter(s => s.name && s.artist); // Ensure song and artist exist

            console.log(`Successfully loaded ${songHistory.length} songs from Google Sheet.`);
        } else {
            console.log('No data found in Google Sheet or sheet is empty.');
        }
    } catch (err) {
        console.error('Error loading history from Google Sheet:', err.message);
        if (err.message && err.message.includes('Unable to parse range')) {
             console.error('Hint: Make sure your sheet is named "Sheet1" or change the range in the code.');
        }
    }
}

async function updateGoogleSheet(song) {
    if (!SPREADSHEET_ID) {
        console.log('SPREADSHEET_ID not found, skipping update to Google Sheet.');
        return;
    }
    try {
        const auth = new google.auth.GoogleAuth({
            keyFile: 'credentials.json', // Path to your service account key
            scopes: ['https://www.googleapis.com/auth/spreadsheets'],
        });

        const sheets = google.sheets({ version: 'v4', auth });

        // Data to be appended
        const resource = {
            values: [[
                new Date().toISOString(), // Timestamp
                song.name,
                song.artist,
                song.userName,
            ]],
        };

        await sheets.spreadsheets.values.append({
            spreadsheetId: SPREADSHEET_ID,
            range: 'Sheet1!A1', // Target the first cell of "Sheet1"
            valueInputOption: 'USER_ENTERED',
            resource,
        });

    } catch (err) {
        console.error('Error updating Google Sheet:', err);
    }
}


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
            // Refresh token a minute before it expires
            setTimeout(getSpotifyToken, (data.body['expires_in'] - 60) * 1000);
        },
        (err) => {
            console.error('Something went wrong when retrieving a Spotify access token', err);
        }
    );
}

// --- Middleware & Routes ---
app.use(express.static('public'));
app.get('/stats', (req, res) => {
    res.sendFile(__dirname + '/public/stats.html');
});

// In-memory stats API
app.get('/api/stats', (req, res) => {
    // Helper function to count occurrences in an array
    const getCounts = (arr, keyExtractor) => {
        return arr.reduce((acc, item) => {
            const key = keyExtractor(item);
            acc[key] = (acc[key] || 0) + 1;
            return acc;
        }, {});
    };

    // Count song and artist occurrences
    const songCounts = getCounts(songHistory, song => `${song.name} - ${song.artist}`);
    const artistCounts = getCounts(songHistory.flatMap(s => s.artist.split(', ').map(a => a.trim())), artist => artist);

    // Helper to format for the frontend
    const formatForResponse = (counts) => {
        return Object.entries(counts)
            .map(([name, count]) => ({ name, count }))
            .sort((a, b) => b.count - a.count)
            .slice(0, 20);
    };

    res.json({
        songs: formatForResponse(songCounts),
        artists: formatForResponse(artistCounts),
    });
});


// --- LINE Webhook ---
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

    // --- Postback Event (User confirms song) ---
    if (event.type === 'postback') {
        try {
            const postbackData = JSON.parse(event.postback.data);
            const { confirmationId, ...songData } = postbackData;

            // Check if confirmation is still valid
            if (!activeConfirmations[userId] || activeConfirmations[userId] !== confirmationId) {
                return lineClient.replyMessage(event.replyToken, { type: 'text', text: 'This confirmation has expired.' });
            }
            delete activeConfirmations[userId]; // Invalidate confirmation

            const profile = await lineClient.getProfile(userId);
            const userName = profile.displayName;

            // Check for duplicates in the current queue
            const isDuplicateInQueue = songQueue.some(song => song.name === songData.name && song.artist === songData.artist);
            if (isDuplicateInQueue) {
                const replyText = `\"${songData.name}\" is already in the queue.`;
                return lineClient.replyMessage(event.replyToken, { type: 'text', text: replyText });
            }

            const newSong = {
                id: uuidv4(),
                name: songData.name,
                artist: songData.artist,
                albumArt: songData.albumArt,
                wasPlayedToday: songData.wasPlayedToday, // Keep the flag from the search
                userName: userName,
            };

            songQueue.push(newSong);
            console.log(`Added to queue: ${newSong.name} by ${newSong.userName}`);
            io.emit('update_queue', songQueue); // Notify web clients

            const replyText = `\"${newSong.name}\" by ${newSong.artist} has been added to the queue!`;
            return lineClient.replyMessage(event.replyToken, { type: 'text', text: replyText });

        } catch (err) {
            console.error('Postback handling error:', err);
            return Promise.resolve(null);
        }
    }

    // --- Message Event (User sends text) ---
    if (event.type !== 'message' || event.message.type !== 'text') {
        return Promise.resolve(null); // Ignore non-text messages
    }

    const query = event.message.text.trim();
    if (!query) return Promise.resolve(null);

    // Handle "No" response to a confirmation
    if (query.toLowerCase() === 'no, search again' || query.toLowerCase() === 'no') {
        delete activeConfirmations[userId];
        return lineClient.replyMessage(event.replyToken, { type: 'text', text: 'Got it. Please enter a new song name.' });
    }

    try {
        const searchResult = await spotifyApi.searchTracks(query, { limit: 1 });
        if (searchResult.body.tracks.items.length === 0) {
            return lineClient.replyMessage(event.replyToken, { type: 'text', text: `Sorry, I couldn\'t find "${query}".` });
        }

        const track = searchResult.body.tracks.items[0];
        const songData = {
            name: track.name,
            artist: track.artists.map(a => a.name).join(', '),
            albumArt: track.album.images[0]?.url || 'https://via.placeholder.com/150',
        };

        // Check against in-memory list
        const wasPlayed = hasBeenPlayedToday(songData.name, songData.artist);

        let confirmationText = `Artist: ${songData.artist}`;
        if (wasPlayed) {
            confirmationText += '\n(This song has been requested today)';
        }

        // Create a new confirmation
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
        // Add a check for auth error
        if (err.body && err.body.error && err.body.error.message === 'Invalid access token') {
             return lineClient.replyMessage(event.replyToken, { type: 'text', text: 'Sorry, I\'m having temporary trouble with Spotify. Please try again in a moment.' });
        }
        return lineClient.replyMessage(event.replyToken, { type: 'text', text: 'An error occurred.' });
    }
}


// --- Socket.IO Handler ---
io.on('connection', (socket) => {
    console.log('A user connected to the display.');
    socket.emit('update_queue', songQueue); // Send current queue on connection

    socket.on('delete_song', (songId) => {
        songQueue = songQueue.filter(song => song.id !== songId);
        console.log(`Removed song with ID: ${songId}`);
        io.emit('update_queue', songQueue);
    });

    socket.on('song_played', (songId) => {
        const playedSong = songQueue.find(song => song.id === songId);
        if (playedSong) {
            // Add to in-memory history and playedToday lists
            songHistory.push(playedSong);
            playedToday.push(playedSong);
            console.log(`Logged played song to memory: ${playedSong.name}`);

            // Update Google Sheet
            updateGoogleSheet(playedSong);

            // Remove from queue
            songQueue = songQueue.filter(song => song.id !== songId);
            io.emit('update_queue', songQueue);
        }
    });

    socket.on('disconnect', () => {
        console.log('A user disconnected.');
    });
});


// --- Server Startup ---
(async () => {
    await loadHistoryFromGoogleSheet();
    server.listen(PORT, () => {
        console.log(`Server is listening on port ${PORT}`);
        console.log(`Open http://localhost:${PORT} in your browser.`);
        getSpotifyToken();
        scheduleDailyReset(); // Start the daily timer
    });
})();
