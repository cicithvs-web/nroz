---
name: browser_automation
description: Panduan mengendalikan browser Chromium asli via MCP (Playwright) untuk membuka website, mengisi form pendaftaran, klik tombol, dan mengambil screenshot layar.
---

# Panduan Keahlian: Browser Automation via MCP (Playwright)

Skill ini digunakan setiap kali user meminta AI untuk membuka website, melihat tampilan halaman web dengan JavaScript aktif, mengisi form (registrasi/pendaftaran akun, login, pencarian), mengklik tombol/link, atau mengambil tangkapan layar (screenshot) web.

## Mengapa Menggunakan Browser MCP?
Tool biasa seperti `read_url` atau `web_search` hanya bisa membaca teks mentah tanpa menjalankan JavaScript.  
Sedangkan **Browser MCP menyalakan browser Chromium asli di background VPS**, sehingga:
- Halaman web modern (Single Page App / React / Vue / Angular) dapat dimuat secara sempurna.
- AI bisa berinteraksi dengan elemen web (mengetik, mengklik, memilih opsi dropdown).
- AI bisa memotret layar (screenshot) dan **otomatis mengirimkan fotonya ke Telegram user**.

---

## 🛠️ Alur Kerja Interaksi Web & Registrasi

### 1. Membuka Halaman Web (`browser_navigate`)
Gunakan tool `browser_navigate` dengan URL target:
```json
{
  "url": "https://example.com/register"
}
```

### 2. Memeriksa Elemen di Halaman (`browser_snapshot` atau `browser_find`)
Gunakan `browser_snapshot` untuk mendapatkan struktur DOM aksesibilitas halaman, sehingga kamu tahu nama field input dan tombol yang tersedia di layar.

### 3. Mengisi Form Pendaftaran (`browser_fill_form` atau `browser_type`)
- Gunakan `browser_fill_form` jika ingin mengisi beberapa field sekaligus:
  ```json
  {
    "fields": [
      { "selector": "#name", "value": "Budi Santoso" },
      { "selector": "#email", "value": "budi@example.com" },
      { "selector": "#password", "value": "Rahasia123!" }
    ]
  }
  ```
- Atau gunakan `browser_type` untuk mengetik pada elemen tertentu:
  ```json
  {
    "selector": "input[name='email']",
    "text": "budi@example.com"
  }
  ```

### 4. Mengklik Tombol Submit / Daftar (`browser_click`)
Gunakan `browser_click` pada tombol tujuan:
```json
{
  "selector": "button[type='submit']"
}
```

### 5. Mengambil Screenshot Bukti Layar (`browser_take_screenshot`)
Gunakan tool `browser_take_screenshot` untuk memotret halaman:
```json
{}
```
- Sistem MCP Nroz akan secara **otomatis menyimpan foto screenshot tersebut dan mengirimkannya langsung ke chat Telegram user**!
- Ini memberikan transparansi penuh kepada user agar user melihat persis apa yang sedang dilihat bot di browser.

### 6. Menunggu Proses atau Loading (`browser_wait_for`)
Jika halaman butuh waktu beberapa detik untuk memproses pendaftaran:
```json
{
  "time": 2000
}
```

---

## ⚠️ Tips Penting
- Jika halaman memiliki verifikasi Captcha yang rumit, ambil screenshot dan beritahukan user di Telegram.
- Selalu utamakan screenshot di akhir tugas agar user menerima bukti visual bahwa halaman sudah berhasil dibuka atau form sudah terkirim.
