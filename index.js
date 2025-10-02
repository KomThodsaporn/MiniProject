'use strict';

// --- Imports ---
require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require("socket.io");
const line = require('@line/bot-sdk');
const { v4: uuidv4 } = require('uuid');
const SpotifyWebApi = require('spotify-web-api-node');
const sqlite3 = require('sqlite3').verbose();

// --- Configuration ---
const lineConfig = {
    channelAccessToken: process.env.CHANNEL_ACCESS_TOKEN,
    channelSecret: process.env.CHANNEL_SECRET,
};

const spotifyApi = new SpotifyWebApi({
    clientId: process.env.SPOTIFY_CLIENT_ID,
    clientSecret: process.env.SPOTIFY_CLIENT_SECRET,
});

const argPortIndex = process.argv.indexOf('--port');
const PORT = argPortIndex !== -1 ? process.argv[argPortIndex + 1] : process.env.PORT || 3000;

// --- Database Initialization ---
const db = new sqlite3.Database('./song_history.db', (err) => {
    if (err) {
        console.error('Error opening database', err.message);
    } else {
        console.log('Connected to the SQLite database.');
        // Table for all played songs
        db.run(`CREATE TABLE IF NOT EXISTS song_history (
            id TEXT PRIMARY KEY,
            timestamp TEXT NOT NULL,
            name TEXT NOT NULL,
            artist TEXT NOT NULL,
            userName TEXT NOT NULL
        )`);
        // Table for songs currently in the queue
        db.run(`CREATE TABLE IF NOT EXISTS pending_songs (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            artist TEXT NOT NULL,
            albumArt TEXT,
            wasPlayedToday BOOLEAN,
            userName TEXT NOT NULL
        )`);
    }
});


// --- Application State (In-Memory) ---
let songQueue = [];
let songHistory = [];
let playedToday = [];
const activeConfirmations = {};

// --- In-Memory Functions ---
function scheduleDailyReset() {
    const now = new Date();
    const night = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 0);
    const msToMidnight = night.getTime() - now.getTime();

    setTimeout(() => {
        playedToday = [];
        console.log("Resetting the 'playedToday' list.");
        scheduleDailyReset();
    }, msToMidnight);
}

function hasBeenPlayedToday(songName, artistName) {
    return playedToday.some(song => song.name === songName && song.artist === artistName);
}

// --- Database Functions ---

// Load complete song history from DB
async function loadHistoryFromDb() {
    return new Promise((resolve, reject) => {
        db.all("SELECT name, artist, userName FROM song_history ORDER BY timestamp ASC", [], (err, rows) => {
            if (err) {
                console.error('Error loading history from database:', err.message);
                return reject(err);
            }
            songHistory = rows.map(row => ({ name: row.name, artist: row.artist, userName: row.userName }));
            console.log(`Successfully loaded ${songHistory.length} songs from the database history.`);
            resolve();
        });
    });
}

// Load pending songs (the queue) from DB
async function loadPendingSongsFromDb() {
    return new Promise((resolve, reject) => {
        db.all("SELECT * FROM pending_songs", [], (err, rows) => {
            if (err) {
                console.error('Error loading pending songs from database:', err.message);
                return reject(err);
            }
            // Ensure wasPlayedToday is a boolean
            songQueue = rows.map(row => ({ ...row, wasPlayedToday: !!row.wasPlayedToday }));
            console.log(`Successfully loaded ${songQueue.length} pending songs into the queue.`);
            resolve();
        });
    });
}

// Add a song to the history table
async function addSongToHistoryDb(song) {
     db.run(`INSERT INTO song_history (id, timestamp, name, artist, userName) VALUES (?, ?, ?, ?, ?)`,
        [song.id, new Date().toISOString(), song.name, song.artist, song.userName],
        (err) => {
            if (err) console.error('Error updating database history:', err.message);
            else console.log(`Added ${song.name} to database history.`);
     });
}

// Add a song to the pending queue table
async function addSongToPendingDb(song) {
    db.run(`INSERT INTO pending_songs (id, name, artist, albumArt, wasPlayedToday, userName) VALUES (?, ?, ?, ?, ?, ?)`,
        [song.id, song.name, song.artist, song.albumArt, song.wasPlayedToday, song.userName],
        (err) => {
            if (err) console.error('Error adding song to pending DB:', err.message);
            else console.log(`Added ${song.name} to pending database.`);
        }
    );
}

// Remove a song from the pending queue table
async function removeSongFromPendingDb(songId) {
    db.run(`DELETE FROM pending_songs WHERE id = ?`, [songId], (err) => {
        if (err) console.error('Error removing song from pending DB:', err.message);
        else console.log(`Removed song ${songId} from pending database.`);
    });
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
            setTimeout(getSpotifyToken, (data.body['expires_in'] - 60) * 1000);
        },
        (err) => console.error('Something went wrong when retrieving a Spotify access token', err)
    );
}

// --- Middleware & Routes ---
app.use(express.static('public'));
app.get('/stats', (req, res) => {
    res.sendFile(__dirname + '/public/stats.html');
});

app.get('/api/stats', (req, res) => {
    const getCounts = (arr, keyExtractor) => arr.reduce((acc, item) => {
        const key = keyExtractor(item);
        acc[key] = (acc[key] || 0) + 1;
        return acc;
    }, {});

    const songCounts = getCounts(songHistory, song => `${song.name} - ${song.artist}`);
    const artistCounts = getCounts(songHistory.flatMap(s => s.artist.split(', ').map(a => a.trim())), artist => artist);

    const formatForResponse = (counts) => Object.entries(counts)
        .map(([name, count]) => ({ name, count }))
        .sort((a, b) => b.count - a.count)
        .slice(0, 20);

    res.json({ songs: formatForResponse(songCounts), artists: formatForResponse(artistCounts) });
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

    if (event.type === 'postback') {
        try {
            const postbackData = JSON.parse(event.postback.data);
            const { confirmationId, ...songData } = postbackData;

            if (!activeConfirmations[userId] || activeConfirmations[userId] !== confirmationId) {
                return lineClient.replyMessage(event.replyToken, { type: 'text', text: 'This confirmation has expired.' });
            }
            delete activeConfirmations[userId];

            const profile = await lineClient.getProfile(userId);
            const userName = profile.displayName;

            const isDuplicateInQueue = songQueue.some(song => song.name === songData.name && song.artist === songData.artist);
            if (isDuplicateInQueue) {
                return lineClient.replyMessage(event.replyToken, { type: 'text', text: `"${songData.name}" is already in the queue.` });
            }

            const newSong = {
                id: uuidv4(),
                name: songData.name,
                artist: songData.artist,
                albumArt: songData.albumArt,
                wasPlayedToday: songData.wasPlayedToday,
                userName: userName,
            };

            songQueue.push(newSong);
            addSongToPendingDb(newSong); // <-- Add to pending DB
            console.log(`Added to queue: ${newSong.name} by ${newSong.userName}`);
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

        const wasPlayed = hasBeenPlayedToday(songData.name, songData.artist);

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
        if (err.body && err.body.error && err.body.error.message === 'Invalid access token') {
             return lineClient.replyMessage(event.replyToken, { type: 'text', text: 'Sorry, I\'m having temporary trouble with Spotify. Please try again in a moment.' });
        }
        return lineClient.replyMessage(event.replyToken, { type: 'text', text: 'An error occurred.' });
    }
}


// --- Socket.IO Handler ---
io.on('connection', (socket) => {
    console.log('A user connected to the display.');
    socket.emit('update_queue', songQueue);

    socket.on('delete_song', (songId) => {
        songQueue = songQueue.filter(song => song.id !== songId);
        removeSongFromPendingDb(songId); // <-- Remove from pending DB
        console.log(`Removed song with ID: ${songId}`);
        io.emit('update_queue', songQueue);
    });

    socket.on('song_played', (songId) => {
        const playedSong = songQueue.find(song => song.id === songId);
        if (playedSong) {
            songHistory.push(playedSong);
            playedToday.push(playedSong);
            console.log(`Logged played song to memory: ${playedSong.name}`);

            addSongToHistoryDb(playedSong); // <-- Add to history DB
            removeSongFromPendingDb(songId); // <-- Remove from pending DB

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
    await loadHistoryFromDb();
    await loadPendingSongsFromDb(); // <-- Load queue from DB
    server.listen(PORT, () => {
        console.log(`Server is listening on port ${PORT}`);
        console.log(`Open http://localhost:${PORT} in your browser.`);
        getSpotifyToken();
        scheduleDailyReset();
    });
})();
