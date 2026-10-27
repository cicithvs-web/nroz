# 🤖 Nroz AI Agent Telegram Bot

Bot Telegram AI Agent canggih dengan arsitektur **Tool-Calling**, **Persistent Docker Sandbox per user**, **Remotion React Video Creator dengan AI Voiceover**, **Voice Transcriber (Whisper)**, **Data Analyst & Auto Chart**, **Instant Web Preview (Cloudflare Tunnel)**, **Scheduler & Server Watchdog**, serta **Media Downloader**.

---

## 🌟 Fitur Utama

1. **🐳 Persistent Docker Sandbox (Model B)**:
   - Setiap pengguna/sesi memiliki container Docker Ubuntu 24.04 terisolasi (`nroz-sandbox-<sessionId>`).
   - Eksekusi perintah Linux (`run_command`) dan kode (`run_code`: Node.js, Python, Bash) bebas dan aman tanpa membahayakan host VPS.
   - Folder workspace otomatis ter-mount ke `/workspace` di dalam container.
   - Auto-clean file workspace berusia > 3 hari.

2. **🎥 Remotion React Video Creator + AI Voiceover**:
   - Pembuatan video MP4 secara terprogram langsung dari kode React/TypeScript menggunakan **Remotion**.
   - Integrasi **Microsoft Edge Neural TTS** (`id-ID-ArdiNeural`, `id-ID-GadisNeural`, `en-US-ChristopherNeural`, `en-US-JennyNeural`) untuk narasi suara manusia alami berkualitas studio.
   - Otomatis dikirim ke Telegram sebagai video native (`bot.sendVideo`) dengan fitur streaming playback.

3. **🎙️ Voice Note Transcriber (Whisper Local)**:
   - Menerima rekaman suara Telegram (`.oga`/audio) dan mentranskripsikannya ke teks menggunakan **Faster-Whisper** di VPS.
   - Hasil ucapan otomatis direspons atau dieksekusi oleh AI Agent.

4. **📊 Data Analyst & Auto Chart**:
   - Analisis data menggunakan Python (`pandas`, `matplotlib`, `seaborn`) di dalam sandbox.
   - Grafik otomatis dikirim sebagai foto Telegram beresolusi tinggi via tag `<<<SENDPHOTO:chart.png>>>`.

5. **🌐 Instant Web Preview (Cloudflare Tunnel)**:
   - Membuka URL publik HTTPS instan (`https://*.trycloudflare.com`) via `cloudflared` untuk aplikasi web yang berjalan di port lokal (misal port 3000/8080).

6. **⏰ Scheduled Reminders & Website Watchdog**:
   - Menjadwalkan pengingat waktu (Reminder) dan pemantau uptime server/website (Watchdog) dengan notifikasi Telegram otomatis.
   - Data tersimpan persisten di `scheduler_data.json`.
   - Perintah Telegram: `/tasks` dan `/canceltask <id>`.

7. **🎬 Media Downloader & Converter**:
   - Unduh video/audio dari YouTube, TikTok, Instagram, Twitter/X, SoundCloud menggunakan `yt-dlp` dan `ffmpeg`.

---

## 📁 Struktur Proyek

```
/root/nroz/
├── bot.js                  # Engine utama Telegram Bot & Agent Loop
├── agentTools.js           # Definisi tool-calling (OpenAI format) & executor
├── sandboxManager.js       # Manajemen container Docker sandbox per user
├── Dockerfile.sandbox      # Definisi image sandbox (Ubuntu 24.04 + tools)
├── remotionManager.js      # Pengelola render video Remotion
├── remotion-engine/        # Proyek Remotion (React, bundler, Chrome Headless Shell)
├── ttsManager.js           # Text-to-Speech (Edge Neural Voices)
├── voiceManager.js         # Transkripsi suara Whisper wrapper
├── voiceTranscriber.py     # Script Python Faster-Whisper
├── schedulerManager.js     # Penjadwal pengingat & watchdog web
├── webPreviewManager.js    # Pengelola Cloudflare Tunnel
├── onlyxHelper.js          # Helper database memori percakapan Onlyx DB
├── .env.example            # Template variabel lingkungan
└── package.json            # Dependensi Node.js
```

---

## 🚀 Panduan Instalasi & Menjalankan

### 1. Prasyarat
- **Node.js**: >= 18 atau 20+
- **Docker**: Berjalan di host (`docker ps`)
- **FFmpeg**: Terpasang di host (`ffmpeg -version`)
- **Python 3**: Untuk Whisper (`faster-whisper`) dan Edge TTS (`edge-tts`)

### 2. Konfigurasi Variabel Lingkungan
Salin file `.env.example` ke `.env` dan isi token/API key kamu:
```bash
cp .env.example .env
nano .env
```

### 3. Instalasi Dependensi
```bash
# Dependensi utama bot
npm install

# Dependensi Remotion engine
cd remotion-engine && npm install && npx remotion browser ensure && cd ..
```

### 4. Menjalankan Bot
```bash
# Menjalankan langsung
node bot.js

# Atau menjalankan dengan PM2 (Background Daemon)
pm2 start bot.js --name "nroz-ai-bot"
pm2 save
```

---

## 📋 Perintah Bot di Telegram

- `/start` : Menampilkan menu utama dan fitur bot
- `/newtopic` : Memulai topik / sesi baru (membersihkan konteks percakapan)
- `/workspace` : Memeriksa daftar file di workspace server pengguna
- `/sandbox` : Memeriksa status container Docker sandbox pribadi
- `/resetsandbox` : Mereset container sandbox jika terjadi kendala sistem
- `/tasks` : Melihat jadwal pengingat dan pemantau web yang sedang aktif
- `/canceltask <id>` : Membatalkan tugas pengingat / pemantau web
- `/clean` : Membersihkan file di folder workspace pengguna
- `/summary` : Melihat ringkasan memori percakapan jangka panjang
- `/pause` & `/resume` : Menjeda atau mengaktifkan kembali respons bot
