const mongoose = require('mongoose');

// กำหนดโครงสร้างของข้อมูลเพลง
const songSchema = new mongoose.Schema({
    name: {
        type: String,
        required: true,
        trim: true
    },
    artist: {
        type: String,
        required: true,
        trim: true
    },
    albumArt: {
        type: String,
    },
    requestedBy: {
        type: String,
        required: true,
    },
    timestamp: {
        type: Date,
        default: Date.now
    }
});

// สร้าง Model จาก Schema เพื่อใช้ในการจัดการข้อมูล
const Song = mongoose.model('Song', songSchema);

module.exports = Song;
