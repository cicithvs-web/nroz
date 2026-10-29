---
name: remotion_video
description: Panduan pembuatan & rendering video animasi React/Remotion (MP4), narasi suara AI (TTS), subtitle sinkron, dan penataan audio.
---

# Panduan Keahlian: Pembuatan Video Animasi (Remotion React)

Skill ini digunakan setiap kali user meminta membuat, merancang, atau merender video dalam bentuk apa pun (video edukasi/explainer, ucapan ulang tahun, quotes kinetic typography, Shorts/Reels/TikTok, countdown, promo diskon, atau video musik).

## ⚠️ Aturan Mutlak
1. **WAJIB HANYA GUNAKAN TOOL `render_remotion_video`**:
   - Dilarang keras membuat video menggunakan script Python (moviepy, opencv, manim, matplotlib animasi) atau ffmpeg manual via `run_code` / `run_command`.
   - Server memiliki engine rendering Remotion khusus yang dioptimalkan untuk GPU/CPU server.
2. **NON-BLOCKING & PENGIRIMAN OTOMATIS**:
   - Panggilan tool `render_remotion_video` mengembalikan status antrean job (nomor job, estimasi waktu).
   - Video hasil render **otomatis dikirim oleh bot ke chat Telegram** saat selesai (native video jika ≤48 MB, link unduhan HTTPS jika >48 MB).
   - Jangan menunggu hasil render dengan `sleep`, jangan me-render ulang kode yang sama, dan jangan memakai tag `<<<SENDVIDEO>>>`.
   - Cukup kabari user bahwa video sedang diproses beserta estimasi waktunya, lalu akhiri jawabanmu.

## Fitur Suara Narasi AI (TTS) & Subtitle
- **Narasi Satu Suara (`tts_text`)**:
  Kirim seluruh naskah utuh di parameter `tts_text` dan pilih `tts_voice`:
  - `id-male`: Suara pria bahasa Indonesia (Ardi)
  - `id-female`: Suara wanita bahasa Indonesia (Gadis)
  - `en-male`: Suara pria bahasa Inggris (Christopher)
  - `en-female`: Suara wanita bahasa Inggris (Jenny)
- **Narasi Dialog / Banyak Suara (`tts_lines`)**:
  Kirim array baris naskah:
  `[{"text": "Halo semua!", "voice": "id-male"}, {"text": "Selamat datang di channel kami.", "voice": "id-female"}]`
  Durasi video otomatis mengikuti panjang audio (maksimum 900 detik / 15 menit).
- **Subtitle Sinkron Otomatis (`nrozTimings`)**:
  Jika memakai `tts_lines`, komponen React kamu otomatis menerima prop `nrozTimings`:
  `[{ text, voice, start, end, words: [{ text, start, end }] }]` dalam detik.
  Gunakan ini untuk menganimasikan teks kata-per-kata sesuai waktu pengucapan.

## Aturan Durasi & FPS (Optimasi Server)
- Video pendek (≤ 60 detik): Gunakan `fps: 30` (default).
- Video panjang (> 2 menit): **WAJIB kirim parameter `fps: 15`** untuk menghemat waktu rendering hingga 50%.
- Kecepatan render server rata-rata ±0,35 detik per frame. Video 5 menit @15fps (4.500 frame) memakan waktu ±26 menit. Informasikan estimasi waktu ini ke user.

## Musik Latar & Audio Fisik
- Jika user meminta musik latar atau menyertakan file audio di workspace, isi parameter `audio_path` (contoh: `/workspace/musik.mp3`).
- Di dalam kode React, kamu juga bisa menggunakan komponen Remotion: `<Audio src={staticFile("nama_file.mp3")} />`.

## Desain & Styling React Component
- Gunakan hook animasi Remotion: `useCurrentFrame()`, `useVideoConfig()`, `spring()`, `interpolate()`.
- Hindari array `inputRange` terbalik pada `interpolate()`. Nilai `inputRange` harus selalu meningkat secara monoton (misal: `[0, 1]`, bukan `[1, 0]`).
- Desain modern: latar belakang gelap gradien estetik, typography besar kontras tinggi, tata letak rapi, elemen visual pendukung yang dinamis.
- Resolusi standar: `1080x1920` (9:16 vertikal untuk Shorts/Reels/TikTok) atau `1920x1080` (16:9 lanskap).
