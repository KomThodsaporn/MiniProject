'use strict';

// --- การนำเข้าไลบรารีและโมดูลต่างๆ ---
require('dotenv').config(); // โหลดค่าจากไฟล์ .env เข้าสู่ process.env
const express = require('express'); // framework หลักสำหรับสร้างเว็บเซิร์ฟเวอร์
const http = require('http'); // โมดูลสำหรับสร้าง HTTP server
const { Server } = require("socket.io"); // ไลบรารีสำหรับ Real-time communication (WebSockets)
const line = require('@line/bot-sdk'); // SDK สำหรับเชื่อมต่อกับ LINE Messaging API
const { v4: uuidv4 } = require('uuid'); // ไลบรารีสำหรับสร้าง unique IDs
const SpotifyWebApi = require('spotify-web-api-node'); // SDK สำหรับเชื่อมต่อกับ Spotify Web API
const { GoogleSpreadsheet } = require('google-spreadsheet'); // ไลบรารีสำหรับทำงานกับ Google Sheets
const { JWT } = require('google-auth-library'); // ไลบรารีสำหรับ Google Authentication
const stringSimilarity = require('string-similarity'); // ไลบรารีสำหรับเปรียบเทียบความคล้ายของข้อความ

// --- การตั้งค่า (Configuration) ---
// ตั้งค่าสำหรับ LINE Bot
const lineConfig = {
    channelAccessToken: process.env.CHANNEL_ACCESS_TOKEN, // Token สำหรับเข้าถึง Channel
    channelSecret: process.env.CHANNEL_SECRET, // Secret สำหรับ Channel
};

// ตั้งค่าสำหรับ Spotify API
const spotifyApi = new SpotifyWebApi({
    clientId: process.env.SPOTIFY_CLIENT_ID, // Client ID ของ Spotify App
    clientSecret: process.env.SPOTIFY_CLIENT_SECRET, // Client Secret ของ Spotify App
});

const PORT = parseInt(process.env.PORT) || process.argv[3] || 8080; // พอร์ตที่เซิร์ฟเวอร์จะรัน
const SHEET_ID = process.env.GOOGLE_SHEET_ID; // ID ของ Google Sheet ที่จะใช้

// --- การตั้งค่า Google Sheet ---
// สร้าง JWT client สำหรับยืนยันตัวตนกับ Google
const serviceAccountAuth = new JWT({
    email: require('./credentials.json').client_email, // อีเมลของ Service Account
    key: require('./credentials.json').private_key, // Private key ของ Service Account
    scopes: ['https://www.googleapis.com/auth/spreadsheets'], // ขอบเขตการเข้าถึง (ขอสิทธิ์แก้ไข Spreadsheets)
});

const doc = new GoogleSpreadsheet(SHEET_ID, serviceAccountAuth); // สร้าง instance ของ Google Spreadsheet
let sheet; // ตัวแปรสำหรับเก็บ Sheet ที่จะทำงานด้วย

// ฟังก์ชันสำหรับเชื่อมต่อและโหลดข้อมูล Google Sheet
async function initSheet() {
    try {
        await doc.loadInfo(); // โหลดข้อมูลของ Spreadsheet
        sheet = doc.sheetsByIndex[0]; // เลือก Sheet แรก
        console.log(`Connected to Google Sheet: "${sheet.title}"`);
    } catch (err) {
        console.error('Failed to connect to Google Sheet:', err);
    }
}

// ฟังก์ชันสำหรับตรวจสอบว่าเพลงเคยถูกเล่นไปแล้วในวันนี้หรือไม่
async function hasBeenPlayedToday(songName, artistName) {
    if (!sheet) {
        console.log("Sheet not initialized, skipping duplicate check.");
        return false;
    }
    try {
        const rows = await sheet.getRows(); // ดึงข้อมูลทุกแถวจาก Sheet
        const bangkokTimezone = 'Asia/Bangkok';
        const todayString = new Date().toLocaleDateString('en-US', { timeZone: bangkokTimezone });

        for (const row of rows) {
            const timestampStr = row.get('Timestamp');
            if (timestampStr) {
                const playedDateString = new Date(timestampStr).toLocaleDateString('en-US', { timeZone: bangkokTimezone });
                if (playedDateString === todayString && row.get('Song Name') === songName && row.get('Artist') === artistName) {
                    return true; // พบว่าเพลงนี้เล่นไปแล้ววันนี้
                }
            }
        }
        return false; // ไม่พบว่าเพลงนี้เล่นไปแล้ววันนี้
    } catch (err) {
        console.error("Error checking for played song in Google Sheet:", err);
        return false;
    }
}

// --- State (สถานะของแอปพลิเคชัน) ---
let songQueue = []; // คิวของเพลงที่รอเล่น
const activeConfirmations = {}; // เก็บ ID การยืนยันที่ยังใช้งานได้ของผู้ใช้แต่ละคน

// --- การ khởi tạo (Initialization) ---
const app = express(); // สร้าง Express app
const server = http.createServer(app); // สร้าง HTTP Server
const io = new Server(server); // สร้าง Socket.IO Server
const lineClient = new line.Client(lineConfig); // สร้าง LINE Bot client

// --- การยืนยันตัวตนกับ Spotify (Spotify Auth) ---
function getSpotifyToken() {
    spotifyApi.clientCredentialsGrant().then(
        (data) => {
            console.log('The access token expires in ' + data.body['expires_in']);
            spotifyApi.setAccessToken(data.body['access_token']); // ตั้งค่า Access Token
            // ตั้งเวลาเพื่อขอ Token ใหม่ก่อนที่อันเก่าจะหมดอายุ
            setTimeout(getSpotifyToken, (data.body['expires_in'] - 60) * 1000);
        },
        (err) => console.error('Something went wrong when retrieving an access token', err)
    );
}

// --- Middleware และ Routes ---
app.use(express.static('public')); // ให้บริการไฟล์ static จากโฟลเดอร์ public
app.get('/stats', (req, res) => res.sendFile(__dirname + '/public/stats.html')); // Route สำหรับหน้าสถิติ

// Route API สำหรับดึงข้อมูลสถิติเพลงและศิลปิน
app.get('/api/stats', async (req, res) => {
    try {
        if (!sheet) {
            return res.status(500).json({ error: 'Sheet not initialized' });
        }
        const rows = await sheet.getRows();

        const songCounts = {}; // เก็บจำนวนครั้งที่แต่ละเพลงถูกขอ
        const artistCounts = {}; // เก็บจำนวนครั้งที่แต่ละศิลปินถูกขอ

        rows.forEach(row => {
            const songName = row.get('Song Name');
            const artistName = row.get('Artist');

            if (songName && artistName) {
                const uniqueSongKey = `${songName} - ${artistName}`;
                songCounts[uniqueSongKey] = (songCounts[uniqueSongKey] || 0) + 1;
            }
            if (artistName) {
                const artists = artistName.split(', ');
                artists.forEach(artist => {
                    artistCounts[artist] = (artistCounts[artist] || 0) + 1;
                });
            }
        });

        // ฟังก์ชันสำหรับเรียงลำดับและตัดข้อมูล 20 อันดับแรก
        const sortAndSlice = (counts) => {
            return Object.entries(counts)
                .map(([name, count]) => ({ name, count }))
                .sort((a, b) => b.count - a.count) // เรียงจากมากไปน้อย
                .slice(0, 20); // เอา 20 อันดับแรก
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


// --- Webhook หลักสำหรับ LINE Bot ---
app.post('/webhook', line.middleware(lineConfig), (req, res) => {
    Promise.all(req.body.events.map(handleEvent)) // ประมวลผลทุก Event ที่ได้รับ
        .then(result => res.json(result))
        .catch(err => {
            console.error('Webhook Error:', err);
            res.status(500).end();
        });
});

// --- ตัวจัดการ Event (Event Handler) ---
async function handleEvent(event) {
    const userId = event.source.userId; // ID ของผู้ใช้ที่ส่ง Event มา

    // จัดการกรณีที่เป็น Postback Event (เช่น การกดปุ่ม "Yes")
    if (event.type === 'postback') {
        try {
            const postbackData = JSON.parse(event.postback.data);
            const { confirmationId, ...songData } = postbackData;

            // ตรวจสอบว่าการยืนยันหมดอายุหรือยัง
            if (!activeConfirmations[userId] || activeConfirmations[userId] !== confirmationId) {
                return lineClient.replyMessage(event.replyToken, { type: 'text', text: 'This confirmation has expired.' });
            }
            delete activeConfirmations[userId]; // ลบการยืนยันที่ใช้แล้ว
            
            const profile = await lineClient.getProfile(userId);
            const userName = profile.displayName;

            // ตรวจสอบว่าเพลงซ้ำในคิวหรือไม่
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

            songQueue.push(newSong); // เพิ่มเพลงใหม่เข้าคิว
            console.log(`Added to queue: ${newSong.name} (Played today: ${newSong.wasPlayedToday}) by ${newSong.userName}`);
            io.emit('update_queue', songQueue); // ส่งอัปเดตคิวไปยังหน้าจอแสดงผล

            const replyText = `"${newSong.name}" by ${newSong.artist} has been added to the queue!`;
            return lineClient.replyMessage(event.replyToken, { type: 'text', text: replyText });

        } catch (err) {
            console.error('Postback handling error:', err);
            return Promise.resolve(null);
        }
    }

    // ไม่ต้องทำอะไรถ้าไม่ใช่ข้อความ
    if (event.type !== 'message' || event.message.type !== 'text') {
        return Promise.resolve(null);
    }

    const query = event.message.text.trim(); // ข้อความที่ผู้ใช้พิมพ์
    if (!query) return Promise.resolve(null);

    // กรณีผู้ใช้พิมพ์ "No" เพื่อค้นหาใหม่
    if (query.toLowerCase() === 'no, search again' || query.toLowerCase() === 'no') {
        delete activeConfirmations[userId]; // ลบการยืนยันเก่า
        return lineClient.replyMessage(event.replyToken, { type: 'text', text: 'Got it. Please enter a new song name.' });
    }

    try {
        // ค้นหาเพลงจาก Spotify
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

        // ตรวจสอบว่าเพลงเคยเล่นวันนี้หรือไม่ ก่อนส่งให้ผู้ใช้ยืนยัน
        const wasPlayed = await hasBeenPlayedToday(songData.name, songData.artist);

        let confirmationText = `Artist: ${songData.artist}`;
        if (wasPlayed) {
            confirmationText += '\n(This song has been requested today)';
        }

        const confirmationId = uuidv4();
        activeConfirmations[userId] = confirmationId; // เก็บ ID การยืนยัน
        const postbackPayload = { ...songData, confirmationId, wasPlayedToday: wasPlayed };

        // สร้างข้อความยืนยันพร้อมปุ่มกด
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
                        data: JSON.stringify(postbackPayload), // ข้อมูลที่จะส่งกลับมาตอนกดปุ่ม
                        displayText: `Adding "${songData.name}"...`,
                    },
                    { type: 'message', label: 'No, search again', text: 'No, search again' },
                ],
            },
        };

        return lineClient.replyMessage(event.replyToken, confirmationMessage); // ส่งข้อความยืนยันไปให้ผู้ใช้

    } catch (err) {
        console.error('Spotify API or LINE reply error:', err);
        return lineClient.replyMessage(event.replyToken, { type: 'text', text: 'An error occurred.' });
    }
}

// --- ตัวจัดการ Socket.IO ---
io.on('connection', (socket) => {
    console.log('A user connected to the display.');
    socket.emit('update_queue', songQueue); // ส่งคิวเพลงปัจจุบันไปให้ client ที่เชื่อมต่อเข้ามาใหม่

    // เมื่อมีการลบเพลงจากหน้าจอ
    socket.on('delete_song', (songId) => {
        songQueue = songQueue.filter(song => song.id !== songId);
        console.log(`Removed song with ID: ${songId}`);
        io.emit('update_queue', songQueue); // อัปเดตคิวให้ทุก client
    });

    // เมื่อมีการกดเล่นเพลงจากหน้าจอ
    socket.on('song_played', async (songId) => {
        const playedSong = songQueue.find(song => song.id === songId);
        if (playedSong && sheet) {
            try {
                // เพิ่มข้อมูลเพลงที่เล่นแล้วลงใน Google Sheet
                await sheet.addRow({
                    Timestamp: new Date().toLocaleString('en-US', { timeZone: 'Asia/Bangkok' }),
                    'Song Name': playedSong.name,
                    Artist: playedSong.artist,
                    'Requested By': playedSong.userName,
                });
                console.log(`Logged played song to Google Sheet: ${playedSong.name}`);
                songQueue = songQueue.filter(song => song.id !== songId); // ลบเพลงออกจากคิว
                io.emit('update_queue', songQueue); // อัปเดตคิวให้ทุก client
            } catch (err) {
                console.error('Error adding played song row:', err);
            }
        }
    });

    socket.on('disconnect', () => console.log('A user disconnected.'));
});

// --- การเริ่มทำงานของเซิร์ฟเวอร์ ---
server.listen(PORT, () => {
    console.log(`Server is listening on port ${PORT}`);
    console.log('Open http://localhost:3000 in your browser.');
    getSpotifyToken(); // ขอ Spotify token
    initSheet(); // เชื่อมต่อ Google Sheet
});
