/**
 * lib/atomicFile.js — Menulis JSON tanpa risiko file setengah jadi saat proses mati.
 *
 * Isi ditulis ke file sementara di folder yang sama lalu di-rename. rename() di filesystem
 * yang sama bersifat atomik, jadi pembaca selalu melihat versi lama atau versi baru utuh.
 */

const fs = require("fs");
const path = require("path");

function writeJsonAtomic(file, data) {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.${Date.now()}.tmp`);
  const fd = fs.openSync(tmp, "w");
  try {
    fs.writeSync(fd, JSON.stringify(data, null, 2));
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, file);
}

/** Menulis teks biasa secara atomik (tulis ke file sementara lalu rename). */
function writeTextAtomic(file, text) {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.${Date.now()}.tmp`);
  const fd = fs.openSync(tmp, "w");
  try {
    fs.writeSync(fd, text);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, file);
}

/**
 * Membaca JSON. Kalau file rusak, file disimpan sebagai <nama>.corrupt-<waktu> supaya
 * datanya tidak tertimpa simpanan berikutnya, lalu `fallback` dikembalikan.
 */
function readJsonSafe(file, fallback) {
  if (!fs.existsSync(file)) return fallback;
  try {
    return JSON.parse(fs.readFileSync(file, "utf-8"));
  } catch (err) {
    const backup = `${file}.corrupt-${Date.now()}`;
    try {
      fs.copyFileSync(file, backup);
    } catch (_) {}
    console.warn(`[atomicFile] ${path.basename(file)} rusak (${err.message}), salinan disimpan di ${backup}`);
    return fallback;
  }
}

module.exports = { writeJsonAtomic, writeTextAtomic, readJsonSafe };
