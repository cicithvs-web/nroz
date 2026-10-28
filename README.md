# 🤖 Nroz AI Agent Telegram Bot

Bot Telegram AI Agent canggih dengan arsitektur **Tool-Calling**, **Persistent Docker Sandbox per user**, **Remotion React Video Creator dengan AI Voiceover**, **Voice Transcriber (Whisper)**, **Data Analyst & Auto Chart**, **Instant Web Preview (Cloudflare Tunnel)**, **Scheduler & Server Watchdog**, serta **Media Downloader**.

---

## 🌟 Fitur Utama

1. **🐳 Persistent Docker Sandbox (Model B)**:
   - Setiap pengguna/sesi memiliki container Docker Ubuntu 24.04 terisolasi (`nroz-sandbox-<sessionId>`).
   - Eksekusi perintah Linux (`run_command`) dan kode (`run_code`: Node.js, Python, Bash) bebas dan aman tanpa membahayakan host VPS.
   - Folder workspace otomatis ter-mount ke `/workspace` di dalam container.
   - Path host (`/root/nroz/workspace/<chatId>/...`) dan path sandbox (`/workspace/...`) diterjemahkan otomatis,
     jadi file yang ditulis `file_write` selalu terlihat oleh `run_command`.
   - `run_command` dengan `"background": true` menjalankan perintah lama tanpa memblokir bot; hasilnya dibaca lewat
     `check_command_output` (timeout biasa 120 detik, instalasi paket 300 detik).
   - Auto-clean file workspace berusia > 3 hari.

2. **🎥 Remotion React Video Creator + AI Voiceover**:
   - Pembuatan video MP4 secara terprogram langsung dari kode React/TypeScript menggunakan **Remotion**.
   - Render berjalan di **antrean latar belakang** (satu job aktif, sisanya antre). Bot langsung menjawab
     `⏳ Render video #N dimulai` + estimasi waktu, lalu video **dikirim otomatis** ke chat saat selesai —
     jadi permintaan video panjang tidak memblokir percakapan.
   - Durasi maksimal 15 menit (900 detik), dapat diubah lewat `REMOTION_MAX_RENDER_SECONDS`.
   - Integrasi **Microsoft Edge Neural TTS** (`id-ID-ArdiNeural`, `id-ID-GadisNeural`, `en-US-ChristopherNeural`, `en-US-JennyNeural`) untuk narasi suara manusia alami berkualitas studio.
   - Naskah panjang dikirim dalam satu panggilan: `tts_text` (satu suara) atau `tts_lines` (banyak suara/dialog) —
     klip dibuat lalu digabung ffmpeg otomatis, durasi video mengikuti panjang voiceover.
   - Bahan audio dari workspace dipakai langsung: `audio_path` menerima path sandbox (`/workspace/lagu.mp3`)
     dan ditolak dengan pesan jelas kalau file tidak ada, sementara aset `staticFile("...")` di kode React disalin
     otomatis dari folder sesi ke `remotion-engine/public` sebelum render (tidak ada lagi 404 di tengah render).
   - Estimasi waktu memakai `REMOTION_FRAME_SECONDS` (bawaan 0,35 s/frame) — konservatif karena satu render aktif
     di 2 vCPU terukur 0,13-0,56 s/frame tergantung beban server.
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

#### Dependensi Sistem (WAJIB saat pindah ke server baru)

Perangkat baru sering hanya punya Node + Docker, sementara fitur video/TTS butuh library sistem.
Ini yang membuat render gagal dengan `error while running chrome-headless-shell: libnss3.so: cannot open shared object file`:

```bash
apt-get update

# Library yang dibutuhkan Chrome headless milik Remotion (Debian 13 / trixie)
apt-get install -y \
  libnss3 libnspr4 libasound2t64 libatk1.0-0t64 \
  libatk-bridge2.0-0t64 libatspi2.0-0t64 libxkbcommon0

# ffmpeg + ffprobe (durasi audio/video) dan yt-dlp (media downloader)
apt-get install -y ffmpeg yt-dlp

# Preparasi venv Python; /opt/voice-env dibuat otomatis oleh ttsManager.js
apt-get install -y python3-venv python3-pip
```

Di Ubuntu 22.04/24.04 pakai nama paket tanpa sufiks `t64`: `libasound2 libatk1.0-0 libatk-bridge2.0-0 libatspi2.0-0`.

`/opt/voice-env/bin/edge-tts` tidak perlu dibuat manual — saat TTS pertama dipakai, `ttsManager.js`
membuat venv-nya dan memasang `edge-tts` otomatis. Kalau otomatisnya gagal, pesannya menampilkan
perintah install manual yang bisa langsung ditempel.

Verifikasi cepat setelah setup:

```bash
ffprobe -version | head -1 && yt-dlp --version
node -e "require('./ttsManager').generateSpeech('Tes suara',{outputPath:'/tmp/tts.mp3'}).then(r=>console.log('TTS OK',r.filePath))"
```

#### Swap untuk VPS kecil (render video panjang)

Render video berdurasi beberapa menit (batas maksimum 15 menit, `REMOTION_MAX_RENDER_SECONDS`)
butuh RAM di atas 2 GB dan berjalan di antrean latar belakang. VPS 2 GB rawan kena OOM saat Chrome
headless merender ribuan frame, jadi tambahkan swap file:

```bash
if [ ! -f /swapfile ]; then
  dd if=/dev/zero of=/swapfile bs=1M count=4096 status=progress
  chmod 600 /swapfile
  mkswap /swapfile
fi
grep -q '^/swapfile' /etc/fstab || echo '/swapfile none swap sw,pri=1 0 0' >> /etc/fstab
swapon -a
free -h   # kolom Swap harus tidak lagi 0B
```

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
