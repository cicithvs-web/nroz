/**
 * bot/access.js — Siapa yang boleh dilayani: approval chat pribadi, filter pesan grup, ID sesi.
 */

const ctx = require("./context");
const { OWNER_ID } = require("./config");
const { replyText } = require("./send");
const { getUserAccess, setUserAccess } = require("../onlyxHelper.js");

// Session ID unik: jika di supergroup topic, pisahkan per topic thread
function getSessionId(msg) {
  if (msg.message_thread_id) {
    return `${msg.chat.id}_t${msg.message_thread_id}`;
  }
  return String(msg.chat.id);
}

// Helper abaikan pesan yang sengaja diawali simbol diskusi manusia (//, !, atau /)
function hasIgnorePrefix(text) {
  if (!text) return false;
  const trimmed = text.trim();
  return trimmed.startsWith("//") || trimmed.startsWith("!") || trimmed.startsWith("/");
}

// Helper filter pesan di grup / supergroup
function shouldIgnoreGroupMessage(msg, textContent) {
  if (msg.chat.type !== "group" && msg.chat.type !== "supergroup") {
    return false; // Chat pribadi selalu diproses
  }

  // Cek apakah pesan berada di Forum Topic
  const isForumTopic = Boolean(
    msg.message_thread_id || 
    msg.is_topic_message || 
    msg.chat?.is_forum
  );

  const BOT_USERNAME = ctx.botUsername;
  const mention = `@${BOT_USERNAME}`;
  const isMentioned = Boolean(
    textContent && textContent.toLowerCase().includes(mention.toLowerCase())
  );

  // 1. Cek jika user me-reply pesan
  if (msg.reply_to_message) {
    const replyMsg = msg.reply_to_message;
    const replyFrom = replyMsg.from;
    const isReplyToBot = replyFrom?.is_bot || (replyFrom?.username && replyFrom.username.toLowerCase() === BOT_USERNAME.toLowerCase());

    // PENTING: Cek jika me-reply pesan pembuatan topik / service message topik (BUKAN percakapan sesama manusia)
    const isTopicCreationMsg = Boolean(
      replyMsg.forum_topic_created ||
      (msg.message_thread_id && replyMsg.message_id === msg.message_thread_id)
    );

    // Jika me-reply sesama member manusia (bukan bot, bukan topic header):
    if (!isReplyToBot && !isTopicCreationMsg && !isMentioned) {
      return true; // Abaikan: sesama manusia sedang saling berdiskusi
    }
  }

  // 2. Di grup biasa / general chat tanpa forum topic, wajib tag bot atau reply bot
  if (!isForumTopic) {
    const repliedToBot = msg.reply_to_message?.from?.username && msg.reply_to_message.from.username.toLowerCase() === BOT_USERNAME.toLowerCase();
    if (!isMentioned && !repliedToBot) {
      return true;
    }
  }

  return false;
}

// === SISTEM AKSES PENGGUNA (APPROVAL KHUSUS CHAT PRIBADI) ===
async function checkUserAccess(msg) {
  // Jika di grup atau supergroup, semua langsung diizinkan
  if (msg.chat.type !== "private") return { allowed: true };

  const userId = String(msg.from?.id || "");
  if (!userId) return { allowed: false, status: "rejected" };
  if (userId === OWNER_ID) return { allowed: true };

  const access = await getUserAccess(userId);
  if (access && access.status === "approved") {
    return { allowed: true };
  }
  if (access && access.status === "rejected") {
    return { allowed: false, status: "rejected" };
  }
  if (access && access.status === "pending") {
    return { allowed: false, status: "pending" };
  }

  // Pengguna baru pertama kali chat -> Daftarkan sebagai pending & beri notifikasi ke Owner
  const name = [msg.from.first_name, msg.from.last_name].filter(Boolean).join(" ") || "Tanpa Nama";
  const username = msg.from.username ? `@${msg.from.username}` : "(tanpa username)";
  await setUserAccess(userId, "pending", { name, username });

  try {
    await ctx.bot.sendMessage(
      OWNER_ID,
      `🔔 *Permintaan Akses Pengguna Baru*\n\n` +
      `Ada pengguna baru yang ingin menggunakan Nroz AI di chat pribadi:\n\n` +
      `• *Nama:* ${name}\n` +
      `• *Username:* ${username}\n` +
      `• *User ID:* \`${userId}\`\n\n` +
      `Silakan tentukan persetujuan akses:`,
      {
        parse_mode: "Markdown",
        reply_markup: {
          inline_keyboard: [
            [
              { text: "✅ Terima", callback_data: `acc_app_${userId}` },
              { text: "❌ Tolak", callback_data: `acc_rej_${userId}` }
            ]
          ]
        }
      }
    );
  } catch (err) {
    console.error("[Access] Gagal kirim notif approval ke owner:", err.message);
  }

  return { allowed: false, status: "new_pending" };
}

async function handleAccessDenied(msg, status) {
  if (status === "new_pending") {
    await replyText(
      msg,
      "👋 *Halo!*\n\nPermintaan akses Anda telah dikirimkan ke Owner bot.\nMohon tunggu konfirmasi persetujuan ya!",
      { parse_mode: "Markdown" }
    );
  } else if (status === "pending") {
    await replyText(
      msg,
      "⏳ *Menunggu Persetujuan*\n\nAkses Anda masih dalam antrean persetujuan Owner bot. Harap bersabar ya!",
      { parse_mode: "Markdown" }
    );
  } else if (status === "rejected") {
    await replyText(
      msg,
      "⛔ *Akses Ditolak*\n\nMaaf, permintaan akses Anda ke bot ini telah ditolak oleh Owner.",
      { parse_mode: "Markdown" }
    );
  }
}

module.exports = { getSessionId, hasIgnorePrefix, shouldIgnoreGroupMessage, checkUserAccess, handleAccessDenied };
