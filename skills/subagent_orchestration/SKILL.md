---
name: subagent_orchestration
description: Panduan orkestrasi & pendelegasian tugas ke Subagent mandiri dengan peran dinamis (Pola Orkestrasi ala Antigravity).
---

# Panduan Keahlian: Orkestrasi Subagent Mandiri (Pola Antigravity)

Skill ini digunakan ketika user memberikan tugas besar, kompleks, berdurasi panjang, atau membutuhkan banyak langkah teknis beruntun (multi-turn loop). Sebagai Lead Agent, kamu tidak perlu mengerjakan semua langkah sendirian di chat utama.

## Mengapa Menggunakan Subagent?
1. **Context Window Terisolasi & Hemat Token:**
   Loop coding, trial-and-error debugging, atau riset web mendalam terjadi di sandbox subagent. Chat utama kamu dengan user tetap bersih, padat, dan hemat token.
2. **Keahlian Khusus & Persona Ahli:**
   Subagent beroperasi dengan fokus 100% pada perannya tanpa terdistraksi oleh riwayat chat lain.

## Cara Menggunakan Tool `delegate_task`
Panggil tool `delegate_task` dengan parameter:
- `role`: Nama peran subagent.
  - Preset standar: `"coder"`, `"researcher"`, `"tester"`, `"general"`.
  - **Peran Kustom Dinamis (Bebas):** Kamu bebas menciptakan peran baru apa pun sesuai kebutuhan (contoh: `"Cybersecurity Auditor"`, `"Data Analyst"`, `"Game Story Writer"`, `"DevOps Specialist"`, `"UI Designer"`, dll).
- `role_description`: Deskripsi persona, keahlian khusus, dan standar output subagent (sangat disarankan diisi jika membuat peran kustom).
- `task`: Instruksi tugas lengkap dan spesifik.
- `max_rounds`: Batas ronde tool subagent (default: 10, maksimal: 20).

## Konvensi Folder Kerja Subagent
- Seluruh eksperimen, source code, dan draft subagent ditaruh di:
  `/workspace/work/<nama_proyek>/`
- Hasil akhir (artefak siap pakai atau deliverable) ditaruh di:
  `/workspace/artifacts/`

## Alur Setelah Menerima Laporan Subagent
1. Subagent akan mengembalikan laporan ringkas hasil pekerjaannya ke Lead Agent.
2. Lead Agent membaca laporan tersebut, menyimpulkannya dengan ramah kepada user Telegram, dan mengambil tindakan lanjutan yang relevan (misalnya menyalakan web preview dengan `start_web_preview` atau mengirimkan file artefak dengan `send_file`/`send_photo`).
