---
name: image_generation
description: Panduan pembuatan gambar visual, lukisan, poster, grafik data, diagram sistem, dan pengiriman foto ke Telegram.
---

# Panduan Keahlian: Pembuatan Gambar & Visual (PIL, Matplotlib, SVG)

Skill ini digunakan setiap kali user meminta dibuatkan gambar, lukisan, ilustrasi, foto, kartu ucapan bergambar, poster, banner, diagram arsitektur, chart data, atau visualisasi statistik.

## ⚠️ Aturan Alur Kerja Wajib (2 Langkah)
Setiap permintaan gambar WAJIB diselesaikan dalam 2 langkah terstruktur:

1. **Langkah 1: Hasilkan File Gambar di Sandbox VPS**
   - Tulis dan jalankan script generator (Python dengan library `PIL`/`Pillow`, `matplotlib`, `seaborn`, atau generator SVG).
   - Simpan output file gambar di folder artefak:
     `/workspace/artifacts/<nama_file>.png` (atau `.jpg` / `.webp`).
   - Pastikan script berjalan sukses dan file benar-benar tercipta di disk.

2. **Langkah 2: WAJIB Panggil Tool `send_photo`**
   - Setelah file tercipta, **KAMU WAJIB MEMANGGIL TOOL `send_photo`**:
     ```json
     {
       "file_path": "/workspace/artifacts/<nama_file>.png",
       "caption": "Deskripsi singkat hasil gambar untuk user"
     }
     ```
   - **DILARANG KERAS** hanya membuat file di disk dan berkata "gambarnya sudah selesai dibuat" tanpa memanggil tool `send_photo`. User hanya berinteraksi melalui Telegram dan tidak bisa melihat file di server jika kamu tidak mengirimkannya!

## Panduan Visualisasi Data & Grafik (Data Analyst)
- Gunakan `matplotlib.pyplot` dan `seaborn` dengan style modern (contoh: dark background, color palette menarik, grid transparan, label sumbu dan legenda yang jelas).
- Atur resolusi kanvas yang tajam (misal `plt.figure(figsize=(10, 6), dpi=300)`).
- Simpan dengan `plt.savefig('/workspace/artifacts/chart.png', bbox_inches='tight')`.
- Panggil `send_photo` dengan path tersebut.

## Tips Menggambar dengan Pillow (PIL)
- Siapkan ukuran kanvas yang cukup besar (misal 1024x1024 atau 1200x800).
- Gunakan antialiasing, gradien warna bertingkat, dan lapisan bayangan (shadow) menggunakan `ImageFilter.GaussianBlur` agar hasil gambar terlihat profesional dan tidak kaku.
