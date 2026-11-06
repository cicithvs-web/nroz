/**
 * tools/ask.js — Tool ask_user: agent boleh bertanya ke user di tengah tugas.
 *
 * Pertanyaan tampil sebagai pesan Telegram dengan tombol inline (kalau diberi opsi).
 * Jawaban masuk lewat dua jalur: klik tombol (bot/callbacks.js) atau pesan teks berikutnya
 * yang diintersep di bot/handlers.js SEBELUM masuk antrean giliran — jadi tugas yang
 * sedang menunggu tidak deadlock dengan antrean per sesi. Tidak ada jawaban sampai
 * timeout dianggap "tidak dijawab", dan agent melanjutkan dengan asumsi terbaik.
 */

const crypto = require("crypto");
const ctx = require("../bot/context");

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
 * @returns {Promise<string>} hasil untuk model: jawaban user atau status timeout.
 */
async function toolAskUser({ question, options, timeout_minutes, sessionId, chatId, threadId }) {
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

  const q = question.trim().slice(0, MAX_QUESTION_LEN);
  const timeoutMin = clampTimeout(timeout_minutes);
  const token = crypto.randomBytes(6).toString("hex");
  const chatIdStr = String(chatId);
  const sendOpts = threadId ? { message_thread_id: threadId } : {};

  const header = `❓ *Pertanyaan Agent*${entryCount(sessionId) > 0 ? " (antrean)" : ""}`;
  const hint = cleanOptions.length
    ? `\n\n_Ketuk salah satu tombol di bawah, atau langsung ketik jawabanmu di chat._`
    : `\n\n_Balas dengan mengetik jawabanmu langsung di chat._`;

  let sent;
  try {
    sent = await ctx.bot.sendMessage(
      chatIdStr,
      `${header}\n\n${q}${hint}`,
      {
        ...sendOpts,
        parse_mode: "Markdown",
        ...(cleanOptions.length
          ? { reply_markup: { inline_keyboard: cleanOptions.map((label, i) => [{ text: label, callback_data: `ask:${token}:${i}` }]) } }
          : {})
      }
    );
  } catch (err) {
    // Markdown bisa ditolak karena karakter aneh di pertanyaan — coba tanpa format.
    try {
      sent = await ctx.bot.sendMessage(chatIdStr, `${header}\n\n${q}${hint}`, sendOpts);
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
    if (found) { hit = found; break; }
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
  const list = pendingAsks.get(String(sessionId));
  if (!list || list.length === 0) return false;
  const entry = list.shift();
  if (list.length === 0) pendingAsks.delete(entry.sessionId);

  if (entry.timer) clearTimeout(entry.timer);
  const answer = String(text || "").trim().slice(0, 2000);
  markQuestionClosed(entry, `\n\n✅ _Jawaban tercatat (teks): ${answer.slice(0, 120)}${answer.length > 120 ? "…" : ""}_`, answer);
  entry.resolve(`✅ User menjawab lewat teks: "${answer}"`);
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
  cancelPendingAsks,
  pendingAskCount: entryCount,
  _resetForTests: () => pendingAsks.clear()
};
