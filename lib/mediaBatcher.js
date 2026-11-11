/**
 * lib/mediaBatcher.js — Menggabungkan kiriman banyak foto/dokumen beruntun (Telegram Album /
 * multi-upload) dalam jendela waktu singkat (~1.2 detik) menjadi 1 giliran AI tunggal.
 *
 * Masalah sebelumnya:
 * Saat user mengirim 3–10 foto/file sekaligus di Telegram, Telegram API menembakkan N event
 * terpisah dalam hitungan milidetik (dan caption hanya menempel di item pertama). Tanpa
 * batcher ini, item ke-1 langsung mengunci turnQueue dan item ke-2..N memunculkan pesan
 * "⏳ Masih mengerjakan permintaan sebelumnya..." serta diproses terpisah tanpa caption.
 */

const fs = require("fs");
const path = require("path");

const DEFAULT_DEBOUNCE_MS = Number(process.env.MEDIA_BATCH_DEBOUNCE_MS) || 1200;
const DEFAULT_MAX_BATCH = 20;

/**
 * Membuat instance MediaBatcher (bisa dikustomisasi debounceMs untuk unit test).
 * @param {{ debounceMs?: number, maxBatchSize?: number }} [opts]
 */
function createMediaBatcher({ debounceMs = DEFAULT_DEBOUNCE_MS, maxBatchSize = DEFAULT_MAX_BATCH } = {}) {
  /** @type {Map<string, { items: Array<any>, timer: NodeJS.Timeout | null, onFlush: (items: Array<any>) => any }>} */
  const batches = new Map();

  function flush(sessionId) {
    const key = String(sessionId);
    const entry = batches.get(key);
    if (!entry) return;
    if (entry.timer) clearTimeout(entry.timer);
    batches.delete(key);

    const items = entry.items;
    const cb = entry.onFlush;
    if (items.length > 0 && typeof cb === "function") {
      Promise.resolve()
        .then(() => cb(items))
        .catch((err) => {
          console.error(`[MediaBatcher] Error saat memproses batch sesi ${key}:`, err);
        });
    }
  }

  /**
   * Masukkan satu item media (foto/dokumen) ke keranjang sementara sesi.
   * Timer di-reset setiap kali ada item baru masuk dalam jendela `debounceMs`.
   * @param {string} sessionId
   * @param {any} item
   * @param {(items: Array<any>) => Promise<void> | void} onFlush
   */
  function enqueue(sessionId, item, onFlush) {
    const key = String(sessionId);
    let entry = batches.get(key);
    if (!entry) {
      entry = { items: [], timer: null, onFlush };
      batches.set(key, entry);
    }
    entry.items.push(item);
    if (typeof onFlush === "function") {
      entry.onFlush = onFlush;
    }

    if (entry.timer) clearTimeout(entry.timer);

    if (entry.items.length >= maxBatchSize) {
      flush(key);
      return;
    }

    entry.timer = setTimeout(() => {
      flush(key);
    }, debounceMs);
  }

  function pendingItemCount(sessionId) {
    return batches.get(String(sessionId))?.items.length || 0;
  }

  function clearAll() {
    for (const entry of batches.values()) {
      if (entry.timer) clearTimeout(entry.timer);
    }
    batches.clear();
  }

  return {
    enqueue,
    flushNow: flush,
    pendingItemCount,
    clearAll
  };
}

/**
 * Menghasilkan nama file unik di folder `uploadsDir` agar kiriman multi-foto/multi-file
 * di milidetik yang sama tidak saling menimpa.
 *
 * @param {string} uploadsDir
 * @param {string} baseFileName
 * @param {Set<string>} [usedNames]
 * @returns {string}
 */
function allocateUniqueUploadName(uploadsDir, baseFileName, usedNames = new Set()) {
  const ext = path.extname(baseFileName);
  const stem = path.basename(baseFileName, ext) || "file";
  let candidate = `${stem}${ext}`;
  let counter = 2;

  while (
    usedNames.has(candidate) ||
    (uploadsDir && fs.existsSync(path.join(uploadsDir, candidate)))
  ) {
    candidate = `${stem}_${counter}${ext}`;
    counter++;
  }

  usedNames.add(candidate);
  return candidate;
}

const defaultMediaBatcher = createMediaBatcher();

module.exports = {
  createMediaBatcher,
  defaultMediaBatcher,
  allocateUniqueUploadName
};
