/**
 * bot/callbacks.js — Tombol inline: persetujuan akses (owner) dan pembatalan tugas (/tasks, pengingat berulang).
 */

const ctx = require("./context");
const { OWNER_ID } = require("./config");
const { getUserAccess, setUserAccess } = require("../onlyxHelper.js");
const { getTask, removeTask } = require("../schedulerManager.js");
const { buildTasksMessage } = require("./commands");
const { getSessionId } = require("./access");

/** Sesi tempat tombol ditekan; aturan sama dengan getSessionId untuk pesan biasa. */
function sessionIdFromQuery(query) {
  return query.message ? getSessionId(query.message) : null;
}

async function handleTaskCancel(query) {
  const bot = ctx.bot;
  const taskId = query.data.slice("task_cancel:".length);
  const sessionId = sessionIdFromQuery(query);
  const task = getTask(taskId);

  // Tugas hanya boleh dibatalkan dari chat/topic pemiliknya.
  if (!task || !sessionId || task.sessionId !== sessionId) {
    return bot.answerCallbackQuery(query.id, { text: "Tugas ini sudah tidak ada atau bukan milik chat ini." });
  }

  removeTask(sessionId, taskId);
  await bot.answerCallbackQuery(query.id, { text: "✅ Tugas dibatalkan." });

  const chat_id = query.message.chat.id;
  const message_id = query.message.message_id;
  const isTaskList = /Daftar Tugas/.test(query.message.text || "");
  try {
    if (isTaskList) {
      // Perbarui daftar /tasks di tempat
      const { text, keyboard } = buildTasksMessage(sessionId);
      await bot.editMessageText(text, {
        chat_id,
        message_id,
        parse_mode: "Markdown",
        reply_markup: { inline_keyboard: keyboard }
      });
    } else {
      // Pesan pengingat berulang: hapus tombolnya dan beri keterangan
      await bot.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id, message_id });
      await bot.sendMessage(chat_id, "🛑 Pengingat berulang ini sudah dihentikan.", {
        reply_to_message_id: message_id,
        ...(query.message.message_thread_id ? { message_thread_id: query.message.message_thread_id } : {})
      });
    }
  } catch (err) {
    console.warn("[Tasks] Gagal memperbarui pesan setelah pembatalan:", err.message);
  }
}

async function handleAccessCallback(query) {
  const senderId = String(query.from.id);
  if (senderId !== OWNER_ID) {
    return ctx.bot.answerCallbackQuery(query.id, {
      text: "⛔ Hanya Owner yang berhak menentukan persetujuan akses.",
      show_alert: true
    });
  }

  if (query.data.startsWith("acc_app_")) {
    const targetUserId = query.data.replace("acc_app_", "");
    const userAccess = await getUserAccess(targetUserId);
    const name = userAccess?.name || targetUserId;

    await setUserAccess(targetUserId, "approved", userAccess || {});
    await ctx.bot.answerCallbackQuery(query.id, { text: "✅ Akses pengguna telah disetujui!" });

    try {
      await ctx.bot.editMessageText(
        `✅ *Akses Disetujui*\n\n` +
        `Pengguna *${name}* (\`${targetUserId}\`) telah diizinkan menggunakan bot.`,
        {
          chat_id: query.message.chat.id,
          message_id: query.message.message_id,
          parse_mode: "Markdown"
        }
      );
    } catch {}

    try {
      await ctx.bot.sendMessage(
        targetUserId,
        "🎉 *Kabar baik!*\n\nPermintaan akses Anda telah disetujui oleh Owner. Sekarang Anda dapat menggunakan seluruh fitur Nroz AI!\n\nKetik /start atau kirim pesan untuk memulai obrolan.",
        { parse_mode: "Markdown" }
      );
    } catch (e) {
      console.warn(`[Access] Gagal kirim notifikasi persetujuan ke user ${targetUserId}:`, e.message);
    }
  } else if (query.data.startsWith("acc_rej_")) {
    const targetUserId = query.data.replace("acc_rej_", "");
    const userAccess = await getUserAccess(targetUserId);
    const name = userAccess?.name || targetUserId;

    await setUserAccess(targetUserId, "rejected", userAccess || {});
    await ctx.bot.answerCallbackQuery(query.id, { text: "❌ Akses pengguna telah ditolak." });

    try {
      await ctx.bot.editMessageText(
        `❌ *Akses Ditolak*\n\n` +
        `Permintaan dari *${name}* (\`${targetUserId}\`) telah ditolak.`,
        {
          chat_id: query.message.chat.id,
          message_id: query.message.message_id,
          parse_mode: "Markdown"
        }
      );
    } catch {}

    try {
      await ctx.bot.sendMessage(
        targetUserId,
        "⛔ *Pemberitahuan*\n\nMaaf, permintaan akses Anda ke bot ini telah ditolak oleh Owner.",
        { parse_mode: "Markdown" }
      );
    } catch (e) {
      console.warn(`[Access] Gagal kirim notifikasi penolakan ke user ${targetUserId}:`, e.message);
    }
  }
}

function registerCallbacks(bot) {
  bot.on("callback_query", async (query) => {
    if (!query.data) return;
    try {
      if (query.data.startsWith("task_cancel:")) return await handleTaskCancel(query);
      if (query.data.startsWith("acc_app_") || query.data.startsWith("acc_rej_")) return await handleAccessCallback(query);
      await bot.answerCallbackQuery(query.id);
    } catch (err) {
      console.error("[Callback] Error:", err.message);
      bot.answerCallbackQuery(query.id, { text: "Terjadi kesalahan." }).catch(() => {});
    }
  });
}

module.exports = { registerCallbacks, sessionIdFromQuery };
