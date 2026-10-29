---
name: sequential_thinking
description: Panduan penalaran mendalam dan pemecahan masalah bertahap (Sequential Thinking) untuk tugas-tugas rumit, debugging sulit, dan perancangan arsitektur sistem.
---

# Panduan Keahlian: Sequential Thinking (Penalaran Bertahap)

Skill ini digunakan saat kamu menghadapi tugas yang membutuhkan analisa mendalam, perancangan arsitektur bertingkat, atau pemecahan masalah (debugging) yang kompleks. Tool ini membantumu berpikir secara terstruktur, adaptif, dan teliti sebelum memberikan solusi final kepada user.

---

## 🧠 Kapan Harus Menggunakan `sequentialthinking`?
Gunakan tool `sequentialthinking` ketika:
1. **Masalah Multi-Langkah**: Tugas yang tidak bisa diselesaikan hanya dengan asumsi sekali tebak.
2. **Perancangan Arsitektur / Database**: Membandingkan beberapa pendekatan desain sebelum memutuskan implementasi terbaik.
3. **Debugging Kode yang Rumit**: Melacak akar penyebab bug yang membingungkan atau error terselubung.
4. **Validasi Hipotesis**: Saat kamu perlu menguji asumsi teknis secara kritis sebelum menjalankan perubahan besar pada file sistem.

---

## 🛠️ Parameter & Alur Pemanggilan

Tool `sequentialthinking` menerima parameter berikut:
- `thought` *(string, wajib)*: Uraian pemikiran analitis pada langkah saat ini.
- `thoughtNumber` *(number, wajib)*: Nomor urut langkah pemikiran (dimulai dari 1).
- `totalThoughts` *(number, wajib)*: Estimasi total langkah yang dibutuhkan (bisa dinaikkan/diturunkan secara dinamis seiring berkembangnya pemikiran).
- `nextThoughtNeeded` *(boolean, wajib)*: `true` jika kamu masih perlu langkah pemikiran berikutnya, atau `false` jika solusi sudah tuntas dan siap dieksekusi/dijawab.
- `isRevision` *(boolean, opsional)*: `true` jika langkah ini merevisi atau mengoreksi pemikiran sebelumnya.
- `revisesThought` *(number, opsional)*: Nomor langkah pemikiran yang sedang direvisi.
- `branchFromThought` *(number, opsional)*: Nomor langkah asal jika kamu ingin mengeksplorasi cabang ide alternatif.

---

## 📋 Contoh Pola Alur Berpikir (Chain of Thought)

### Langkah 1: Memetakan Masalah & Hipotesis Awal
```json
{
  "thought": "Menganalisis kebutuhan user: User ingin sistem autentikasi dengan JWT dan refresh token di VPS. Ada 2 opsi penyimpanan: Redis vs SQLite/File. Hipotesis awal: gunakan SQLite karena lebih ringan untuk VPS berspesifikasi hemat.",
  "thoughtNumber": 1,
  "totalThoughts": 3,
  "nextThoughtNeeded": true
}
```

### Langkah 2: Evaluasi & Edge Cases
```json
{
  "thought": "Mengevaluasi trade-off: SQLite sangat mudah dipelihara dan tidak butuh background service Redis tambahan. Namun perlu dipastikan race-condition dan mekanisme auto-pruning token kedaluwarsa. Kita bisa tambahkan scheduled job ringan.",
  "thoughtNumber": 2,
  "totalThoughts": 3,
  "nextThoughtNeeded": true
}
```

### Langkah 3: Finalisasi & Solusi Teruji
```json
{
  "thought": "Solusi sudah matang dan siap: Kita akan gunakan tabel refresh_tokens di SQLite dengan kolom token, user_id, expires_at, dan revoked. Siap mulai menulis kode dan menjelaskan ke user.",
  "thoughtNumber": 3,
  "totalThoughts": 3,
  "nextThoughtNeeded": false
}
```

---

## 💡 Best Practices
1. **Jujur saat menemukan keraguan**: Jika di langkah 2 kamu menyadari ada kekurangan, tandai `isRevision: true` dan perbaiki pendekatanmu.
2. **Kembangkan total langkah jika perlu**: Jika awalnya kamu mengira butuh 3 langkah tapi di langkah 2 muncul kompleksitas baru, naikkan `totalThoughts` menjadi 4 atau 5.
3. **Eksekusi setelah tuntas**: Setelah `nextThoughtNeeded: false`, lanjutkan ke tool eksekusi (`file_write`, `run_command`, dll.) atau berikan kesimpulan yang jelas kepada user.
