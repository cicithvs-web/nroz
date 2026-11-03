/**
 * bot/agentLoop.js — Loop tool-calling AI (maraton sampai MAX_TOOL_ROUNDS langkah).
 *
 * Kalau giliran berhenti sebelum ada jawaban final (batas langkah, /stop, AI gagal dihubungi),
 * langkah yang sudah dikerjakan disimpan sebagai checkpoint (.memory/last_turn.json) dan ikut
 * masuk ke system prompt giliran berikutnya, jadi "lanjutkan" meneruskan dari titik terakhir.
 */

const { getAllToolDefinitions, executeTool, describeToolCall } = require("../agentTools.js");
const { saveMemory } = require("../dbHelper.js");
const { appendRawLog, saveTurnCheckpoint, clearTurnCheckpoint } = require("../workspaceMemoryManager.js");
const ctx = require("./context");
const { getClient, getConfig } = require("./config");
const { cleanAnswer, cleanFileTags, cleanDraftPreview } = require("./text");
const { sendLongMessage, getSendOptions, replyText, sendDraft, stopTyping } = require("./send");
const { handleGeneratedFiles } = require("./fileDelivery");
const { triggerBackgroundCompaction } = require("./compaction");

// Sesi AI yang sedang berjalan (untuk /stop): sessionId -> { cancelled: boolean }
const activeTurnSessions = new Map();

/**
 * Memangkas output tool lama (sliding window) agar context window tidak membengkak
 * dalam tugas maraton. Hanya `keepRecent` output tool terbaru yang utuh.
 */
function pruneToolOutputsSlidingWindow(messages, keepRecent = 8) {
  let toolCount = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role === "tool") {
      toolCount++;
      if (toolCount > keepRecent && typeof m.content === "string" && m.content.length > 150) {
        const firstLine = m.content.split("\n").find((l) => l.trim()) || "Selesai";
        const statusText = m.content.includes("❌") ? "[Hasil lampau: Error]" : "[Hasil lampau: Selesai]";
        m.content = `${statusText} — ${firstLine.slice(0, 100)}`;
      }
    }
  }
}

const EMOJI_RE = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu;

/** Satu baris ringkas hasil tool untuk checkpoint dan draft progres. */
function firstResultLine(result) {
  const line = String(result || "").split("\n").find((l) => l.trim()) || "";
  return line.replace(EMOJI_RE, "").trim().slice(0, 120);
}

function isFailedResult(result) {
  const t = String(result || "").trimStart();
  return t.startsWith("❌") || t.startsWith("⛔") || t.startsWith("⏱️");
}

async function executeAICompletionAndReply({ msg, sessionId, messages, userPromptForFiles, typing }) {
  const chatId = msg.chat.id;
  const isPrivate = msg.chat?.type === "private" || chatId > 0;
  const client = getClient();
  const model = getConfig().model;
  let rawAnswer = "";
  const turnMediaSent = { photos: 0, files: 0 };

  // Loop tool-calling maraton (default 100 iterasi ala Kiro/Qoder CLI)
  const MAX_TOOL_ROUNDS = Number(process.env.MAX_TOOL_ROUNDS) || 100;
  const currentMessages = [...messages];
  let finalAnswerReceived = false;
  // Satu draft dipakai sepanjang giliran ini, jadi user melihat perintah yang sebenarnya
  // dijalankan AI (bukan hanya nama tool) tanpa menambah pesan baru ke chat.
  const turnDraftId = Math.floor(Math.random() * 2000000000) + 1;
  let stepIndex = 0;
  const steps = [];
  let lastAssistantNote = "";

  const checkpoint = (status) => {
    if (steps.length === 0) return;
    saveTurnCheckpoint(sessionId, { status, userRequest: userPromptForFiles, steps, lastAssistantNote });
  };

  const turnState = { cancelled: false };
  activeTurnSessions.set(sessionId, turnState);

  try {
    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
      // Cek apakah user mengirim perintah /stop atau /cancel di tengah jalan
      if (turnState.cancelled) {
        console.log(`[Tool Loop] Dihentikan oleh user (/stop) di sesi ${sessionId}`);
        stopTyping(typing);
        checkpoint("stopped");
        await replyText(
          msg,
          "🛑 Pekerjaan mandiri AI berhasil dihentikan atas permintaanmu." +
            (steps.length ? `\n\n${steps.length} langkah yang sudah dikerjakan tercatat; ketik *lanjutkan* untuk meneruskan.` : "")
        );
        return;
      }

      // Early Warning 10 langkah sebelum batas maraton
      if (round === MAX_TOOL_ROUNDS - 10) {
        currentMessages.push({
          role: "system",
          content: `[PERINGATAN MARATON: Kamu sudah menggunakan ${round} dari batas ${MAX_TOOL_ROUNDS} langkah. Segera simpan progres pekerjaanmu ke .memory/project_context.md, selesaikan langkah akhir, dan berikan laporan lengkap ke user.]`
        });
      }

      let isStreamSuccess = false;
      let assistantContent = "";
      let toolCalls = [];

      // 1. Coba streaming terlebih dahulu
      try {
        const stream = await client.chat.completions.create({
          model,
          messages: currentMessages,
          tools: getAllToolDefinitions(),
          tool_choice: "auto",
          stream: true
        });

        const draftId = isPrivate ? Math.floor(Math.random() * 2000000000) + 1 : null;
        let lastDraftTime = 0;
        const toolCallAccumulator = {};

        for await (const chunk of stream) {
          const choice = chunk.choices[0];
          if (!choice) continue;

          const delta = choice.delta;
          if (delta.content) {
            assistantContent += delta.content;

            // Preview draft (streaming ke Telegram)
            if (isPrivate && assistantContent.length > 0) {
              const now = Date.now();
              if (now - lastDraftTime > 1000) {
                lastDraftTime = now;
                const preview = cleanDraftPreview(assistantContent).trim();
                if (preview) {
                  const previewText = preview.length > 4000 ? preview.slice(-4000) : preview;
                  await sendDraft(chatId, draftId, previewText, msg.message_thread_id);
                }
              }
            }
          }

          if (delta.tool_calls) {
            for (const tc of delta.tool_calls) {
              const idx = tc.index;
              if (!toolCallAccumulator[idx]) {
                toolCallAccumulator[idx] = { id: tc.id || "", type: "function", function: { name: "", arguments: "" } };
              }
              if (tc.id) toolCallAccumulator[idx].id = tc.id;
              if (tc.function?.name) toolCallAccumulator[idx].function.name += tc.function.name;
              if (tc.function?.arguments) toolCallAccumulator[idx].function.arguments += tc.function.arguments;
            }
          }
        }

        toolCalls = Object.values(toolCallAccumulator);
        isStreamSuccess = true;
      } catch (streamErr) {
        console.warn(`[Stream AI] Streaming gagal: ${streamErr.message}`);
      }

      // 2. Fallback non-streaming jika stream gagal
      if (!isStreamSuccess) {
        try {
          const fallbackRes = await client.chat.completions.create({
            model,
            messages: currentMessages,
            tools: getAllToolDefinitions(),
            tool_choice: "auto",
            stream: false
          });
          const choice = fallbackRes.choices[0];
          assistantContent = choice.message?.content || "";
          toolCalls = choice.message?.tool_calls || [];
        } catch (fallbackErr) {
          console.error("[AI Fallback] Gagal total:", fallbackErr.message);
          stopTyping(typing);
          checkpoint("error");
          await replyText(
            msg,
            "Terjadi kesalahan saat menghubungi AI." +
              (steps.length ? `\n\n${steps.length} langkah yang sudah dikerjakan tercatat; ketik *lanjutkan* untuk meneruskan.` : "")
          );
          return;
        }
      }

      // Tidak ada tool call = jawaban final
      if (!toolCalls || toolCalls.length === 0) {
        rawAnswer = assistantContent;
        finalAnswerReceived = true;
        break;
      }

      if (assistantContent.trim()) lastAssistantNote = assistantContent.trim();

      const assistantMsg = { role: "assistant", content: assistantContent || null, tool_calls: toolCalls };
      currentMessages.push(assistantMsg);

      for (const toolCall of toolCalls) {
        const fnName = toolCall.function?.name;
        let fnArgs = {};
        try {
          fnArgs = JSON.parse(toolCall.function?.arguments || "{}");
        } catch {
          fnArgs = {};
        }

        stepIndex++;
        const langkah = describeToolCall(fnName, fnArgs);
        if (isPrivate) {
          const actionText = langkah.startsWith("men") || langkah.startsWith("mem") || langkah.startsWith("ber")
            ? `Sedang ${langkah}...`
            : `Sedang melakukan ${langkah}...`;
          await sendDraft(chatId, turnDraftId, actionText, msg.message_thread_id);
        }

        console.log(`[Agent Tool] Executing: ${fnName}(${JSON.stringify(fnArgs).slice(0, 200)})`);
        const result = await executeTool(fnName, fnArgs, {
          sessionId,
          chatId,
          threadId: msg.message_thread_id,
          client,
          model,
          bot: ctx.bot,
          onMediaSent: (type) => {
            if (type === "photo") turnMediaSent.photos++;
            if (type === "file") turnMediaSent.files++;
          },
          onSubagentProgress: async ({ role, tool, args }) => {
            if (isPrivate) {
              await sendDraft(
                chatId,
                turnDraftId,
                `Subagent (${role}): sedang ${describeToolCall(tool, args)}...`,
                msg.message_thread_id
              );
            }
          }
        });
        console.log(`[Agent Tool] Result (${fnName}): ${result.slice(0, 200)}...`);

        const ok = !isFailedResult(result);
        const ringkas = firstResultLine(result);
        steps.push({ n: stepIndex, desc: langkah.slice(0, 140), ok, result: ringkas });

        if (isPrivate) {
          const prefix = ok ? "Selesai: " : "Gagal: ";
          const draftDetail = ringkas ? `${prefix}${langkah} (${ringkas.slice(0, 70)})` : `${prefix}${langkah}...`;
          await sendDraft(chatId, turnDraftId, draftDetail, msg.message_thread_id);
        }

        currentMessages.push({ role: "tool", tool_call_id: toolCall.id, content: result });
      }

      pruneToolOutputsSlidingWindow(currentMessages, 8);
    }

    stopTyping(typing);

    // 3. Bersihkan jawaban dan kirim pesan permanen
    let answer = cleanAnswer(cleanFileTags(rawAnswer));
    if (!answer && rawAnswer) answer = rawAnswer;
    if (finalAnswerReceived) {
      clearTurnCheckpoint(sessionId);
      if (!answer) answer = "(AI mengembalikan jawaban kosong)";
    } else {
      console.warn(`[Tool Loop] Batas maraton ${MAX_TOOL_ROUNDS} ronde tool tercapai.`);
      checkpoint("limit");
      if (!answer) {
        answer = `⏱️ *Batas Maraton (${MAX_TOOL_ROUNDS} langkah) tercapai.*\n\n` +
          `Pekerjaan telah berjalan hingga langkah ke-${stepIndex}. Seluruh file dan perubahan tersimpan aman di workspace, ` +
          `dan daftar langkahnya sudah dicatat.\n\n` +
          `Ketik *"lanjutkan"* jika kamu ingin saya meneruskan tugas ini dari titik terakhir.`;
      }
    }

    const sent = await sendLongMessage(chatId, answer, getSendOptions(msg));
    if (sent && sent.message_id) {
      await saveMemory(sessionId, "assistant", answer, sent.message_id);
      appendRawLog(sessionId, "assistant", answer, { messageId: sent.message_id });
    } else {
      await saveMemory(sessionId, "assistant", answer);
      appendRawLog(sessionId, "assistant", answer);
    }

    // 4. Otomatis buat & kirim file atau ZIP jika diminta
    await handleGeneratedFiles(chatId, msg, rawAnswer, userPromptForFiles, turnMediaSent);

    // 5. Padatkan riwayat ke Summary di background jika obrolan sudah banyak
    triggerBackgroundCompaction(sessionId);
  } finally {
    // Jangan hapus token giliran lain yang mungkin sudah menggantikan giliran ini.
    if (activeTurnSessions.get(sessionId) === turnState) activeTurnSessions.delete(sessionId);
  }
}

module.exports = {
  activeTurnSessions,
  pruneToolOutputsSlidingWindow,
  executeAICompletionAndReply,
  firstResultLine,
  isFailedResult
};
