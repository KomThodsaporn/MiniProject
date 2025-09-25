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

// --- ส่วนการตั้งค่า ---
// โหลด channel access token และ channel secret สำหรับ LINE Bot จาก environment variables
const lineConfig = {
    channelAccessToken: process.env.CHANNEL_ACCESS_TOKEN,
    channelSecret: process.env.CHANNEL_SECRET,
};

// เริ่มต้นการเชื่อมต่อ Spotify API client ด้วยข้อมูลจาก environment variables
const spotifyApi = new SpotifyWebApi({
    clientId: process.env.SPOTIFY_CLIENT_ID,
    clientSecret: process.env.SPOTIFY_CLIENT_SECRET,
});

// const PORT = process.env.PORT || 8080;
const PORT = parseInt(process.env.PORT) || process.argv[3] || 8080;
const SHEET_ID = process.env.GOOGLE_SHEET_ID;

// --- การตั้งค่า Google Sheet ---
// ตั้งค่า Google JWT auth client สำหรับการเข้าถึง Google Sheets
const serviceAccountAuth = new JWT({
    email: require('./credentials.json').client_email,
    key: require('./credentials.json').private_key,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
});
// เริ่มต้นการเชื่อมต่อ Google Spreadsheet ด้วย Sheet ID และข้อมูลการยืนยันตัวตน
const doc = new GoogleSpreadsheet(SHEET_ID, serviceAccountAuth);
let sheet; // ตัวแปรนี้จะเก็บ object ของชีตที่ใช้งานหลังจากโหลดเสร็จ

/**
 * โหลดเอกสาร Google Sheet และกำหนดค่าให้กับตัวแปร `sheet`
 */
async function initSheet() {
    try {
        await doc.loadInfo();
        sheet = doc.sheetsByIndex[0]; // ใช้ชีตแรกในเอกสาร
        console.log(`Connected to Google Sheet: "${sheet.title}"`);
    } catch (err) {
        console.error('Failed to connect to Google Sheet:', err);
    }
}

// --- ส่วนของ State ---
// Array ในหน่วยความจำสำหรับเก็บคิวเพลง
let songQueue = [];
// Object ในหน่วยความจำสำหรับเก็บ token การยืนยันที่ยังใช้งานได้ของผู้ใช้แต่ละคน เพื่อป้องกันการยืนยันที่หมดอายุแล้ว
const activeConfirmations = {}; // Key: userId, Value: confirmationId

// --- การเริ่มต้นระบบ ---
const app = express();
const server = http.createServer(app);
const io = new Server(server); // เริ่มต้นเซิร์ฟเวอร์ Socket.IO
const lineClient = new line.Client(lineConfig); // เริ่มต้น LINE Bot client

// --- การยืนยันตัวตน Spotify ---
/**
 * ดึงข้อมูล access token ของ Spotify API โดยใช้ client credentials
 * token จะถูกรีเฟรชโดยอัตโนมัติก่อนที่จะหมดอายุ
 */
function getSpotifyToken() {
    spotifyApi.clientCredentialsGrant().then(
        (data) => {
            console.log('The access token expires in ' + data.body['expires_in']);
            spotifyApi.setAccessToken(data.body['access_token']);
            // รีเฟรช token หนึ่งนาทีก่อนที่จะหมดอายุ
            setTimeout(getSpotifyToken, (data.body['expires_in'] - 60) * 1000);
        },
        (err) => {
            console.error('Something went wrong when retrieving an access token', err);
        }
    );
}

// --- Middleware ---
// ให้บริการไฟล์ static (HTML, CSS, JS) จากไดเรกทอรี 'public'
app.use(express.static('public'));

// --- การกำหนดเส้นทางสำหรับหน้า HTML ---
// เส้นทางสำหรับให้บริการหน้าสถิติ
app.get('/stats', (req, res) => {
    res.sendFile(__dirname + '/public/stats.html');
});

// --- การกำหนดเส้นทางสำหรับ API ---
// API endpoint สำหรับดึงข้อมูลสถิติเพลงและศิลปินจาก Google Sheet
app.get('/api/stats', async (req, res) => {
    if (!sheet) {
        return res.status(503).json({ error: 'Google Sheet not available yet. Please try again in a moment.' });
    }

    try {
        const rows = await sheet.getRows();
        const songCounts = {};
        const artistCounts = {};

        // นับจำนวนครั้งที่เล่นของแต่ละเพลงและศิลปิน
        rows.forEach(row => {
            const songName = row.get('Song Name');
            const artistName = row.get('Artist');

            if (songName) {
                songCounts[songName] = (songCounts[songName] || 0) + 1;
            }
            if (artistName) {
                artistName.split(',').forEach(artist => {
                    const trimmedArtist = artist.trim();
                    if (trimmedArtist) {
                        artistCounts[trimmedArtist] = (artistCounts[trimmedArtist] || 0) + 1;
                    }
                });
            }
        });

        // จัดเรียงเพลงและศิลปินตามจำนวนครั้งที่เล่น
        const sortedSongs = Object.entries(songCounts)
            .map(([name, count]) => ({ name, count }))
            .sort((a, b) => a.count - b.count);

        const sortedArtists = Object.entries(artistCounts)
            .map(([name, count]) => ({ name, count }))
            .sort((a, b) => a.count - b.count);

        res.json({ songs: sortedSongs, artists: sortedArtists });

    } catch (err) {
        console.error('Error fetching stats from Google Sheet:', err);
        res.status(500).json({ error: 'Failed to fetch stats.' });
    }
});

// --- Webhook Endpoint ของ LINE ---
// รับ events จากแพลตฟอร์ม LINE
app.post('/webhook', line.middleware(lineConfig), (req, res) => {
    Promise
        .all(req.body.events.map(handleEvent)) // ประมวลผล events ทั้งหมดพร้อมกัน
        .then((result) => res.json(result))
        .catch((err) => {
            console.error('Webhook Error:', err);
            res.status(500).end();
        });
});

// --- การจัดการ Event ---
/**
 * จัดการ event ที่เข้ามาจาก LINE webhook
 * @param {Object} event - object ของ event ที่ LINE ส่งมา
 */
async function handleEvent(event) {
    const userId = event.source.userId;

    // จัดการ postback event ซึ่งเกิดจากการกดปุ่มใน template message
    if (event.type === 'postback') {
        try {
            const postbackData = JSON.parse(event.postback.data);
            const { confirmationId, ...songData } = postbackData;

            // ตรวจสอบ confirmation ID เพื่อให้แน่ใจว่าไม่ใช่คำขอที่หมดอายุแล้ว
            if (!activeConfirmations[userId] || activeConfirmations[userId] !== confirmationId) {
                const replyText = 'This confirmation has expired or is invalid. Please search for the song again.';
                return lineClient.replyMessage(event.replyToken, { type: 'text', text: replyText });
            }

            // การยืนยันถูกต้อง, ทำให้ token ใช้งานไม่ได้อีกเพื่อป้องกันการใช้ซ้ำ
            delete activeConfirmations[userId];

            // สร้าง object เพลงใหม่และเพิ่มเข้าไปในคิว
            const newSong = {
                id: uuidv4(),
                name: songData.name,
                artist: songData.artist,
                albumArt: songData.albumArt,
            };

            songQueue.push(newSong);
            console.log(`Added to queue via confirmation: ${newSong.name} by ${newSong.artist}`);
            // แจ้งเตือน web client ว่าคิวมีการอัปเดต
            io.emit('update_queue', songQueue);

            const replyText = `"${newSong.name}" by ${newSong.artist} has been added to the queue!`;
            return lineClient.replyMessage(event.replyToken, { type: 'text', text: replyText });

        } catch (err) {
            console.error('Postback handling error:', err);
            return Promise.resolve(null);
        }
    }

    // ไม่สนใจ event ที่ไม่ใช่ข้อความ
    if (event.type !== 'message' || event.message.type !== 'text') {
        return Promise.resolve(null);
    }

    const query = event.message.text.trim();
    if (!query) {
        return Promise.resolve(null);
    }
    
    // จัดการกับการตอบ "No" จากข้อความยืนยัน
    if (query.toLowerCase() === 'no, search again' || query.toLowerCase() === 'no') {
        // ทำให้การยืนยันที่ค้างอยู่ของผู้ใช้นี้ใช้การไม่ได้
        delete activeConfirmations[userId]; 
        const replyText = 'Got it. Please enter a new song name to search for.';
        return lineClient.replyMessage(event.replyToken, { type: 'text', text: replyText });
    }

    try {
        // ค้นหาเพลงใน Spotify
        const searchResult = await spotifyApi.searchTracks(query, { limit: 5 });

        if (searchResult.body.tracks.items.length === 0) {
            const replyText = `Sorry, I couldn't find the song "${query}". Please try again.`;
            return lineClient.replyMessage(event.replyToken, { type: 'text', text: replyText });
        }

        // ใช้ string similarity เพื่อหาผลลัพธ์ที่ตรงกันที่สุดจากผลการค้นหา
        const SIMILARITY_THRESHOLD = 0.3;
        const trackNames = searchResult.body.tracks.items.map(item => item.name);
        const bestMatch = stringSimilarity.findBestMatch(query, trackNames);

        // หากผลลัพธ์ไม่ค่อยตรง, ถามผู้ใช้เพื่อความชัดเจนโดยการเสนอตัวเลือกอื่น
        if (bestMatch.bestMatch.rating < SIMILARITY_THRESHOLD) {
            const suggestions = searchResult.body.tracks.items
                .slice(0, 3)
                .map((item, index) => `${index + 1}. ${item.name} - ${item.artists.map(a => a.name).join(', ')}`)
                .join('\n');
                
            const replyText = `ไม่พบเพลงที่ตรงกับ "${query}"\n\nผลการค้นหาที่ใกล้เคียง:\n${suggestions}\n\nกรุณาลองพิมพ์ชื่อเพลงที่ถูกต้องอีกครั้งครับ`;
            return lineClient.replyMessage(event.replyToken, { type: 'text', text: replyText });
        }

        // หากมีผลลัพธ์ที่ค่อนข้างมั่นใจ, ดำเนินการขอการยืนยัน
        let track = searchResult.body.tracks.items.find(item => item.name === bestMatch.bestMatch.target);
        if (!track) {
            track = searchResult.body.tracks.items[0]; // หากไม่พบให้ใช้ผลลัพธ์แรกสุดแทน
        }

        const songData = {
            name: track.name,
            artist: track.artists.map(a => a.name).join(', '),
            albumArt: track.album.images[0]?.url || 'https://via.placeholder.com/150',
        };

        // สร้าง ID ที่ไม่ซ้ำกันสำหรับคำขอยืนยันนี้และจัดเก็บไว้
        const confirmationId = uuidv4();
        activeConfirmations[userId] = confirmationId;

        const postbackPayload = { ...songData, confirmationId };

        // สร้าง message ที่เป็น template แบบปุ่มเพื่อขอการยืนยันจากผู้ใช้
        const confirmationMessage = {
            type: 'template',
            altText: `Is this the correct song? ${songData.name}`,
            template: {
                type: 'buttons',
                thumbnailImageUrl: songData.albumArt,
                imageAspectRatio: 'square',
                imageSize: 'cover',
                title: songData.name,
                text: `Artist: ${songData.artist}`,
                actions: [
                    {
                        type: 'postback', // ส่ง postback event เมื่อถูกกด
                        label: 'Yes, add to queue',
                        data: JSON.stringify(postbackPayload), // ข้อมูลที่จะส่งกลับไป
                        displayText: `Adding "${songData.name}"...`
                    },
                    {
                        type: 'message', // ส่งข้อความเมื่อถูกกด
                        label: 'No, search again',
                        text: 'No, search again'
                    }
                ]
            }
        };

        return lineClient.replyMessage(event.replyToken, confirmationMessage);

    } catch (err) {
        console.error('Spotify API or LINE reply error:', err);
        const replyText = 'An error occurred while searching for the song.';
        return lineClient.replyMessage(event.replyToken, { type: 'text', text: replyText });
    }
}

// --- การจัดการการเชื่อมต่อ Socket.IO ---
io.on('connection', (socket) => {
    console.log('A user connected to the display.');
    // ส่งคิวเพลงปัจจุบันไปยัง client ที่เพิ่งเชื่อมต่อเข้ามาใหม่
    socket.emit('update_queue', songQueue);

    // จัดการคำขอจาก client เพื่อลบเพลง
    socket.on('delete_song', (songId) => {
        songQueue = songQueue.filter(song => song.id !== songId);
        console.log(`Removed song with ID: ${songId}`);
        // แจ้งเตือน client ทั้งหมดเกี่ยวกับการเปลี่ยนแปลง
        io.emit('update_queue', songQueue);
    });

    // จัดการคำขอจาก client เพื่อทำเครื่องหมายว่าเพลงถูกเล่นแล้ว
    socket.on('song_played', async (songId) => {
        const playedSong = songQueue.find(song => song.id === songId);

        if (playedSong && sheet) {
            try {
                // เพิ่มแถวใหม่ใน Google Sheet เพื่อบันทึกเพลงที่เล่นแล้ว
                await sheet.addRow({
                    Timestamp: new Date().toLocaleString('en-US', { timeZone: 'Asia/Bangkok' }),
                    'Song Name': playedSong.name,
                    Artist: playedSong.artist,
                });
                console.log(`Logged played song to Google Sheet: ${playedSong.name}`);

                // ลบเพลงออกจากคิวและแจ้งเตือน client
                songQueue = songQueue.filter(song => song.id !== songId);
                io.emit('update_queue', songQueue);

            } catch (err) {
                console.error('Error adding played song row to Google Sheet:', err);
            }
        } else if (!playedSong) {
            console.log(`Could not find song with ID ${songId} to mark as played.`);
        }
    });

    socket.on('disconnect', () => {
        console.log('A user disconnected.');
    });
});

// --- การเริ่มเซิร์ฟเวอร์ ---
server.listen(PORT, () => {
    console.log(`Server is listening on port ${PORT}`);
    console.log('Open http://localhost:3000 in your browser to see the song queue display.');
    
    // เริ่มต้นการเชื่อมต่อกับบริการภายนอกเมื่อเริ่มระบบ
    getSpotifyToken();
    initSheet();
});
