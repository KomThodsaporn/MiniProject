'use strict';

// --- การนำเข้าไลบรารีและโมดูลต่างๆ ---
require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require("socket.io");
const line = require('@line/bot-sdk');
const { v4: uuidv4 } = require('uuid');
const SpotifyWebApi = require('spotify-web-api-node');
const mongoose = require('mongoose');
const Song = require('./models/Song'); // <-- นำเข้า Song Model

// --- การตั้งค่า (Configuration) ---
const lineConfig = {
    channelAccessToken: process.env.CHANNEL_ACCESS_TOKEN,
    channelSecret: process.env.CHANNEL_SECRET,
};

const spotifyApi = new SpotifyWebApi({
    clientId: process.env.SPOTIFY_CLIENT_ID,
    clientSecret: process.env.SPOTIFY_CLIENT_SECRET,
});

const PORT = process.env.PORT || 8080;
const MONGODB_URI = process.env.MONGODB_URI; // <-- URI สำหรับเชื่อมต่อ MongoDB

// --- การเชื่อมต่อฐานข้อมูล MongoDB ---
async function connectDB() {
    if (!MONGODB_URI) {
        console.error('Fatal Error: MONGODB_URI is not defined in .env file');
        process.exit(1); // ออกจากโปรแกรมถ้าไม่มี URI
    }
    try {
        await mongoose.connect(MONGODB_URI);
        console.log('Connected to MongoDB successfully!');
    } catch (err) {
        console.error('Failed to connect to MongoDB:', err);
        process.exit(1);
    }
}

// --- ฟังก์ชันที่ทำงานกับฐานข้อมูล ---
// ตรวจสอบว่าเพลงเคยถูกขอในวันนี้หรือไม่ (ฟังก์ชันใหม่ที่ใช้ MongoDB)
async function hasBeenPlayedToday(songName, artistName) {
    try {
        // ตั้งเวลาเที่ยงคืนของวันนี้ในโซนเวลา กทม.
        const now = new Date();
        const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate());
        startOfDay.setHours(startOfDay.getHours() - 7); // ปรับเป็น UTC+0

        const song = await Song.findOne({
            name: songName,
            artist: artistName,
            timestamp: { $gte: startOfDay }
        });

        return !!song; // คืนค่า true ถ้าเจอเพลง, false ถ้าไม่เจอ
    } catch (err) {
        console.error("Error checking for played song in MongoDB:", err);
        return false; // กรณีมีข้อผิดพลาด ให้ถือว่ายังไม่เคยเล่น
    }
}

// --- State (สถานะของแอปพลิเคชัน) ---
let songQueue = []; // คิวเพลงที่รอเล่น (ยังคงใช้สำหรับหน้าจอ real-time)
const activeConfirmations = {};

// --- การ khởi tạo (Initialization) ---
const app = express();
const server = http.createServer(app);
const io = new Server(server);
const lineClient = new line.Client(lineConfig);

// --- การยืนยันตัวตนกับ Spotify (Spotify Auth) ---
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

// --- Middleware และ Routes ---
app.use(express.static('public'));
app.get('/stats', (req, res) => res.sendFile(__dirname + '/public/stats.html'));

// Route API สำหรับดึงข้อมูลสถิติ (ฟังก์ชันใหม่ที่ใช้ MongoDB Aggregation)
app.get('/api/stats', async (req, res) => {
    try {
        // 20 เพลงที่ถูกขอบ่อยที่สุด
        const mostRequestedSongs = await Song.aggregate([
            { $group: { _id: { name: "$name", artist: "$artist" }, count: { $sum: 1 } } },
            { $sort: { count: -1 } },
            { $limit: 20 },
            { $project: { _id: 0, name: { $concat: ["$_id.name", " - ", "$_id.artist"] }, count: "$count" } }
        ]);

        // 20 ศิลปินที่ถูกขอบ่อยที่สุด
        const mostRequestedArtists = await Song.aggregate([
            { $project: { artists: { $split: ["$artist", ", "] } } },
            { $unwind: "$artists" },
            { $group: { _id: "$artists", count: { $sum: 1 } } },
            { $sort: { count: -1 } },
            { $limit: 20 },
            { $project: { _id: 0, name: "$_id", count: "$count" } }
        ]);

        res.json({
            songs: mostRequestedSongs,
            artists: mostRequestedArtists,
        });

    } catch (err) {
        console.error('Failed to get stats from MongoDB:', err);
        res.status(500).json({ error: 'Failed to retrieve stats' });
    }
});

// --- Webhook หลักสำหรับ LINE Bot ---
app.post('/webhook', line.middleware(lineConfig), (req, res) => {
    Promise.all(req.body.events.map(handleEvent))
        .then(result => res.json(result))
        .catch(err => {
            console.error('Webhook Error:', err);
            res.status(500).end();
        });
});

// --- ตัวจัดการ Event (Event Handler) ---
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
                const replyText = `"${songData.name}" is already in the queue.`;
                return lineClient.replyMessage(event.replyToken, { type: 'text', text: replyText });
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
            return lineClient.replyMessage(event.replyToken, { type: 'text', text: `Sorry, I couldn\'t find "${query}".` });
        }

        const track = searchResult.body.tracks.items[0];
        const songData = {
            name: track.name,
            artist: track.artists.map(a => a.name).join(', '),
            albumArt: track.album.images[0]?.url || 'https://via.placeholder.com/150',
        };

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

// --- ตัวจัดการ Socket.IO ---
io.on('connection', (socket) => {
    console.log('A user connected to the display.');
    socket.emit('update_queue', songQueue);

    socket.on('delete_song', (songId) => {
        songQueue = songQueue.filter(song => song.id !== songId);
        console.log(`Removed song with ID: ${songId}`);
        io.emit('update_queue', songQueue);
    });

    // เมื่อมีการกดเล่นเพลงจากหน้าจอ (ฟังก์ชันใหม่ที่บันทึกลง MongoDB)
    socket.on('song_played', async (songId) => {
        const playedSong = songQueue.find(song => song.id === songId);
        if (playedSong) {
            try {
                // สร้าง Document ใหม่และบันทึกลง MongoDB
                const songLog = new Song({
                    name: playedSong.name,
                    artist: playedSong.artist,
                    albumArt: playedSong.albumArt,
                    requestedBy: playedSong.userName,
                });
                await songLog.save();
                console.log(`Logged played song to MongoDB: ${playedSong.name}`);

                // ลบเพลงออกจากคิวหลังจากบันทึกแล้ว
                songQueue = songQueue.filter(song => song.id !== songId);
                io.emit('update_queue', songQueue);
            } catch (err) {
                console.error('Error saving played song to MongoDB:', err);
            }
        }
    });

    socket.on('disconnect', () => console.log('A user disconnected.'));
});

// --- การเริ่มทำงานของเซิร์ฟเวอร์ ---
async function startServer() {
    await connectDB(); // <-- เชื่อมต่อฐานข้อมูลก่อนเปิดเซิร์ฟเวอร์

    server.listen(PORT, () => {
        console.log(`Server is listening on port ${PORT}`);
        console.log('Open http://localhost:3000 in your browser.');
        getSpotifyToken();
    });
}

startServer(); // <-- เริ่มการทำงานของเซิร์ฟเวอร์
