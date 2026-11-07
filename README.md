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
   - Estimasi waktu memakai `REMOTION_FRAME_SECONDS` (bawaan 0,35 s/frame); komposisi berat dengan voiceover
     terukur sampai ±1,3 s/frame di 2 vCPU, jadi batas waktu render = 6x estimasi (minimum 15 menit, maksimum 4 jam,
     override `REMOTION_RENDER_TIMEOUT_MS`). Kalau proses dihentikan setelah videonya ternyata sudah utuh
     (diperiksa dengan ffprobe), hasilnya tetap dikirim, tidak dianggap gagal.
   - Progres render nyata dibaca dari output CLI Remotion (persen, frame, sisa waktu) dan ditampilkan di chat;
     saat voiceover memanjangkan durasi, jumlah frame dan estimasi ikut dikoreksi.
   - Hasil ≤ 48 MB dikirim sebagai video native (`bot.sendVideo`) dengan streaming playback; yang lebih besar
     otomatis dikirim sebagai **link unduhan HTTPS** lewat Cloudflare Quick Tunnel (`videoShareManager.js`), karena
     Bot API menolak upload di atas 50 MB dan memaksanya lewat kompres akan membuat video panjang jadi burik.
     Link dipakai ulang per tunnel, mendukung HTTP Range (bisa di-seek di browser), dan kedaluwarsa setelah
     `VIDEO_SHARE_TTL_HOURS` (bawaan 72 jam). Ambang kirim diatur lewat `TELEGRAM_SEND_MAX_MB`, port lokal lewat
     `VIDEO_SHARE_PORT`. Catatan: quick tunnel mendapat hostname acak, jadi link lama mati saat bot direstart.
   - Butuh binary `cloudflared` di host (`/usr/local/bin/cloudflared`) — dipakai juga oleh fitur Web Preview.

3. **🎙️ Voice Note Transcriber (Whisper Local)**:
   - Menerima rekaman suara Telegram (`.oga`/audio) dan mentranskripsikannya ke teks menggunakan **Faster-Whisper** di VPS.
   - Hasil ucapan otomatis direspons atau dieksekusi oleh AI Agent.

4. **📊 Data Analyst & Auto Chart**:
   - Analisis data menggunakan Python (`pandas`, `matplotlib`, `seaborn`) di dalam sandbox.
   - Grafik otomatis dikirim sebagai foto Telegram beresolusi tinggi via tag `<<<SENDPHOTO:chart.png>>>`.

5. **🌐 Instant Web Preview (Cloudflare Tunnel)**:
   - Membuka URL publik HTTPS instan (`https://*.trycloudflare.com`) via `cloudflared` untuk aplikasi web yang berjalan di port lokal (misal port 3000/8080).

6. **⏰ Scheduled Reminders & Website Watchdog**:
   - Pengingat sekali jalan atau berulang (harian, hari kerja, mingguan, bulanan), dengan waktu relatif
     ("15 menit lagi") atau jam absolut ("besok 08:00", default WIB).
   - Pemantau uptime server/website (Watchdog) dengan notifikasi Telegram otomatis.
   - Data tersimpan di `scheduler_data.json` (ditulis atomik); pengingat baru dihapus setelah benar-benar terkirim.
   - Perintah Telegram: `/tasks` (dengan tombol batal per tugas) dan `/canceltask <id>`.

7. **🎬 Media Downloader & Converter**:
   - Unduh video/audio dari YouTube, TikTok, Instagram, Twitter/X, SoundCloud menggunakan `yt-dlp` dan `ffmpeg`.

8. **🤖 Tugas Agent Terjadwal (`schedule_agent_task`)**:
   - Beda dari pengingat biasa: saat waktunya tiba, AI Agent dibangunkan otomatis dengan instruksi tugasnya
     dan bekerja mandiri memakai semua tools, lalu melaporkan hasilnya ke chat. Sekali jalan atau berulang
     (harian/hari kerja/mingguan/bulanan), tampil di `/tasks` dengan tombol batal.
   - Contoh: "tiap pagi jam 7 cek harga emas, bandingkan dengan catatan kemarin, lapor kalau berubah >2%".

9. **🔗 Webhook Masuk (`/addhook`, `/hooks`, `/webhookurl`)**:
   - Terima event dari layanan eksternal (GitHub, Stripe, n8n, IFTTT, form, dsb): `POST /h/<token>` dengan
     body JSON/teks (maks 64 KB). Server hook hanya menempel di `127.0.0.1`; URL publik dibuka lewat
     Cloudflare Quick Tunnel lewat perintah owner `/webhookurl`.
   - Mode `notify`: payload diteruskan ke chat. Mode `agent`: payload membangunkan AI Agent untuk
     ditindaklanjuti otomatis. Token hook acak 32-hex; data hook tersimpan di `webhook_data.json`.

10. **🧠 Memori Semantik / RAG (`search_knowledge`, pgvector)**:
    - Dokumen yang di-upload user (PDF, DOCX, teks, kode) dan percakapan penting dipecah jadi chunk,
      di-embed, dan disimpan di PostgreSQL + pgvector. Tool `search_knowledge` mencari berdasarkan makna,
      bukan cocok kata kunci.
    - Butuh image `pgvector/pgvector:pg16` (sudah diatur di `docker-compose.yml`). Model/dimensi embedding
      diatur lewat `EMBED_MODEL` / `EMBED_DIM` di `.env`; matikan indeks percakapan otomatis dengan
      `KNOWLEDGE_INGEST_CHAT=off`.

11. **❓ Agent Bisa Bertanya (`ask_user`)**:
    - Saat requirement ambigu atau sebelum tindakan berisiko, agent mengirim pertanyaan dengan tombol
      pilihan dan MENUNGGU jawaban (default 10 menit, maks 60) sebelum melanjutkan. Jawaban bisa lewat
      tombol atau ketik langsung; kalau tidak dijawab sampai timeout, agent lanjut dengan asumsi terbaik.

12. **🎬 Analisis Video Referensi (`analyze_video_reference`)**:
    - Kirim video referensi (≤ 20 MB, batas Telegram) atau link (diunduh via `media_download`) + caption
      "bikin kayak gini" — bot mengekstrak metadata (`ffprobe`), ritme scene cut (`ffmpeg`), dan contact
      sheet frame, lalu vision model menyusun spec gaya: palet, layout, tipografi, motion, tempo.
    - Agent menulis kode Remotion mengikuti spec tersebut; hasil analisis bisa disimpan sebagai preset
      gaya via `save_skill` agar bisa dipakai ulang tanpa kirim referensi lagi.

13. **🖥️ Terminal Streaming (`bot/terminalStream.js`)**:
    - Setiap `run_command {background: true}` kini ditampilkan live: di chat pribadi memakai draft
      streaming native Telegram (`sendMessageDraft`, Bot API 9.3+ — bubble live nempel di bawah chat,
      otomatis bersih saat pesan final terkirim) dengan tombol stop generation native (`can_stop`,
      Bot API 10.3); di grup memakai satu pesan yang diedit berkala + tombol ⏹ Stop dan 📄 Log lengkap.
    - Watcher berbasis offset membaca `.bg/<jobId>.log` lewat bind mount (tanpa perubahan di sandbox),
      strip ANSI, dan menghormati rate limit draft Telegram (20 panggilan/5 dtk, 40/30 dtk per peer).
    - Tool baru `wait_command_output`: agent menunggu job selesai dalam SATU panggilan — menggantikan
      poling `check_command_output` berulang yang memakan ronde tool dan token. Matikan stream via
      `TERMINAL_STREAM=off`, tombol stop native via `TERMINAL_STREAM_STOP=off`.

---

## 📁 Struktur Proyek

```
/root/nroz/
├── bot.js                  # Titik masuk: membuat bot, memasang handler, menu perintah
├── bot/                    # Isi bot Telegram
│   ├── agentLoop.js        #   Loop tool-calling AI + checkpoint giliran terpotong ("lanjutkan")
│   ├── turnQueue.js        #   Antrean: satu giliran AI per chat/topic, sisanya menunggu
│   ├── queuedTurn.js       #   Pembungkus handler agar lewat antrean (+ notifikasi "masuk antrean")
│   ├── commands.js         #   Perintah slash + daftar menu (setMyCommands)
│   ├── callbacks.js        #   Tombol inline: approval user, batalkan tugas
│   ├── handlers.js         #   Pesan teks, foto, dokumen, suara
│   ├── send.js, text.js    #   Kirim pesan (fallback Markdown, pemecahan pesan panjang)
│   ├── fileDelivery.js     #   Kiriman file/ZIP dari jawaban AI (hanya dari workspace)
│   ├── renderDelivery.js   #   Progres & hasil render video
│   └── workspace.js        #   Folder workspace & auto-cleanup
├── agentTools.js           # Pintu masuk tool-calling (executeTool)
├── tools/                  # Implementasi tiap tool (shell, web, files, media, scheduling, ...)
├── lib/                    # pathGuard (kunci akses file ke workspace), netGuard (anti-SSRF), atomicFile
├── test/                   # Unit test (node:test) — jalankan `npm test`
├── sandboxManager.js       # Manajemen container Docker sandbox per user
├── Dockerfile.sandbox      # Definisi image sandbox (Ubuntu 24.04 + tools)
├── remotionManager.js      # Pengelola render video Remotion (antrean tersimpan di render_queue.json)
├── remotion-engine/        # Proyek Remotion (React, bundler, Chrome Headless Shell)
├── ttsManager.js           # Text-to-Speech (Edge Neural Voices)
├── voiceManager.js         # Transkripsi suara Whisper wrapper
├── voiceTranscriber.py     # Script Python Faster-Whisper
├── schedulerManager.js     # Pengingat, watchdog web, & tugas agent terjadwal
├── webhookManager.js       # Webhook masuk: event eksternal -> notif chat / agent
├── bot/agentTrigger.js     # Membangunkan agent loop (tugas terjadwal & webhook)
├── bot/knowledge.js        # Memori semantik RAG (pgvector + embedding)
├── webPreviewManager.js    # Pengelola Cloudflare Tunnel
├── dbHelper.js             # Helper database memori percakapan PostgreSQL
├── schema.sql              # Skema tabel (dijalankan otomatis oleh dbHelper)
├── docker-compose.yml      # PostgreSQL lokal (container nroz-postgres, port hanya localhost)
├── videoShareManager.js    # Link unduhan untuk hasil render di atas batas upload bot
├── scripts/setup-vps.sh    # Setup sekali jalan untuk server baru (+ mode --check)
├── scripts/check-db.js     # Probe koneksi DATABASE_URL (dipakai setup-vps.sh)
├── .env.example            # Template variabel lingkungan
└── package.json            # Dependensi Node.js
```

### Batas keamanan tool yang berjalan di host

- `file_read/write/edit/list`, `send_file`, `send_photo`, dan tag `<<<SENDFILE:...>>>` hanya bisa menyentuh
  workspace sesi (`/workspace/...`). Path lain dan symlink yang keluar dari workspace ditolak.
- `http_request`, `read_url`, `media_download`, dan watchdog menolak alamat internal (localhost, IP privat,
  jaringan Docker, `169.254.169.254`), termasuk lewat redirect. Browser MCP memblokir origin yang sama
  (`--blocked-origins` di `mcp_servers.json`) dan `file://`.
- `yt-dlp` dijalankan tanpa shell (argumen terpisah), jadi URL tidak bisa menyisipkan perintah.

---

## 🚀 Panduan Instalasi & Menjalankan

### 0. Cara cepat (dianjurkan saat pindah server)

Satu script menyiapkan semuanya dan bisa dijalankan ulang dengan aman — tiap langkah
dilewati kalau sudah beres:

```bash
git clone https://github.com/cicithvs-web/nroz.git && cd nroz
cp .env.example .env && nano .env        # isi BOT_TOKEN, API_KEY, BASE_URL, MODEL, OWNER_ID
sudo bash scripts/setup-vps.sh
```

Script memasang Node.js >= 18, Docker, ffmpeg/ffprobe, yt-dlp, library yang dibutuhkan
Chrome Headless Shell, `cloudflared` (web preview + link unduhan video), swapfile untuk
render video panjang, dependensi npm bot + Remotion, venv `edge-tts`, image sandbox
Docker, menjalankan PostgreSQL lokal (container `nroz-postgres`, password acak ditulis
otomatis ke `.env` sebagai `DATABASE_URL`, data persist di volume `nroz-pg-data`),
lalu menjalankan bot di pm2 dan mengaktifkan auto-start saat reboot.

Mau pakai database PostgreSQL eksternal (managed DB) instead? Isi `DATABASE_URL`
sendiri di `.env` sebelum menjalankan script — container lokal tidak akan dijalankan.

Cek kondisi server tanpa mengubah apa pun:

```bash
bash scripts/setup-vps.sh --check
```

Opsi: `--skip-node`, `--skip-docker`, `--skip-npm`, `--skip-start`, `--swap-mb=4096`.

Langkah manual di bawah tetap berlaku sebagai rujukan kalau script tidak cocok dengan
kondisimu (misalnya distro non-Debian/Ubuntu).

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

# Atau dengan PM2 (nama app "nroz" — dipakai juga oleh scripts/setup-vps.sh --check)
pm2 start bot.js --name nroz
pm2 save
pm2 startup systemd -u root --hp /root   # opsional: auto-start setelah reboot
```

---

## 📋 Perintah Bot di Telegram

- `/start` : Menampilkan menu utama dan fitur bot
- `/newtopic` : Memulai topik / sesi baru (membersihkan konteks percakapan)
- `/stop` : Menghentikan pekerjaan AI yang sedang berjalan sekaligus membatalkan pesan yang menunggu di antrean
  (pesan yang dikirim saat AI masih bekerja diproses berurutan; maksimal 5 menunggu, ubah lewat `TURN_QUEUE_MAX`)
- `/workspace` : Memeriksa daftar file di workspace server pengguna
- `/sandbox` : Memeriksa status container Docker sandbox pribadi
- `/resetsandbox` : Mereset container sandbox jika terjadi kendala sistem
- `/tasks` : Melihat (dan membatalkan lewat tombol) pengingat dan pemantau web yang aktif
- `/canceltask <id>` : Membatalkan tugas pengingat / pemantau web
- `/clean` : Membersihkan file di folder workspace pengguna
- `/summary` : Melihat ringkasan memori percakapan jangka panjang
- `/pause` & `/resume` : Menjeda atau mengaktifkan kembali respons bot
