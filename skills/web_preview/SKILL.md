---
name: web_preview
description: Panduan menjalankan aplikasi web lokal di sandbox dan membuka link preview publik (Cloudflare Tunnel) untuk user.
---

# Panduan Keahlian: Instant Web Preview & Server Lokal

Skill ini digunakan setiap kali user meminta membuat aplikasi web interaktif, landing page, dashboard, game HTML5 canvas, REST API, atau layanan backend yang perlu dibuka langsung di browser oleh user.

## Alur Kerja Menjalankan Web App & Preview Publik

1. **Langkah 1: Siapkan Kode Web App di `/workspace/work/`**
   - Buat file web (HTML/CSS/JS, Node.js Express, Python Flask/FastAPI, Vite/React, dll).
   - Pastikan server diset mendengarkan host `0.0.0.0` (bukan hanya `127.0.0.1` localhost), dan port yang spesifik (misalnya `3000`, `8080`, atau `5000`).

2. **Langkah 2: Jalankan Server di Background**
   - Jalankan server menggunakan tool `run_command` dengan opsi `background: true`:
     ```json
     {
       "command": "cd /workspace/work/myapp && node server.js",
       "background": true
     }
     ```
   - Opsi `background: true` memastikan terminal tidak macet/hang menunggu proses server yang berjalan terus-menerus.

3. **Langkah 3: Buka Tunnel Publik dengan `start_web_preview`**
   - Panggil tool `start_web_preview`:
     ```json
     {
       "port": 3000
     }
     ```
   - Tool ini akan otomatis mendeteksi IP sandbox container dan menyambungkan Cloudflare Tunnel aman (HTTPS).

4. **Langkah 4: Kirimkan Link ke User**
   - Berikan link publik HTTPS (`https://*.trycloudflare.com`) ke chat Telegram user agar user bisa langsung mengklik dan menguji web app tersebut dari browser HP atau laptop mereka!
