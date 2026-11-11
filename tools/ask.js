/**
 * tools/ask.js — Tool ask_user: agent boleh bertanya / meminta input (OTP, 2FA, login, file, konfirmasi)
 * ke user di tengah tugas TANPA mematikan sesi/loop AI.
 *
 * Pertanyaan tampil sebagai pesan Telegram dengan tombol inline (kalau diberi opsi atau include_desktop).
 * Jawaban masuk lewat tiga jalur:
 *   1. Klik tombol inline (bot/callbacks.js)
 *   2. Pesan teks / voice berikutnya (diintersep di bot/handlers.js SEBELUM masuk turnQueue)
 *   3. Kiriman Foto / Dokumen berikutnya (diintersep di bot/handlers.js SEBELUM masuk turnQueue,
 *      otomatis disimpan ke /workspace/uploads/... dan path-nya diserahkan ke agent yang sedang menunggu)
 */

const crypto = require("crypto");
const ctx = require("../bot/context");
const { startDesktopTunnel, captureDesktopScreenshot } = require("../desktopManager.js");

const DEFAULT_TIMEOUT_MIN = Number(process.env.ASK_USER_DEFAULT_MINUTES) || 10;
const MAX_TIMEOUT_MIN = 60;
const MAX_OPTIONS = 8;
const MAX_OPTION_LEN = 64;
const MAX_QUESTION_LEN = 1500;

/** sessionId -> FIFO antrian pertanyaan yang sedang menunggu jawaban. */
const pendingAsks = new Map();

function clampTimeout(minutes) {
  const n = Number(minutes);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_TIMEOUT_MIN;
  return Math.min(Math.round(n), MAX_TIMEOUT_MIN);
}

function entryCount(sessionId) {
  return (pendingAsks.get(String(sessionId)) || []).length;
}

/**
 * Tool: ask_user
 * @returns {Promise<string>} hasil untuk model: jawaban user (teks/tombol/file) atau status timeout.
 */
async function toolAskUser({
  question,
  options,
  include_desktop,
  timeout_minutes,
  sessionId,
  chatId,
  threadId,
  onMediaSent
}) {
  if (!question || typeof question !== "string" || !question.trim()) {
    return "❌ Parameter 'question' wajib berupa string pertanyaan.";
  }
  if (!chatId || !ctx.bot) {
    return "❌ ask_user tidak punya chat tujuan (dipanggil di luar konteks chat Telegram).";
  }

  let cleanOptions = [];
  if (options !== undefined && options !== null) {
    if (!Array.isArray(options)) {
      return "❌ Parameter 'options' harus berupa array string pilihan.";
    }
    cleanOptions = options
      .map((o) => String(o ?? "").trim())
      .filter(Boolean)
      .slice(0, MAX_OPTIONS);
    if (cleanOptions.some((o) => o.length > MAX_OPTION_LEN)) {
      return `❌ Setiap opsi maksimal ${MAX_OPTION_LEN} karakter.`;
    }
  }

  const chatIdStr = String(chatId);
  const sendOpts = threadId ? { message_thread_id: threadId } : {};

  // Jika include_desktop aktif, kirim screenshot layar terkini & siapkan link Live Desktop (noVNC)
  let desktopUrl = null;
  if (include_desktop) {
    try {
      const shot = await captureDesktopScreenshot({ withGrid: false });
      if (ctx.bot.sendPhoto) {
        await ctx.bot.sendPhoto(
          chatIdStr,
          shot.rawBuffer,
          {
            ...sendOpts,
            caption: "🖥️ Tampilan layar komputer saat ini (menunggu input/tindakanmu)"
          },
          { filename: "desktop_prompt.png", contentType: "image/png" }
        );
        if (typeof onMediaSent === "function") onMediaSent("photo");
      }
    } catch (err) {
      console.warn("[AskUser] Gagal mengirim screenshot desktop:", err.message);
    }

    try {
      const tunnel = await startDesktopTunnel(120);
      desktopUrl = tunnel?.url || null;
    } catch (err) {
      console.warn("[AskUser] Gagal membuka tunnel desktop:", err.message);
    }

    if (cleanOptions.length === 0) {
      cleanOptions = ["✅ Sudah selesai, lanjutkan", "🛑 Batalkan"];
    }
  }

  const q = question.trim().slice(0, MAX_QUESTION_LEN);
  const timeoutMin = clampTimeout(timeout_minutes);
  const token = crypto.randomBytes(6).toString("hex");

  const header = `❓ *Pertanyaan Agent*${entryCount(sessionId) > 0 ? " (antrean)" : ""}`;
  const desktopLine = desktopUrl
    ? `\n\n🖥️ *Live Komputer (Klik untuk buka layar):*\n${desktopUrl}`
    : "";
  const hint = cleanOptions.length
    ? `\n\n_Ketuk tombol di bawah, atau langsung balas dengan teks / kode OTP / foto / file di chat._`
    : `\n\n_Balas langsung dengan mengetik jawaban / kode OTP, atau kirim foto/file di chat._`;

  const inlineRows = [];
  if (desktopUrl) {
    inlineRows.push([{ text: "🖥️ Buka Layar Komputer (Live)", url: desktopUrl }]);
  }
  for (let i = 0; i < cleanOptions.length; i++) {
    inlineRows.push([{ text: cleanOptions[i], callback_data: `ask:${token}:${i}` }]);
  }

  let sent;
  try {
    sent = await ctx.bot.sendMessage(
      chatIdStr,
      `${header}\n\n${q}${desktopLine}${hint}`,
      {
        ...sendOpts,
        parse_mode: "Markdown",
        ...(inlineRows.length ? { reply_markup: { inline_keyboard: inlineRows } } : {})
      }
    );
  } catch (err) {
    // Markdown bisa ditolak karena karakter aneh di pertanyaan — coba tanpa format.
    try {
      sent = await ctx.bot.sendMessage(
        chatIdStr,
        `${header}\n\n${q}${desktopLine}${hint}`,
        {
          ...sendOpts,
          ...(inlineRows.length ? { reply_markup: { inline_keyboard: inlineRows } } : {})
        }
      );
    } catch (err2) {
      return `❌ Gagal mengirim pertanyaan ke user: ${err2.message}`;
    }
  }

  return await new Promise((resolve) => {
    const entry = {
      token,
      sessionId: String(sessionId || chatIdStr),
      chatId: chatIdStr,
      threadId: threadId || null,
      question: q,
      options: cleanOptions,
      includeDesktop: Boolean(include_desktop),
      resolve,
      messageId: sent?.message_id || null,
      timer: null
    };

    entry.timer = setTimeout(async () => {
      removeEntry(entry);
      await markQuestionClosed(
        entry,
        `\n\n⏱️ _Tidak dijawab dalam ${timeoutMin} menit — kedaluwarsa._`,
        "Tidak ada jawaban (kedaluwarsa)"
      );
      resolve(
        `⏱️ User tidak menjawab dalam ${timeoutMin} menit. ` +
          `Lanjutkan tugas dengan asumsi terbaikmu dan sebutkan asumsi itu secara eksplisit di jawaban akhir.`
      );
    }, timeoutMin * 60_000);

    const list = pendingAsks.get(entry.sessionId) || [];
    list.push(entry);
    pendingAsks.set(entry.sessionId, list);
  });
}

function removeEntry(entry) {
  if (entry.timer) clearTimeout(entry.timer);
  const list = pendingAsks.get(entry.sessionId);
  if (!list) return;
  const idx = list.indexOf(entry);
  if (idx >= 0) list.splice(idx, 1);
  if (list.length === 0) pendingAsks.delete(entry.sessionId);
}

/** Edit pesan pertanyaan: tambahkan baris status dan hapus tombolnya. */
async function markQuestionClosed(entry, suffix, fallbackNote) {
  if (!entry.messageId || !ctx.bot) return;
  try {
    await ctx.bot.editMessageText(`${entry.question}${suffix}`, {
      chat_id: entry.chatId,
      message_id: entry.messageId,
      ...(entry.threadId ? { message_thread_id: entry.threadId } : {}),
      reply_markup: { inline_keyboard: [] }
    });
  } catch (_) {
    // Pesan mungkin sudah dihapus manual; tidak fatal.
  }
  void fallbackNote;
}

/** Jawaban lewat klik tombol inline. Dipanggil dari bot/callbacks.js. */
async function handleAskCallback(query) {
  const bot = ctx.bot;
  const [, token, idxRaw] = String(query.data).split(":");
  const idx = Number(idxRaw);

  let hit = null;
  for (const list of pendingAsks.values()) {
    const found = list.find((e) => e.token === token);
    if (found) {
      hit = found;
      break;
    }
  }

  if (!hit || !Number.isInteger(idx) || idx < 0 || idx >= hit.options.length) {
    return bot.answerCallbackQuery(query.id, { text: "Pertanyaan ini sudah tidak menunggu jawaban." });
  }

  const answer = hit.options[idx];
  removeEntry(hit);
  await markQuestionClosed(hit, `\n\n✅ _Jawaban tercatat: ${answer}_`, answer);
  try {
    await bot.answerCallbackQuery(query.id, { text: `✅ Jawaban terkirim ke agent.` });
  } catch (_) {}
  hit.resolve(`✅ User menjawab: "${answer}"`);
}

/**
 * Jawaban lewat pesan teks berikutnya. Dipanggil dari bot/handlers.js sebelum pesan
 * masuk antrean AI. @returns {boolean} true jika teks dipakai sebagai jawaban.
 */
function takePendingAskAnswer(sessionId, text) {
  // Hanya pesan teks yang boleh menjawab lewat fungsi ini. Event "message" di bot/handlers.js
  // juga menyala untuk foto/video/dokumen yang tidak punya .text; kiriman foto/dokumen ditangani
  // secara khusus oleh takePendingAskMedia setelah filenya disimpan ke /workspace/uploads/.
  if (typeof text !== "string" || !text.trim()) return false;

  const list = pendingAsks.get(String(sessionId));
  if (!list || list.length === 0) return false;
  const entry = list.shift();
  if (list.length === 0) pendingAsks.delete(entry.sessionId);

  if (entry.timer) clearTimeout(entry.timer);
  const answer = String(text || "").trim().slice(0, 2000);
  markQuestionClosed(
    entry,
    `\n\n✅ _Jawaban tercatat (teks): ${answer.slice(0, 120)}${answer.length > 120 ? "…" : ""}_`,
    answer
  );
  entry.resolve(`✅ User menjawab lewat teks: "${answer}"`);
  return true;
}

/**
 * Jawaban lewat kiriman Foto atau Dokumen/File saat ask_user sedang menunggu.
 * Dipanggil dari bot/handlers.js setelah file disimpan ke /workspace/uploads/ (tanpa masuk turnQueue).
 * @param {string} sessionId
 * @param {{ type: string, fileName: string, savedFilePath: string, sandboxPath: string, caption?: string }} media
 * @returns {boolean}
 */
function takePendingAskMedia(sessionId, media = {}) {
  const list = pendingAsks.get(String(sessionId));
  if (!list || list.length === 0) return false;
  const entry = list.shift();
  if (list.length === 0) pendingAsks.delete(entry.sessionId);

  if (entry.timer) clearTimeout(entry.timer);
  const label = media.type === "photo" ? "Foto" : "File/Dokumen";
  const cap = String(media.caption || "").trim();
  markQuestionClosed(
    entry,
    `\n\n✅ _Jawaban tercatat (${label}): ${media.fileName}${cap ? ` — "${cap.slice(0, 80)}"` : ""}_`,
    media.fileName
  );
  entry.resolve(
    `✅ User menjawab dengan mengirim ${label}: "${media.fileName}"\n` +
      `• Path Host: ${media.savedFilePath}\n` +
      `• Path Sandbox: ${media.sandboxPath}` +
      (cap ? `\n• Pesan/Caption User: "${cap}"` : "")
  );
  return true;
}

/** Batalkan semua pertanyaan tertunda pada sesi (dipakai /stop). */
function cancelPendingAsks(sessionId, reason = "dibatalkan") {
  const list = pendingAsks.get(String(sessionId));
  if (!list) return 0;
  const entries = list.splice(0);
  pendingAsks.delete(String(sessionId));
  for (const entry of entries) {
    if (entry.timer) clearTimeout(entry.timer);
    markQuestionClosed(entry, `\n\n🛑 _${reason}._`, reason);
    entry.resolve(`❌ Pertanyaan ke user dibatalkan (${reason}). Lanjutkan tanpa jawaban user.`);
  }
  return entries.length;
}

module.exports = {
  toolAskUser,
  handleAskCallback,
  takePendingAskAnswer,
  takePendingAskMedia,
  cancelPendingAsks,
  pendingAskCount: entryCount,
  _resetForTests: () => pendingAsks.clear()
};
