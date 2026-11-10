/**
 * bot/agentTrigger.js — Membangunkan agent loop tanpa pesan Telegram masuk.
 *
 * Dipakai oleh tugas terjadwal (schedule_agent_task) dan webhook masuk. Alurnya sama
 * dengan pesan user biasa: lewat antrean giliran per sesi, memakai riwayat obrolan,
 * dan jawaban final dikirim ke chat — hanya sumber prompt-nya bukan pesan Telegram.
 */

const { saveMemory, isChatPaused, getHistoryForAI } = require("../dbHelper.js");
const { appendRawLog } = require("../workspaceMemoryManager.js");
const { buildMessagesWithSystem } = require("./prompt");
const { executeAICompletionAndReply } = require("./agentLoop");
const { turnQueue, QueueFullError } = require("./turnQueue");
const { startTyping, stopTyping, sendMessageSafe } = require("./send");
const ctx = require("./context");

/** Batas antrean tugas terpicu per sesi mengikuti antrean giliran biasa. */
const MAX_PENDING = Number(process.env.TURN_QUEUE_MAX) || 5;

/**
 * Pesan sintetis: cukup untuk send.js/getSendOptions/getSessionId — tanpa reply target.
 * chatId negatif berarti grup/supergroup.
 */
function syntheticMsg(chatId, threadId) {
  const id = Number(chatId);
  return {
    chat: { id, type: id > 0 ? "private" : "supergroup" },
    from: { id: 777000, is_bot: true, first_name: "Nroz Scheduler" },
    message_thread_id: threadId || undefined
  };
}

/**
 * Menjalankan satu tugas agent yang dipicu sistem (bukan pesan user).
 * @param {object} o
 * @param {string} o.sessionId
 * @param {string|number} o.chatId
 * @param {number|null} [o.threadId]
 * @param {string} o.sourceLabel  label sumber untuk memori & chat, mis. "Tugas Terjadwal" / "Webhook: nama"
 * @param {string} o.prompt       instruksi pemicu
 * @param {boolean} [o.notify=true] kirim pesan "mulai mengerjakan" ke chat
 * @returns {Promise<{ started: boolean, reason?: string }>}
 */
async function runAgentTask({ sessionId, chatId, threadId = null, sourceLabel, prompt, notify = true }) {
  const sid = String(sessionId);
  const chatIdStr = String(chatId);
  const triggerText = `⏰ [${sourceLabel}]\n\n${String(prompt || "").trim()}`;

  if (await isChatPaused(sid)) {
    return { started: false, reason: "chat dijeda (/resume untuk mengaktifkan kembali)" };
  }

  if (notify) {
    await sendMessageSafe(
      chatIdStr,
      `🤖 *Tugas Agent Terpicu* (${sourceLabel})\n\n${String(prompt || "").trim().slice(0, 800)}` +
        `\n\n_Aku mulai kerjakan sekarang — hasilnya akan dilaporkan di chat ini._`,
      threadId ? { message_thread_id: threadId } : {}
    ).catch((err) => console.warn(`[AgentTrigger] Gagal kirim notif mulai: ${err.message}`));
  }

  try {
    await turnQueue.run(sid, async () => {
      let typing;
      try {
        typing = startTyping(chatIdStr, threadId);

        const history = await getHistoryForAI(sid, 12);
        await saveMemory(sid, "user", triggerText);
        appendRawLog(sid, "user", triggerText);

        const messages = buildMessagesWithSystem(history, sid);
        messages.push({ role: "user", content: triggerText });

        await executeAICompletionAndReply({
          msg: syntheticMsg(chatIdStr, threadId),
          sessionId: sid,
          messages,
          userPromptForFiles: triggerText,
          typing
        });
      } catch (err) {
        console.error(`[AgentTrigger] Gagal menjalankan tugas "${sourceLabel}":`, err.message);
        await sendMessageSafe(
          chatIdStr,
          `⚠️ Tugas terpicu (${sourceLabel}) gagal dijalankan: ${err.message}`,
          threadId ? { message_thread_id: threadId } : {}
        ).catch(() => {});
      } finally {
        stopTyping(typing);
      }
    });
    return { started: true };
  } catch (err) {
    if (err instanceof QueueFullError) {
      return { started: false, reason: `antrean sesi penuh (${err.limit})` };
    }
    return { started: false, reason: err.message };
  }
}

module.exports = { runAgentTask, syntheticMsg };
