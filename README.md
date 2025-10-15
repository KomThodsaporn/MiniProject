# Node.js Express Web Application (เวอร์ชั่นภาษาไทย)

โปรเจคนี้คือเว็บแอปพลิเคชันที่สร้างด้วย Node.js และ Express framework ซึ่งเป็นเซิร์ฟเวอร์ที่รองรับการทำงานหลากหลาย เช่น การเชื่อมต่อกับ LINE, Spotify, Google, และ Firebase รวมถึงมีฟีเจอร์การสื่อสารแบบเรียลไทม์โดยใช้ Socket.IO

## สารบัญ

* [เกี่ยวกับโปรเจค](#เกี่ยวกับโปรเจค)
* [เทคโนโลยีที่ใช้](#เทคโนโลยีที่ใช้)
* [ขั้นตอนการติดตั้ง](#ขั้นตอนการติดตั้ง)
  * [สิ่งที่ต้องมี](#สิ่งที่ต้องมี)
  * [การติดตั้ง](#การติดตั้ง)
  * [การตั้งค่า Environment Variables (.env)](#การตั้งค่า-environment-variables-env)
* [การใช้งาน](#การใช้งาน)
* [โครงสร้างโปรเจค](#โครงสร้างโปรเจค)

## เกี่ยวกับโปรเจค

โปรเจคนี้เป็นเซิร์ฟเวอร์ Node.js ที่ใช้ Express framework ในการจัดการ request ต่างๆ จากข้อมูล dependencies สามารถสรุปความสามารถหลักๆ ได้ดังนี้:

*   **เชื่อมต่อ LINE Bot:** ใช้ `@line/bot-sdk` เพื่อสร้างและจัดการ Chatbot บนแพลตฟอร์ม LINE
*   **เชื่อมต่อ Spotify API:** ใช้ `spotify-web-api-node` ในการทำงานร่วมกับ Spotify API
*   **เชื่อมต่อ Google APIs:** ใช้ `googleapis` เพื่อเชื่อมต่อกับบริการต่างๆ ของ Google
*   **เชื่อมต่อ Firebase:** ใช้ `firebase-admin` สำหรับการทำงานร่วมกับ Firebase จากฝั่งเซิร์ฟเวอร์
*   **การสื่อสารแบบ Real-time:** ใช้ `socket.io` สำหรับฟีเจอร์ที่ต้องการการตอบสนองแบบทันที
*   **การเชื่อมต่อฐานข้อมูล:** ใช้ `mongoose` สำหรับ MongoDB และ `sqlite3` สำหรับ SQLite
*   **การแสดงผลหน้าเว็บ:** ใช้ `ejs` เป็น Template Engine สำหรับสร้างหน้าเว็บแบบไดนามิก

## เทคโนโลยีที่ใช้

*   [Node.js](https://nodejs.org/)
*   [Express](https://expressjs.com/)
*   [EJS](https://ejs.co/)
*   [Socket.IO](https://socket.io/)
*   [LINE Messaging API](https://developers.line.biz/en/docs/messaging-api/overview/)
*   [Spotify Web API](https://developer.spotify.com/documentation/web-api/)
*   [Google APIs](https://developers.google.com/apis-explorer)
*   [Firebase](https://firebase.google.com/)
*   [Mongoose](https://mongoosejs.com/)
*   [SQLite3](https://www.sqlite.org/index.html)

## ขั้นตอนการติดตั้ง

ทำตามขั้นตอนต่อไปนี้เพื่อติดตั้งโปรเจคบนเครื่องของคุณ

### สิ่งที่ต้องมี

ตรวจสอบให้แน่ใจว่าคุณได้ติดตั้ง Node.js และ npm บนเครื่องของคุณแล้ว
*   npm
    ```sh
    npm install npm@latest -g
    ```

### การติดตั้ง

1.  Clone a repository
    ```sh
    git clone https://github.com/your_username/your_project_name.git
    ```
2.  ติดตั้ง Dependencies
    ```sh
    npm install
    ```

### การตั้งค่า Environment Variables (.env)

หลังจากติดตั้งแล้ว คุณต้องสร้างไฟล์ `.env` ที่ root ของโปรเจคเพื่อเก็บค่าข้อมูลสำคัญต่างๆ เช่น API Keys, Tokens.

1.  **สร้างไฟล์ `.env`** ที่เดียวกับไฟล์ `package.json`
2.  **เพิ่มค่าตัวแปรต่างๆ** ตามตัวอย่างด้านล่าง:

    ```
    # LINE Bot Settings
    LINE_CHANNEL_ACCESS_TOKEN=
    LINE_CHANNEL_SECRET=

    # Spotify API Settings
    SPOTIFY_CLIENT_ID=
    SPOTIFY_CLIENT_SECRET=

    # Google API Settings
    GOOGLE_API_KEY=

    # Firebase Settings
    FIREBASE_SERVICE_ACCOUNT_KEY_PATH=
    ```

#### วิธีการหาค่าต่างๆ

*   **LINE (`LINE_CHANNEL_ACCESS_TOKEN` & `LINE_CHANNEL_SECRET`)**
    1.  ไปที่ [LINE Developers Console](https://developers.line.biz/en/) และเข้าสู่ระบบ
    2.  สร้าง Provider (ถ้ายังไม่มี)
    3.  สร้าง Channel ใหม่ และเลือกประเภทเป็น **"Messaging API"**
    4.  ในแท็บ **"Channel basic settings"** คุณจะเจอ `Channel secret`
    5.  ในแท็บ **"Messaging API"** เลื่อนลงมาด้านล่างสุดแล้วกดปุ่ม **"Issue"** เพื่อสร้าง `Channel access token`
    6.  **สำคัญ:** ตั้งค่า **Webhook URL** ในแท็บ "Messaging API" ให้ชี้มาที่เซิร์ฟเวอร์ของคุณตามด้วย `/webhook` (เช่น `https://your-domain.com/webhook`) หากทดสอบบนเครื่อง local คุณอาจต้องใช้เครื่องมืออย่าง [ngrok](https://ngrok.com/) เพื่อสร้าง URL ชั่วคราว

*   **Spotify (`SPOTIFY_CLIENT_ID` & `SPOTIFY_CLIENT_SECRET`)**
    1.  ไปที่ [Spotify Developer Dashboard](https://developer.spotify.com/dashboard/)
    2.  สร้าง App ใหม่
    3.  คุณจะเจอ `Client ID` และ `Client Secret` ในหน้า dashboard ของ App

*   **Google (`GOOGLE_API_KEY`)**
    1.  ไปที่ [Google Cloud Console](https://console.cloud.google.com/)
    2.  สร้างโปรเจคใหม่
    3.  ไปที่ **APIs & Services > Credentials**
    4.  สร้าง Credentials ใหม่ประเภท **"API key"**

*   **Firebase (`FIREBASE_SERVICE_ACCOUNT_KEY_PATH`)**
    1.  ไปที่ [Firebase Console](https://console.firebase.google.com/) และเลือกโปรเจคของคุณ
    2.  ไปที่ **Project settings > Service accounts**
    3.  คลิก **"Generate new private key"** เพื่อดาวน์โหลดไฟล์ JSON ที่มีข้อมูล service account
    4.  นำไฟล์ JSON ที่ได้ไปไว้ในโปรเจคของคุณ และกำหนด path ของไฟล์นั้นใน `.env` (เช่น `path/to/your/serviceAccountKey.json`)

## การใช้งาน

คุณสามารถรันเซิร์ฟเวอร์ได้ 2 โหมด:

*   **โหมด Development:** ใช้ `nodemon` เพื่อรีสตาร์ทเซิร์ฟเวอร์อัตโนมัติเมื่อมีการแก้ไขโค้ด
    ```sh
    npm run dev
    ```
*   **โหมด Production:** รันเซิร์ฟเวอร์ปกติ
    ```sh
    npm start
    ```

## โครงสร้างโปรเจค

```
.
├── public/             # ไฟล์สำหรับหน้าเว็บ (CSS, JS, รูปภาพ)
├── views/              # ไฟล์เทมเพลต EJS
├── .env                # ไฟล์เก็บ Environment Variables (ต้องสร้างเอง)
├── index.js            # ไฟล์หลักของแอปพลิเคชัน
├── package.json        # ข้อมูลโปรเจคและ Dependencies
└── README.md
```
