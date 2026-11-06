const test = require("node:test");
const assert = require("node:assert/strict");
const process = require("process");

// knowledge.js memuat bot/config yang membaca API_KEY saat load — isi supaya aman di test.
process.env.API_KEY = process.env.API_KEY || "test-key";
process.env.BASE_URL = process.env.BASE_URL || "http://127.0.0.1:1/v1";

const { chunkText } = require("../bot/knowledge");

test("chunkText: teks pendek jadi satu chunk utuh", () => {
  const text = "Halo dunia. Ini teks pendek.";
  assert.deepEqual(chunkText(text), [text]);
});

test("chunkText: teks kosong menghasilkan array kosong", () => {
  assert.deepEqual(chunkText(""), []);
  assert.deepEqual(chunkText("   \n\n  "), []);
});

test("chunkText: menggabungkan paragraf kecil sampai mendekati batas ukuran", () => {
  const para = "Paragraf kecil. ".repeat(10); // ±160 karakter
  const text = Array.from({ length: 12 }, (_, i) => `Paragraf ${i}.\n\n${para}`).join("\n\n");
  const chunks = chunkText(text, 600, 0);
  assert.ok(chunks.length > 1, "harus terpecah menjadi beberapa chunk");
  for (const c of chunks) {
    assert.ok(c.length <= 620, `chunk melebihi batas: ${c.length}`);
  }
  // Semua konten tetap ada (tanpa overlap, tidak ada karakter yang hilang selain whitespace gabungan).
  assert.ok(chunks.join(" ").includes("Paragraf 0."));
  assert.ok(chunks.join(" ").includes("Paragraf 11."));
});

test("chunkText: overlap antar chunk mempertahankan ekor chunk sebelumnya", () => {
  const sentence = "Kalimat penuh dengan isi yang cukup panjang untuk diuji. ";
  const text = sentence.repeat(80); // ±5.600 karakter
  const size = 800;
  const overlap = 150;
  const chunks = chunkText(text, size, overlap);
  assert.ok(chunks.length >= 2);
  for (let i = 1; i < chunks.length; i++) {
    const tail = chunks[i - 1].slice(-overlap - 40);
    // Sebagian ekor chunk sebelumnya muncul lagi di kepala chunk berikutnya (overlap).
    assert.ok(
      chunks[i].startsWith(tail.slice(0, 40)) || chunks[i].includes(tail.slice(0, 40)),
      "overlap tidak ditemukan antara chunk berurutan"
    );
  }
});

test("chunkText: paragraf raksasa dipotong keras tanpa kehilangan seluruh isi", () => {
  const giant = "x".repeat(5000);
  const chunks = chunkText(giant, 1000, 100);
  assert.ok(chunks.length >= 5);
  const totalCek = chunks.join("");
  assert.ok(totalCek.includes("x".repeat(4000)), "isi inti paragraf tetap ada");
});

test("chunkText: CRLF dinormalisasi", () => {
  const chunks = chunkText("Baris satu.\r\n\r\nBaris dua.", 500, 0);
  assert.equal(chunks.length, 1);
  assert.ok(chunks[0].includes("Baris dua."));
});
