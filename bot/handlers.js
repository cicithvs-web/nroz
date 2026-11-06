/**
 * bot/handlers.js — Handler pesan teks, foto, dokumen, dan pesan suara.
 */

const fs = require("fs");
const path = require("path");
const axios = require("axios");
const pdf = require("pdf-parse");
const mammoth = require("mammoth");
const ctx = require("./context");
const { replyText, startTyping, stopTyping } = require("./send");
const { sanitizePath } = require("./text");
const {
  getSessionId,
  hasIgnorePrefix,
  shouldIgnoreGroupMessage,
  checkUserAccess,
  handleAccessDenied
} = require("./access");
const { buildMessagesWithSystem } = require("./prompt");
const { executeAICompletionAndReply } = require("./agentLoop");
const { runQueued } = require("./queuedTurn");
const { saveMemory, getHistoryForAI, getReplyContext, isChatPaused } = require("../dbHelper.js");
const { ensureWorkspaceStructure, appendRawLog } = require("../workspaceMemoryManager.js");
const { transcribeAudio } = require("../voiceManager.js");
const { resolveInWorkspace } = require("../lib/pathGuard");
const { isOwner } = require("./config");
const { handleRestore } = require("./dbBackup");
const { ingestFileBuffer, ingestChatMessage } = require("./knowledge");

/**
 * Menyimpan file kiriman user ke workspace dari HOST. Sandbox bisa menaruh symlink
 * (misal uploads/authorized_keys -> /root/.ssh/authorized_keys), jadi path final diperiksa
 * dan symlink lama dihapus sebelum menulis.
 */
function writeUploadSafely(sessionId, hostPath, data) {
  try {
    if (fs.lstatSync(hostPath).isSymbolicLink()) fs.unlinkSync(hostPath);
  } catch (err) {
    if (err.code !== "ENOENT") throw err;
  }
  const guard = resolveInWorkspace(hostPath, sessionId);
  if (!guard.ok) throw new Error(guard.error);
  fs.writeFileSync(guard.path, data, { flag: "w" });
}

function registerHandlers(bot) {
  // === HANDLER TEKS ===
  bot.on("message", async (msg) => {
    if (msg.from && msg.from.is_bot) return; // [FIX] Mencegah infinite loop bot spam
    if (hasIgnorePrefix(msg.text)) return; // Abaikan jika berawalan slash, //, atau !

    const access = await checkUserAccess(msg);
    if (!access.allowed) {
      return handleAccessDenied(msg, access.status);
    }

    const sessionId = getSessionId(msg);

    // Jika topik / chat sedang di-pause, bot diam
    if (await isChatPaused(sessionId)) {
      return;
    }

    if (shouldIgnoreGroupMessage(msg, msg.text)) {
      return;
    }

    if (!msg.text) return;
    const chatId = msg.chat.id;
    await runQueued(msg, sessionId, async () => {
      let typing;
      try {
        typing = startTyping(chatId, msg.message_thread_id);
        let userText = msg.text;

        // Bersihkan mention bot dari userText jika ada
        const BOT_USERNAME = ctx.botUsername;
        if (BOT_USERNAME) {
          userText = userText.replace(new RegExp(`@${BOT_USERNAME}\\b`, "gi"), "").trim() || userText;
        }

        if (msg.reply_to_message) {
          const isTopicRoot = msg.message_thread_id && msg.reply_to_message.message_id === msg.message_thread_id;
          if (!isTopicRoot) {
            const replied = await getReplyContext(sessionId, msg.reply_to_message.message_id);
            if (replied) {
              userText = `Pesan yang direply:\n\n${replied.content}\n\nPesan baru:\n\n${userText}`;
            }
          }
        }

        await saveMemory(sessionId, "user", userText, msg.message_id);
        appendRawLog(sessionId, "user", userText, { messageId: msg.message_id });
        // Memori semantik (RAG): pesan cukup panjang masuk indeks pencarian. Fire-and-forget.
        ingestChatMessage(sessionId, "user", userText).catch((e) =>
          console.warn("[Knowledge] ingest chat gagal:", e.message)
        );

        await executeAICompletionAndReply({
          msg,
          sessionId,
          messages: buildMessagesWithSystem(await getHistoryForAI(sessionId, 12), sessionId),
          userPromptForFiles: userText,
          typing
        });
      } catch (err) {
        console.error("TEXT ERROR:", err);
        await replyText(msg, "Terjadi kesalahan.");
      } finally {
        stopTyping(typing);
      }
    });
  });

  // === HANDLER FOTO ===
  bot.on("photo", async (msg) => {
    if (msg.from && msg.from.is_bot) return; // [FIX] Mencegah infinite loop bot spam
    if (hasIgnorePrefix(msg.caption)) return;

    const access = await checkUserAccess(msg);
    if (!access.allowed) {
      return handleAccessDenied(msg, access.status);
    }

    const sessionId = getSessionId(msg);

    // Jika topik / chat sedang di-pause, bot diam
    if (await isChatPaused(sessionId)) {
      return;
    }

    if (shouldIgnoreGroupMessage(msg, msg.caption)) {
      return;
    }

    const chatId = msg.chat.id;
    await runQueued(msg, sessionId, async () => {
      let typing;
      try {
        typing = startTyping(chatId, msg.message_thread_id);
        const photo = msg.photo[msg.photo.length - 1];
        const file = await bot.getFile(photo.file_id);
        const telegramUrl = `https://api.telegram.org/file/bot${process.env.BOT_TOKEN}/${file.file_path}`;

        const response = await axios.get(telegramUrl, { responseType: "arraybuffer" });
        const bufferData = Buffer.from(response.data);
        const base64 = bufferData.toString("base64");
        const prompt = (msg.caption || "").trim();

        // Simpan fisik foto ke folder uploads workspace user
        const ws = ensureWorkspaceStructure(sessionId);
        const photoName = `photo_${Date.now()}.jpg`;
        const savedFilePath = path.join(ws.uploadsDir, photoName);
        writeUploadSafely(sessionId, savedFilePath, bufferData);
        const fileSizeKb = (bufferData.length / 1024).toFixed(1);

        const userTextPrompt =
          `🖼️ [Foto Diterima]\n` +
          `• Disimpan di server: \`uploads/${photoName}\` (path host: \`${savedFilePath}\`, ${fileSizeKb} KB)\n` +
          `• Path sandbox container: \`/workspace/uploads/${photoName}\`\n` +
          (prompt ? `• Pesan user: ${prompt}\n` : "") +
          `\nKamu bisa melihat gambar secara visual (Vision). Jika user meminta manipulasi gambar (resize, crop, OCR, convert, edit), olah gambar ini dan letakkan hasilnya di \`/workspace/work/\` atau \`/workspace/artifacts/\`.`;

        const currentMessage = [
          {
            role: "user",
            content: [
              { type: "text", text: userTextPrompt },
              { type: "image_url", image_url: { url: `data:image/jpeg;base64,${base64}` } }
            ]
          }
        ];

        await saveMemory(
          sessionId,
          "user",
          `[Kirim Foto]: ${prompt || "(tanpa caption)"} (disimpan di uploads/${photoName})`
        );
        appendRawLog(sessionId, "user", `[Kirim Foto]: ${prompt || "(tanpa caption)"} (uploads/${photoName})`, {
          messageId: msg.message_id
        });

        const currentHistory = await getHistoryForAI(sessionId, 12);
        await executeAICompletionAndReply({
          msg,
          sessionId,
          messages: buildMessagesWithSystem([...currentHistory, ...currentMessage], sessionId),
          userPromptForFiles: prompt,
          typing
        });
      } catch (err) {
        console.error("PHOTO ERROR:", err);
        await replyText(msg, "Gagal memproses foto.");
      } finally {
        stopTyping(typing);
      }
    });
  });

  // === HANDLER DOKUMEN ===
  bot.on("document", async (msg) => {
    if (msg.from && msg.from.is_bot) return; // [FIX] Mencegah infinite loop bot spam

    // Intersep perintah /restore lewat caption dokumen (khusus owner, menimpa database)
    if (/^\/restore(?:@\w+)?\s*$/i.test((msg.caption || "").trim())) {
      if (!isOwner(msg)) return replyText(msg, "⛔ Perintah ini khusus untuk Owner bot.");
      return handleRestore(msg, msg.document);
    }

    if (hasIgnorePrefix(msg.caption)) return;

    const access = await checkUserAccess(msg);
    if (!access.allowed) {
      return handleAccessDenied(msg, access.status);
    }

    const sessionId = getSessionId(msg);

    // Jika topik / chat sedang di-pause, bot diam
    if (await isChatPaused(sessionId)) {
      return;
    }

    if (shouldIgnoreGroupMessage(msg, msg.caption)) {
      return;
    }

    const chatId = msg.chat.id;
    await runQueued(msg, sessionId, async () => {
      let typing;
      try {
        typing = startTyping(chatId, msg.message_thread_id);
        const file = await bot.getFile(msg.document.file_id);
        const fileUrl = `https://api.telegram.org/file/bot${process.env.BOT_TOKEN}/${file.file_path}`;

        const response = await axios.get(fileUrl, { responseType: "arraybuffer" });
        const bufferData = Buffer.from(response.data);
        const rawFileName = msg.document.file_name || `file_${Date.now()}`;
        const safeName = sanitizePath(rawFileName).replace(/[\/\\]/g, "_") || `file_${Date.now()}`;

        // 1. Simpan file secara fisik ke uploads/ di workspace server user
        const ws = ensureWorkspaceStructure(sessionId);
        const savedFilePath = path.join(ws.uploadsDir, safeName);
        writeUploadSafely(sessionId, savedFilePath, bufferData);

        // 2. Indekskan isi dokumen ke memori semantik (RAG) di latar belakang —
        //    tidak menunda balasan meski dokumennya besar.
        ingestFileBuffer(sessionId, safeName, bufferData)
          .then((res) => {
            if (res.stored > 0) console.log(`[Knowledge] '${safeName}' terindeks (${res.stored} chunk).`);
            else if (res.skipped) console.log(`[Knowledge] '${safeName}' dilewati: ${res.skipped}`);
          })
          .catch((e) => console.warn(`[Knowledge] Gagal mengindeks '${safeName}':`, e.message));

        const fileSizeKb = (bufferData.length / 1024).toFixed(1);
        const prompt = (msg.caption || "").trim();
        const ext = path.extname(safeName).toLowerCase();

        let userPrompt = "";

        if (ext === ".zip") {
          userPrompt =
            `📦 [File ZIP Diterima]\n` +
            `• Nama file: \`${safeName}\` (${fileSizeKb} KB)\n` +
            `• Disimpan di: \`uploads/${safeName}\` (path host: \`${savedFilePath}\`)\n` +
            `• Path sandbox container: \`/workspace/uploads/${safeName}\`\n` +
            `• Folder kerja sandbox: \`/workspace/work/\`\n` +
            `• Instruksi user: ${prompt || "Periksa dan kelola isi ZIP ini."}\n\n` +
            `Instruksi AI Agent: File ZIP mentah tersimpan di \`/workspace/uploads/${safeName}\`. ` +
            `Ekstrak ke folder kerja (contoh: \`unzip -o "/workspace/uploads/${safeName}" -d "/workspace/work"\`), ` +
            `lalu periksa daftar filenya dengan \`file_list\`, baca isinya dengan \`file_read\`, jalankan pengujian kode di \`/workspace/work\`, ` +
            `dan jika ada file output jadi letakkan di \`/workspace/artifacts/\`.`;
        } else if (
          [
            ".js",
            ".ts",
            ".jsx",
            ".tsx",
            ".py",
            ".sh",
            ".json",
            ".html",
            ".css",
            ".txt",
            ".md",
            ".sql",
            ".yaml",
            ".yml"
          ].includes(ext)
        ) {
          userPrompt =
            `📄 [File Kode/Teks Diterima]\n` +
            `• Nama file: \`${safeName}\` (${fileSizeKb} KB)\n` +
            `• Disimpan di: \`uploads/${safeName}\` (path host: \`${savedFilePath}\`)\n` +
            `• Path sandbox container: \`/workspace/uploads/${safeName}\`\n` +
            `• Instruksi user: ${prompt || "Periksa file ini."}\n\n` +
            `Instruksi AI Agent: File mentah tersimpan di \`/workspace/uploads/${safeName}\`. ` +
            `Jika ingin mengedit, menyalin, atau mengujinya, gunakan folder \`/workspace/work/\` atau baca dengan \`file_read\`.`;
        } else if (ext === ".pdf" || ext === ".docx") {
          let extractedSnippet = "";
          try {
            if (ext === ".pdf") {
              const pdfData = await pdf(bufferData);
              extractedSnippet = pdfData.text ? pdfData.text.slice(0, 3000) : "";
            } else if (ext === ".docx") {
              const docxData = await mammoth.extractRawText({ buffer: bufferData });
              extractedSnippet = docxData.value ? docxData.value.slice(0, 3000) : "";
            }
          } catch (err) {
            console.warn(`[Doc Preview Error] Gagal baca cuplikan ${safeName}:`, err.message);
          }

          userPrompt =
            `📑 [Dokumen Diterima]\n` +
            `• Nama file: \`${safeName}\` (${fileSizeKb} KB)\n` +
            `• Disimpan di: \`uploads/${safeName}\` (path host: \`${savedFilePath}\`)\n` +
            `• Path sandbox container: \`/workspace/uploads/${safeName}\`\n` +
            `• Instruksi user: ${prompt || "Baca dan ringkas dokumen ini."}\n` +
            (extractedSnippet ? `\n[Cuplikan Isi Teks Dokumen]:\n${extractedSnippet}\n` : "") +
            `\nInstruksi AI Agent: File dokumen utuh tersimpan di \`/workspace/uploads/${safeName}\`.`;
        } else if ([".jpg", ".jpeg", ".png", ".webp"].includes(ext)) {
          const mime = ext === ".png" ? "image/png" : ext === ".webp" ? "image/webp" : "image/jpeg";

          const userTextPrompt =
            `🖼️ [Gambar HD Diterima]\n` +
            `• Disimpan di: \`uploads/${safeName}\` (path host: \`${savedFilePath}\`, ${fileSizeKb} KB)\n` +
            `• Path sandbox container: \`/workspace/uploads/${safeName}\`\n` +
            (prompt ? `• Instruksi user: ${prompt}\n` : "") +
            `\nKamu bisa melihat gambar secara visual (Vision). Hasil olahan simpan di \`/workspace/work/\` atau \`/workspace/artifacts/\`.`;

          await saveMemory(
            sessionId,
            "user",
            `[Kirim Gambar HD]: ${safeName} (${fileSizeKb} KB, path: uploads/${safeName})`
          );
          appendRawLog(
            sessionId,
            "user",
            `[Kirim Gambar HD]: ${safeName} (${fileSizeKb} KB, path: uploads/${safeName})`,
            { messageId: msg.message_id }
          );

          const currentMessage = [
            {
              role: "user",
              content: [
                { type: "text", text: userTextPrompt },
                { type: "image_url", image_url: { url: `data:${mime};base64,${bufferData.toString("base64")}` } }
              ]
            }
          ];

          const currentHistory = await getHistoryForAI(sessionId, 12);
          await executeAICompletionAndReply({
            msg,
            sessionId,
            messages: buildMessagesWithSystem([...currentHistory, ...currentMessage], sessionId),
            userPromptForFiles: prompt,
            typing
          });
          return;
        } else {
          userPrompt =
            `📁 [File Diterima]\n` +
            `• Nama file: \`${safeName}\` (${fileSizeKb} KB)\n` +
            `• Disimpan di: \`uploads/${safeName}\` (path host: \`${savedFilePath}\`)\n` +
            `• Path sandbox container: \`/workspace/uploads/${safeName}\`\n` +
            `• Instruksi user: ${prompt || "Periksa file ini."}\n\n` +
            `Instruksi AI Agent: File telah disimpan di \`/workspace/uploads/${safeName}\`.`;
        }

        // Catat ke memori percakapan & raw memory
        await saveMemory(
          sessionId,
          "user",
          `[Kirim Dokumen]: ${safeName} (${fileSizeKb} KB, path: uploads/${safeName}). Instruksi: ${prompt || "-"}`
        );
        appendRawLog(
          sessionId,
          "user",
          `[Kirim Dokumen]: ${safeName} (${fileSizeKb} KB, path: uploads/${safeName}). Instruksi: ${prompt || "-"}`,
          { messageId: msg.message_id }
        );

        const currentHistory = await getHistoryForAI(sessionId, 12);
        await executeAICompletionAndReply({
          msg,
          sessionId,
          messages: buildMessagesWithSystem([...currentHistory, { role: "user", content: userPrompt }], sessionId),
          userPromptForFiles: prompt || userPrompt,
          typing
        });
      } catch (err) {
        console.error("DOCUMENT ERROR:", err);
        await replyText(msg, "Gagal memproses dokumen.");
      } finally {
        stopTyping(typing);
      }
    });
  });

  // === HANDLER PESAN SUARA & AUDIO (VOICE TRANSCRIBER VIA FASTER-WHISPER) ===
  async function handleVoiceOrAudio(bot, msg, isVoice = true) {
    if (msg.from && msg.from.is_bot) return; // Mencegah loop bot
    if (hasIgnorePrefix(msg.caption)) return;

    const access = await checkUserAccess(msg);
    if (!access.allowed) {
      return handleAccessDenied(msg, access.status);
    }

    const sessionId = getSessionId(msg);

    // Jika topik / chat sedang di-pause, bot diam
    if (await isChatPaused(sessionId)) {
      return;
    }

    if (shouldIgnoreGroupMessage(msg, msg.caption || "")) {
      return;
    }

    const mediaObj = isVoice ? msg.voice : msg.audio;
    if (!mediaObj || !mediaObj.file_id) return;

    const chatId = msg.chat.id;
    await runQueued(msg, sessionId, async () => {
      let typing;
      try {
        typing = startTyping(chatId, msg.message_thread_id);

        // 1. Dapatkan info file dari Telegram
        const file = await bot.getFile(mediaObj.file_id);
        const fileUrl = `https://api.telegram.org/file/bot${process.env.BOT_TOKEN}/${file.file_path}`;

        // 2. Unduh file audio ke buffer
        const response = await axios.get(fileUrl, { responseType: "arraybuffer" });
        const bufferData = Buffer.from(response.data);

        // 3. Simpan fisik file audio ke folder uploads workspace
        const ws = ensureWorkspaceStructure(sessionId);
        const ext = path.extname(file.file_path) || (isVoice ? ".oga" : ".mp3");
        const audioFileName = `audio_${Date.now()}${ext}`;
        const savedAudioPath = path.join(ws.uploadsDir, audioFileName);
        writeUploadSafely(sessionId, savedAudioPath, bufferData);

        // 4. Transkripsikan dengan Faster-Whisper lokal
        let transcribedText = "";
        try {
          transcribedText = await transcribeAudio(savedAudioPath);
        } catch (transcribeErr) {
          console.error("[Voice Transcription Error]:", transcribeErr.message);
        }

        if (!transcribedText || !transcribedText.trim()) {
          stopTyping(typing);
          return await replyText(
            msg,
            "🎙️ _Maaf, suara tidak terdengar jelas atau tidak ada ucapan kata yang terdeteksi._"
          );
        }

        const cleanedText = transcribedText.trim();
        console.log(`[Voice Note Transcribed] [Chat ${chatId}]: "${cleanedText}"`);

        // 5. Catat ke memori percakapan & raw memory
        await saveMemory(sessionId, "user", `[Pesan Suara / Voice Note]: "${cleanedText}"`, msg.message_id);
        appendRawLog(sessionId, "user", `[Pesan Suara / Voice Note]: "${cleanedText}" (uploads/${audioFileName})`, {
          messageId: msg.message_id
        });

        const promptCaption = (msg.caption || "").trim();
        const userPrompt =
          `🎙️ [Voice Note / Pesan Suara Diterima & Ditranskripsikan]\n` +
          `• Hasil transkripsi ucapan user: "${cleanedText}"\n` +
          `• File audio tersimpan di: \`uploads/${audioFileName}\`\n` +
          (promptCaption ? `• Catatan caption: "${promptCaption}"\n` : "") +
          `\nInstruksi AI Agent: User menyampaikan pesan di atas melalui rekaman suara. Tanggapi, jawab, atau eksekusi instruksinya secara cerdas, ramah, dan solutif.`;

        const currentHistory = await getHistoryForAI(sessionId, 12);
        await executeAICompletionAndReply({
          msg,
          sessionId,
          messages: buildMessagesWithSystem([...currentHistory, { role: "user", content: userPrompt }], sessionId),
          userPromptForFiles: cleanedText,
          typing
        });
      } catch (err) {
        console.error("VOICE/AUDIO ERROR:", err);
        await replyText(msg, "Gagal memproses pesan suara.");
      } finally {
        stopTyping(typing);
      }
    });
  }

  bot.on("voice", (msg) => handleVoiceOrAudio(bot, msg, true));
  bot.on("audio", (msg) => handleVoiceOrAudio(bot, msg, false));
}

module.exports = { registerHandlers, writeUploadSafely };
