'use strict';

// --- Imports ---
require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require("socket.io");
const line = require('@line/bot-sdk');
const { v4: uuidv4 } = require('uuid');
const SpotifyWebApi = require('spotify-web-api-node');

// --- Firebase Initialization ---
const admin = require('firebase-admin');
const serviceAccount = require('./service-account-key.json'); 

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});

const db = admin.firestore();


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


// --- Firestore Functions ---

// Load data from Firestore on startup
async function loadDataFromFirestore() {
    try {
        // Load Pending Songs (Queue)
        const pendingSnapshot = await db.collection('pending_songs').orderBy('timestamp', 'asc').get();
        songQueue = pendingSnapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
        console.log(`Successfully loaded ${songQueue.length} pending songs into the queue.`);

        // Load Song History
        const historySnapshot = await db.collection('song_history').orderBy('timestamp', 'asc').get();
        songHistory = historySnapshot.docs.map(doc => doc.data());
        console.log(`Successfully loaded ${songHistory.length} songs from the database history.`);

    } catch (error) {
        console.error("Error loading data from Firestore:", error);
    }
}


// Add a song to the pending queue in Firestore
async function addSongToQueue(song) {
    try {
        await db.collection('pending_songs').doc(song.id).set({
            ...song,
            timestamp: admin.firestore.FieldValue.serverTimestamp() // Add a timestamp
        });
        console.log(`Added ${song.name} to Firestore pending_songs.`);
    } catch (error) {
        console.error('Error adding song to pending Firestore:', error);
    }
}

// Remove a song from the pending queue in Firestore
async function removeSongFromQueue(songId) {
    try {
        await db.collection('pending_songs').doc(songId).delete();
        console.log(`Removed song ${songId} from Firestore pending_songs.`);
    } catch (error) {
        console.error('Error removing song from pending Firestore:', error);
    }
}

// Move a song from pending to history in Firestore
async function moveSongToHistory(song) {
    try {
        // A transaction ensures this is an all-or-nothing operation
        const batch = db.batch();

        // 1. Set the song in the history collection
        const historyRef = db.collection('song_history').doc(song.id);
        batch.set(historyRef, {
             ...song,
             playedAt: admin.firestore.FieldValue.serverTimestamp() // Mark played time
        });

        // 2. Delete the song from the pending collection
        const pendingRef = db.collection('pending_songs').doc(song.id);
        batch.delete(pendingRef);

        await batch.commit();
        console.log(`Moved ${song.name} from pending to history in Firestore.`);

    } catch (error) {
        console.error('Error moving song to history:', error);
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
            await addSongToQueue(newSong); // <-- Use new Firestore function
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

    socket.on('delete_song', async (songId) => {
        songQueue = songQueue.filter(song => song.id !== songId);
        await removeSongFromQueue(songId); // <-- Use new Firestore function
        console.log(`Removed song with ID: ${songId}`);
        io.emit('update_queue', songQueue);
    });

    socket.on('song_played', async (songId) => {
        const playedSong = songQueue.find(song => song.id === songId);
        if (playedSong) {
            songHistory.push(playedSong);
            playedToday.push(playedSong);
            console.log(`Logged played song to memory: ${playedSong.name}`);

            await moveSongToHistory(playedSong); // <-- Use new Firestore function

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
    await loadDataFromFirestore(); // <-- Load queue from Firestore
    server.listen(PORT, () => {
        console.log(`Server is listening on port ${PORT}`);
        console.log(`Open http://localhost:${PORT} in your browser.`);
        getSpotifyToken();
        scheduleDailyReset();
    });
})();
