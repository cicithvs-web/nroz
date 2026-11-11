/**
 * test/mediaBatcher.test.js — Pengujian penggabungan multi-foto / multi-dokumen (Telegram Album).
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { createMediaBatcher, allocateUniqueUploadName } = require("../lib/mediaBatcher");

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

test("createMediaBatcher menggabungkan 5 foto beruntun menjadi 1 flush tunggal", async () => {
  const batcher = createMediaBatcher({ debounceMs: 60 });
  const flushedBatches = [];

  for (let i = 1; i <= 5; i++) {
    batcher.enqueue("sesi-album", { id: i, type: "photo" }, (items) => {
      flushedBatches.push(items);
    });
    await wait(10);
  }

  assert.equal(batcher.pendingItemCount("sesi-album"), 5);
  await wait(90);

  assert.equal(flushedBatches.length, 1, "harus hanya 1 kali flush untuk seluruh album");
  assert.equal(flushedBatches[0].length, 5, "isi batch harus lengkap 5 foto");
  assert.deepEqual(
    flushedBatches[0].map((x) => x.id),
    [1, 2, 3, 4, 5]
  );
  batcher.clearAll();
});

test("createMediaBatcher memisahkan batch antar sesi yang berbeda", async () => {
  const batcher = createMediaBatcher({ debounceMs: 50 });
  const results = {};

  batcher.enqueue("sesi-A", "a1", (items) => (results.A = items));
  batcher.enqueue("sesi-B", "b1", (items) => (results.B = items));
  batcher.enqueue("sesi-A", "a2", (items) => (results.A = items));

  await wait(80);
  assert.deepEqual(results.A, ["a1", "a2"]);
  assert.deepEqual(results.B, ["b1"]);
  batcher.clearAll();
});

test("allocateUniqueUploadName mencegah tabrakan nama file di milidetik yang sama", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nroz-batch-test-"));
  try {
    const used = new Set();
    const n1 = allocateUniqueUploadName(tmpDir, "photo_1000.jpg", used);
    const n2 = allocateUniqueUploadName(tmpDir, "photo_1000.jpg", used);
    const n3 = allocateUniqueUploadName(tmpDir, "photo_1000.jpg", used);

    assert.equal(n1, "photo_1000.jpg");
    assert.equal(n2, "photo_1000_2.jpg");
    assert.equal(n3, "photo_1000_3.jpg");

    // Jika file fisik sudah ada di disk, juga tidak boleh ditimpa
    fs.writeFileSync(path.join(tmpDir, "laporan.pdf"), "dummy");
    const docName = allocateUniqueUploadName(tmpDir, "laporan.pdf", new Set());
    assert.equal(docName, "laporan_2.pdf");
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
