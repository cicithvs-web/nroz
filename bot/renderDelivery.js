/**
 * bot/renderDelivery.js — Progres render video di chat dan pengiriman hasilnya.
 *
 * Render video makan menit, jadi user melihat satu pesan yang di-edit di tempat dengan
 * persen, jumlah frame, dan sisa waktu perkiraan Remotion sendiri. Pesan dihapus begitu
 * hasil final (video atau link) dikirim.
 */

const fs = require("fs");
const path = require("path");
const ctx = require("./context");
const { TELEGRAM_SEND_MAX_MB } = require("./config");
const { renderProgressBar, humanizeSeconds } = require("./text");
const { onRenderComplete, onRenderProgress, resumePersistedJobs, STAGE_LABEL } = require("../remotionManager.js");
const { createShareLink } = require("../videoShareManager.js");

const renderProgressState = new Map(); // jobId -> { messageId, stage, lastEdit }
const PROGRESS_EDIT_MS = 20_000;

async function updateRenderProgress(job, progress) {
  if (!job.chatId || process.env.RENDER_PROGRESS_MESSAGE === "off") return;

  const st = renderProgressState.get(job.id) || {};
  const stageChanged = st.stage !== progress.stage;
  if (progress.stage === "done" && !st.messageId) return;
  if (st.messageId && !stageChanged && Date.now() - st.lastEdit < PROGRESS_EDIT_MS) return;

  const sisa = progress.remainingText
    ? `sisa ±${progress.remainingText}`
    : `sisa ±${humanizeSeconds((job.estimateSec || 0) - (progress.elapsedSec || 0))}`;

  const text =
    `🎬 Render #${job.id} — ${String(job.options?.title || "video").replace(/\s+/g, " ").slice(0, 40)}\n` +
    `${renderProgressBar(progress.percent)} ${Math.round(progress.percent || 0)}%\n` +
    `• ${STAGE_LABEL[progress.stage] || progress.stage}${progress.total ? ` · ${progress.rendered}/${progress.total} frame` : ""}\n` +
    `• ${sisa} · sudah jalan ${humanizeSeconds(progress.elapsedSec)}\n` +
    `• Video ${job.duration} detik — hasilnya dikirim otomatis ke chat ini`;

  const sendOpts = job.threadId ? { message_thread_id: job.threadId } : {};
  try {
    if (st.messageId) {
      await ctx.bot.editMessageText(text, { chat_id: job.chatId, message_id: st.messageId, ...sendOpts });
    } else {
      const sent = await ctx.bot.sendMessage(job.chatId, text, sendOpts);
      st.messageId = sent.message_id;
    }
    st.stage = progress.stage;
    st.lastEdit = Date.now();
    renderProgressState.set(job.id, st);
  } catch (err) {
    // Kegagalan update progres tidak boleh menggagalkan render.
    console.warn(`[Remotion Queue] Update progres job #${job.id} gagal: ${err.message}`);
    if (/not found|not modified|too old|message can't be edited/i.test(err.message)) {
      renderProgressState.delete(job.id);
    }
  }
}

async function clearRenderProgress(job) {
  const st = renderProgressState.get(job.id);
  renderProgressState.delete(job.id);
  if (!st?.messageId) return;
  try {
    await ctx.bot.deleteMessage(job.chatId, st.messageId);
  } catch (_) {
    // Pesan mungkin sudah dihapus manual; tidak penting.
  }
}


// Render video berjalan di latar belakang, jadi hasilnya dikirim ke chat
// saat job selesai — bukan lewat jawaban AI yang sudah lama berakhir.
// Video yang lebih besar dari batas upload bot dikirim sebagai link unduhan (Cloudflare Tunnel),
// karena kompres paksa sampai muat 50 MB akan menghancurkan kualitasnya.
async function deliverRenderResult(job) {
  const res = job.result || {};
  const sendOpts = job.threadId ? { message_thread_id: job.threadId } : {};

  if (!res.success || !res.videoPath || !fs.existsSync(res.videoPath)) {
    await ctx.bot.sendMessage(
      job.chatId,
      `❌ Render video (job #${job.id}) gagal:\n${String(res.error || "penyebab tidak diketahui").slice(0, 800)}`,
      sendOpts
    );
    return;
  }

  const sizeMb = fs.statSync(res.videoPath).size / (1024 * 1024);
  const kirimSebagaiLink = async () => {
    const share = await createShareLink(res.videoPath, { chatId: job.chatId });
    const kadarKedaluwarsa = new Date(share.expiresAt).toLocaleString("id-ID", { timeZone: "Asia/Jakarta" });
    await ctx.bot.sendMessage(
      job.chatId,
      `🎬 Video selesai dirender (job #${job.id}) — tapi ukurannya ${share.sizeMb} MB, di atas batas upload bot 50 MB, jadi diambil lewat link.\n\n` +
        `🔗 ${share.url}\n\n` +
        `• Durasi: ${res.duration} detik\n` +
        `• Ukuran: ${share.sizeMb} MB\n` +
        `• Waktu render: ${res.elapsedSec} detik\n` +
        `• Link aktif sampai ${kadarKedaluwarsa} WIB, bisa langsung diputar dan di-seek di browser HP.` +
        (share.ready ? "" : "\n• Link baru akan bisa dibuka ±1 menit lagi (DNS Cloudflare masih menyebarkan alamatnya).") +
        `\nKalau link tidak terbuka (server baru saja direstart), bilang saja — aku kirim link baru.`,
      sendOpts
    );
    console.log(`[Remotion Queue] Job #${job.id} dikirim sebagai link unduhan (${share.sizeMb} MB > ${TELEGRAM_SEND_MAX_MB} MB, ready=${share.ready}).`);
  };

  if (sizeMb > TELEGRAM_SEND_MAX_MB) {
    try {
      await kirimSebagaiLink();
    } catch (err) {
      console.error(`[Remotion Queue] Gagal membuat link unduhan job #${job.id}:`, err.message);
      await ctx.bot.sendMessage(
        job.chatId,
        `🎬 Video job #${job.id} sudah jadi (${sizeMb.toFixed(1)} MB) tapi link unduhannya gagal dibuat: ${err.message}\n` +
          `File tersimpan di workspace sebagai ${path.basename(res.videoPath)}.`,
        sendOpts
      );
    }
    return;
  }

  try {
    await ctx.bot.sendVideo(
      job.chatId,
      res.videoPath,
      {
        caption:
          `🎬 *Video Selesai Dirender* (job #${job.id})\n` +
          `• File: \`${path.basename(res.videoPath)}\`\n` +
          `• Durasi: ${res.duration} detik\n` +
          `• Ukuran: ${res.sizeMb} MB\n` +
          `• Waktu render: ${res.elapsedSec} detik`,
        parse_mode: "Markdown",
        supports_streaming: true,
        ...sendOpts
      }
    );
  } catch (err) {
    // Telegram masih bisa menolak (413) untuk file di dekat batas; link adalah jalan keluar.
    if (/413|too large/i.test(err.message)) {
      console.warn(`[Remotion Queue] Job #${job.id} ditolak Telegram (413), beralih ke link unduhan.`);
      try {
        await kirimSebagaiLink();
        return;
      } catch (linkErr) {
        console.error(`[Remotion Queue] Fallback link job #${job.id} juga gagal:`, linkErr.message);
      }
    }
    throw err;
  }
}

/**
 * Memasang handler progres & hasil render, lalu menjalankan ulang job yang belum selesai
 * saat bot terakhir berhenti (dan memberi tahu chat pemiliknya).
 */
function registerRenderDelivery() {
  onRenderProgress((job, progress) => {
    updateRenderProgress(job, progress).catch((err) =>
      console.warn(`[Remotion Queue] Handler progres job #${job.id} error:`, err.message)
    );
  });

  onRenderComplete(async (job) => {
    if (!job.chatId) {
      console.warn(`[Remotion Queue] Job #${job.id} selesai tapi tidak punya chatId, hasil tidak dikirim.`);
      return;
    }
    try {
      await deliverRenderResult(job);
    } catch (err) {
      console.error(`[Remotion Queue] Gagal mengirim hasil job #${job.id} ke chat ${job.chatId}:`, err.message);
    } finally {
      await clearRenderProgress(job);
    }
  });

  for (const job of resumePersistedJobs()) {
    if (!job.chatId) continue;
    const sendOpts = job.threadId ? { message_thread_id: job.threadId } : {};
    const title = String(job.options?.title || "video").slice(0, 40);
    ctx.bot
      .sendMessage(
        job.chatId,
        `♻️ Bot sempat restart saat render #${job.id} (${title}) ${job.wasRendering ? "sedang berjalan" : "masih antre"}. ` +
          `Render dijalankan ulang${job.wasRendering ? " dari awal" : ""}; hasilnya tetap dikirim otomatis ke chat ini.`,
        sendOpts
      )
      .catch((err) => console.warn(`[Remotion Queue] Gagal memberi tahu job #${job.id} dilanjutkan:`, err.message));
  }
}

module.exports = { registerRenderDelivery };
