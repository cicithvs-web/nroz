/**
 * bot/send.js — Pengiriman pesan ke Telegram dengan fallback yang aman.
 *
 * Semua pesan teks lewat sendMessageSafe: kalau Telegram menolak Markdown (misalnya `_`
 * yang tidak berpasangan dari jawaban AI), pesan dikirim ulang sebagai teks biasa, jadi
 * jawaban tidak pernah hilang hanya karena format.
 */

const ctx = require("./context");
const { splitMessage, hasMarkdownTable, isParseError, isTooLongError, MESSAGE_LIMIT } = require("./text");

/** sendMessage dengan fallback: Markdown gagal -> teks biasa; terlalu panjang -> dipecah. */
async function sendMessageSafe(chatId, text, options = {}) {
  try {
    return await ctx.bot.sendMessage(chatId, text, options);
  } catch (err) {
    if (isParseError(err) && options.parse_mode) {
      console.warn("[Send] Markdown ditolak Telegram, kirim ulang sebagai teks biasa:", err.message);
      const plain = { ...options };
      delete plain.parse_mode;
      return await ctx.bot.sendMessage(chatId, text, plain);
    }
    if (isTooLongError(err) && text.length > 1000) {
      let last;
      for (const part of splitMessage(text, Math.floor(text.length / 2))) {
        last = await sendMessageSafe(chatId, part, options);
      }
      return last;
    }
    throw err;
  }
}

/** Tabel native Telegram (Bot API 10.1+). */
async function sendRichMessage(chatId, markdownText, options = {}) {
  const form = {
    chat_id: chatId,
    rich_message: JSON.stringify({ markdown: markdownText })
  };
  if (options.reply_to_message_id) {
    form.reply_parameters = JSON.stringify({ message_id: options.reply_to_message_id });
  }
  if (options.message_thread_id) {
    form.message_thread_id = options.message_thread_id;
  }
  return await ctx.bot._request("sendRichMessage", { form });
}

/** Kirim teks panjang: dipecah per ~4000 karakter dengan code block tetap utuh. */
async function sendLongMessage(chatId, text, options = {}) {
  const chunks = splitMessage(text, MESSAGE_LIMIT);
  let lastSent;

  for (let i = 0; i < chunks.length; i++) {
    const isLast = i === chunks.length - 1;
    const suffix = isLast ? "" : "\n\n_...bersambung ke pesan selanjutnya_";
    const chunkOptions = { ...options };
    if (i > 0) delete chunkOptions.reply_to_message_id; // Hanya potongan pertama yang me-reply pesan user

    const content = chunks[i] + suffix;
    let sentAsRich = false;
    if (hasMarkdownTable(content)) {
      try {
        lastSent = await sendRichMessage(chatId, content, chunkOptions);
        sentAsRich = true;
      } catch (err) {
        console.warn("[Rich Table Error] Fallback ke sendMessage biasa:", err.message);
      }
    }
    if (!sentAsRich) lastSent = await sendMessageSafe(chatId, content, chunkOptions);

    if (!isLast) await new Promise((r) => setTimeout(r, 500));
  }
  return lastSent;
}

/** Opsi kirim: reply ke pesan user dan message_thread_id (Supergroup Topics). */
function getSendOptions(msg) {
  const options = { parse_mode: "Markdown" };
  if (msg && msg.reply_to_message) {
    const isTopicRoot = msg.message_thread_id && msg.reply_to_message.message_id === msg.message_thread_id;
    if (!isTopicRoot) options.reply_to_message_id = msg.message_id;
  }
  if (msg && msg.message_thread_id) options.message_thread_id = msg.message_thread_id;
  return options;
}

/** Balasan cepat yang menghormati forum topic. */
async function replyText(msg, text, extraOpts = {}) {
  const options = { parse_mode: "Markdown", ...extraOpts };
  if (msg.message_thread_id) options.message_thread_id = msg.message_thread_id;
  return await sendMessageSafe(msg.chat.id, text, options);
}

// === TELEGRAM BOT API 9.5+ NATIVE STREAMING DRAFT ===
const draftCooldowns = new Map(); // chatId -> timestamp boleh kirim lagi

async function sendDraft(chatId, draftId, text, threadId = null) {
  const now = Date.now();
  if (draftCooldowns.has(chatId) && now < draftCooldowns.get(chatId)) return;
  if (draftCooldowns.size > 5000) draftCooldowns.clear();

  try {
    const form = { chat_id: chatId, draft_id: draftId, text };
    if (threadId) form.message_thread_id = threadId;
    await ctx.bot._request("sendMessageDraft", { form });
  } catch (err) {
    if (err.message && err.message.includes("429")) {
      const retryMatch = err.message.match(/retry after (\d+)/i);
      const waitSec = retryMatch ? parseInt(retryMatch[1], 10) : 5;
      draftCooldowns.set(chatId, Date.now() + waitSec * 1000);
    }
  }
}

/** Indikator "mengetik..." tiap 4 detik. Error (chat diblokir, jaringan) diabaikan. */
function startTyping(chatId, threadId = null) {
  const opts = threadId ? { message_thread_id: threadId } : undefined;
  const ping = () => {
    ctx.bot.sendChatAction(chatId, "typing", opts).catch(() => {});
  };
  ping();
  return setInterval(ping, 4050);
}

function stopTyping(interval) {
  if (interval) clearInterval(interval);
}

module.exports = {
  sendMessageSafe,
  sendRichMessage,
  sendLongMessage,
  getSendOptions,
  replyText,
  sendDraft,
  startTyping,
  stopTyping
};
