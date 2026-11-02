/**
 * bot/queuedTurn.js — Menjalankan satu pemrosesan pesan lewat antrean per sesi (bot/turnQueue.js).
 */

const { replyText } = require("./send");
const { turnQueue, QueueFullError } = require("./turnQueue");

/**
 * Menjalankan seluruh pemrosesan satu pesan (unduh, simpan memori, baca riwayat, panggil AI)
 * secara berurutan per sesi. Pesan yang datang saat AI masih bekerja diberi tahu bahwa ia antre.
 */
async function runQueued(msg, sessionId, task) {
  try {
    await turnQueue.run(sessionId, task, {
      onQueued: (position) => {
        replyText(
          msg,
          `⏳ Masih mengerjakan permintaan sebelumnya. Pesanmu masuk antrean (urutan ${position}) dan diproses setelah itu. Ketik /stop untuk membatalkan semuanya.`
        ).catch(() => {});
      }
    });
  } catch (err) {
    if (err instanceof QueueFullError) {
      await replyText(
        msg,
        `⚠️ Antrean penuh (${err.limit} pesan sudah menunggu). Tunggu sebentar, atau ketik /stop untuk membatalkan yang sedang berjalan.`
      ).catch(() => {});
      return;
    }
    throw err;
  }
}

module.exports = { runQueued };
