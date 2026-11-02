/**
 * bot/commands.js — Semua perintah slash (/start, /tasks, /config, ...) dan daftar menu perintah.
 */

const fs = require("fs");
const path = require("path");
const ctx = require("./context");
const { OWNER_ID, getConfig, updateConfig, resetConfig, maskKey, isOwner } = require("./config");
const { replyText, startTyping, stopTyping } = require("./send");
const { turnQueue } = require("./turnQueue");
const { runQueued } = require("./queuedTurn");
const { getSessionId, checkUserAccess, handleAccessDenied } = require("./access");
const { getChatWorkspace, cleanupOldWorkspaceFiles } = require("./workspace");
const { buildMessagesWithSystem } = require("./prompt");
const { activeTurnSessions, executeAICompletionAndReply } = require("./agentLoop");
const {
  getHistoryForAI,
  getChatState,
  newTopic,
  saveBotConfig,
  resetBotConfig,
  getUserAccess,
  setUserAccess,
  setChatPaused
} = require("../onlyxHelper.js");
const { resetSandbox, getSandboxInfo } = require("../sandboxManager.js");
const { listTasks, removeTask, formatInZone, REPEAT_LABEL } = require("../schedulerManager.js");
const skillsManager = require("../skillsManager.js");

/**
 * Menu perintah yang tampil saat user mengetik "/" di Telegram (setMyCommands).
 * Deskripsi maksimal 256 karakter; perintah hanya huruf kecil, angka, dan garis bawah.
 */
const PUBLIC_COMMANDS = [
  { command: "start", description: "Menu utama dan daftar fitur" },
  { command: "newtopic", description: "Mulai topik baru (bersihkan konteks obrolan)" },
  { command: "stop", description: "Hentikan pekerjaan AI yang sedang berjalan" },
  { command: "tasks", description: "Lihat & batalkan pengingat dan pemantau web" },
  { command: "workspace", description: "Daftar file di workspace kamu" },
  { command: "sandbox", description: "Status container sandbox Docker kamu" },
  { command: "resetsandbox", description: "Reset container sandbox jika error" },
  { command: "summary", description: "Ringkasan memori percakapan" },
  { command: "skills", description: "Katalog keahlian AI" },
  { command: "learn", description: "Simpan solusi terakhir sebagai keahlian baru" },
  { command: "clean", description: "Hapus semua file di workspace kamu" },
  { command: "pause", description: "Jeda respons bot di chat ini" },
  { command: "resume", description: "Aktifkan kembali respons bot" }
];

const OWNER_COMMANDS = [
  ...PUBLIC_COMMANDS,
  { command: "config", description: "👑 Lihat model, Base URL, API key" },
  { command: "setmodel", description: "👑 Ganti model AI" },
  { command: "setbaseurl", description: "👑 Ganti Base URL API" },
  { command: "setapikey", description: "👑 Ganti API key" },
  { command: "resetconfig", description: "👑 Kembalikan pengaturan ke .env" },
  { command: "approve", description: "👑 Setujui akses user" },
  { command: "reject", description: "👑 Tolak/cabut akses user" },
  { command: "cleanall", description: "👑 Bersihkan workspace lama semua user" }
];

/** Pasang menu perintah: umum untuk semua chat, versi lengkap untuk chat pribadi owner. */
async function registerBotCommands(bot) {
  try {
    await bot.setMyCommands(PUBLIC_COMMANDS);
    if (OWNER_ID) {
      await bot.setMyCommands(OWNER_COMMANDS, { scope: { type: "chat", chat_id: Number(OWNER_ID) } });
    }
    console.log(`[Bot] Menu perintah terpasang (${PUBLIC_COMMANDS.length} umum, ${OWNER_COMMANDS.length} owner).`);
  } catch (err) {
    console.warn("[Bot] Gagal memasang menu perintah:", err.message);
  }
}

/** Isi pesan /tasks plus tombol batal per tugas. */
function buildTasksMessage(sessionId) {
  const { reminders: rList, watchdogs: wList } = listTasks(sessionId);
  if (rList.length === 0 && wList.length === 0) {
    return {
      text:
        "⏰ *Tidak ada pengingat atau pemantau aktif.*\n\n" +
        "Kamu bisa meminta AI Agent membuat pengingat (misal: _ingatkan saya 15 menit lagi untuk meeting_, " +
        "_ingatkan tiap hari kerja jam 09:00 untuk standup_) atau pemantau web (misal: _pantau https://example.com tiap 10 menit_).",
      keyboard: []
    };
  }

  const clip = (s, n) => (s.length > n ? s.slice(0, n - 1) + "…" : s);
  const noMd = (s) => String(s).replace(/[*_`\[\]]/g, "");
  let text = "📋 *Daftar Tugas & Pengingat Aktif:*\n\n";
  const keyboard = [];

  if (rList.length > 0) {
    text += "*⏰ Pengingat:*\n";
    rList.forEach((r, i) => {
      const repeat = r.repeat && r.repeat !== "none" ? ` · 🔁 ${REPEAT_LABEL[r.repeat]}` : "";
      text += `${i + 1}. "${noMd(clip(r.message, 80))}"\n    ${formatInZone(r.targetTime, r.timezone)}${repeat}\n`;
      keyboard.push([
        { text: `❌ Batalkan pengingat ${i + 1}: ${clip(r.message, 24)}`, callback_data: `task_cancel:${r.id}` }
      ]);
    });
    text += "\n";
  }

  if (wList.length > 0) {
    text += "*🚨 Pemantau Web (Watchdog):*\n";
    wList.forEach((w, i) => {
      const status = w.isCurrentlyDown ? "🔴 down" : w.lastChecked ? "🟢 normal" : "⏳ belum dicek";
      const lastCheck = w.lastChecked ? formatInZone(w.lastChecked) : "belum";
      text += `${i + 1}. ${noMd(w.url)}\n    tiap ${w.intervalMinutes} menit · ${status} · terakhir ${lastCheck}\n`;
      keyboard.push([
        {
          text: `❌ Hentikan pemantau ${i + 1}: ${clip(w.url.replace(/^https?:\/\//, ""), 24)}`,
          callback_data: `task_cancel:${w.id}`
        }
      ]);
    });
  }

  text += `\n_💡 Ketuk tombol di bawah untuk membatalkan, atau ketik /canceltask <id>._`;
  return { text, keyboard };
}

function registerCommands(bot) {
  bot.onText(/^\/start(?:@\w+)?$/, async (msg) => {
    if (msg.from && msg.from.is_bot) return; // Cegah bot merespons bot

    const access = await checkUserAccess(msg);
    if (!access.allowed) {
      return handleAccessDenied(msg, access.status);
    }

    let text =
      "Halo! Saya *Nroz AI Agent* 🤖\n\nSiap membantumu berdiskusi, mengeksekusi kode, memeriksa server VPS, browsing internet, mengelola proyek coding di *Persistent Docker Sandbox* terisolasi, serta berbagai fitur canggih:\n• 🎙️ *Voice Note Transcriber* (bicara langsung via pesan suara)\n• 📊 *Data Analyst & Auto Chart* (grafik & visualisasi data otomatis)\n• 🎥 *Remotion React Video Creator* (bikin video MP4 animasi dari React)\n• 🌐 *Instant Web Preview* (link publik HTTPS live via Cloudflare Tunnel)\n• ⏰ *Pengingat & Pemantau Web* (Reminder & Server Watchdog)\n• 🎬 *Media Downloader & Converter* (yt-dlp & ffmpeg)\n\n*Perintah Tersedia:*\n• /newtopic : Mulai obrolan / topik baru\n• /workspace : Cek daftar file di folder server kamu\n• /sandbox : Cek status container sandbox Docker kamu\n• /resetsandbox : Reset container sandbox jika terjadi error\n• /tasks : Cek jadwal pengingat & pemantau web aktif\n• /clean : Hapus & bersihkan file di workspace kamu\n• /summary : Lihat ringkasan memori percakapan\n• /pause & /resume : Jeda / aktifkan respon bot";
    if (isOwner(msg)) {
      text +=
        "\n\n👑 *Menu Khusus Owner:*\n• /config : Cek & kelola Model, Base URL, dan API Key\n• /cleanall : Bersihkan semua workspace > 3 hari\n• /approve <id> : Izinkan user manual\n• /reject <id> : Tolak/cabut user manual";
    }
    await replyText(msg, text);
  });

  // --- PERINTAH CEK ISI WORKSPACE PENGGUNA ---
  bot.onText(/^\/(?:workspace|myfiles|files)(?:@\w+)?$/, async (msg) => {
    if (msg.from && msg.from.is_bot) return;

    const access = await checkUserAccess(msg);
    if (!access.allowed) {
      return handleAccessDenied(msg, access.status);
    }

    const sessionId = getSessionId(msg);
    const dir = getChatWorkspace(sessionId);

    try {
      const items = fs.readdirSync(dir);
      if (items.length === 0) {
        return replyText(
          msg,
          "📁 *Workspace kamu masih kosong.*\n\nKirimkan file dokumen, ZIP, script, atau gambar untuk mulai bekerja dengan AI Agent!"
        );
      }

      let fileList = [];
      let totalBytes = 0;

      for (const item of items) {
        const itemPath = path.join(dir, item);
        try {
          const stats = fs.statSync(itemPath);
          totalBytes += stats.size;
          const icon = stats.isDirectory() ? "📁" : "📄";
          const sizeStr = stats.isDirectory() ? "" : ` (${(stats.size / 1024).toFixed(1)} KB)`;
          fileList.push(`• ${icon} \`${item}\`${sizeStr}`);
        } catch (_) {
          fileList.push(`• ❓ \`${item}\``);
        }
      }

      const totalKb = (totalBytes / 1024).toFixed(1);
      await replyText(
        msg,
        `📁 *Isi Workspace Server Kamu:*\n\n` +
          `Lokasi: \`${dir}\`\n` +
          `Total item: ${items.length} (${totalKb} KB)\n\n` +
          fileList.join("\n") +
          `\n\n_💡 Ketik /clean kapan saja untuk membersihkan file ini._`
      );
    } catch (err) {
      await replyText(msg, `❌ Gagal membaca workspace: ${err.message}`);
    }
  });

  // --- PERINTAH CLEAN WORKSPACE (HAPUS FILE USER) ---
  bot.onText(/^\/(?:clean|cleanworkspace|clearfiles)(?:@\w+)?$/, async (msg) => {
    if (msg.from && msg.from.is_bot) return;

    const access = await checkUserAccess(msg);
    if (!access.allowed) {
      return handleAccessDenied(msg, access.status);
    }

    const sessionId = getSessionId(msg);
    const dir = getChatWorkspace(sessionId);

    try {
      const items = fs.readdirSync(dir);
      if (items.length === 0) {
        return replyText(msg, "ℹ️ Workspace kamu sudah bersih (tidak ada file).");
      }

      let count = 0;
      for (const item of items) {
        const p = path.join(dir, item);
        fs.rmSync(p, { recursive: true, force: true });
        count++;
      }

      await replyText(
        msg,
        `🧹 *Workspace Dibersihkan!*\n\nBerhasil menghapus ${count} file/folder dari workspace kamu.`
      );
    } catch (err) {
      await replyText(msg, `❌ Gagal membersihkan workspace: ${err.message}`);
    }
  });

  // --- PERINTAH OWNER: CLEAN ALL WORKSPACES (> 3 HARI) ---
  bot.onText(/^\/cleanall(?:@\w+)?$/, async (msg) => {
    if (msg.from && msg.from.is_bot) return;
    if (!isOwner(msg)) {
      return replyText(msg, "⛔ Perintah ini khusus untuk Owner bot.");
    }

    const { deletedCount, freedBytes } = cleanupOldWorkspaceFiles(3);
    const freedMb = (freedBytes / (1024 * 1024)).toFixed(2);
    await replyText(
      msg,
      `🧹 *Pembersihan Global Workspace Selesai*\n\n` +
        `• File lama (> 3 hari) dihapus: ${deletedCount} item\n` +
        `• Kapasitas disk dibebaskan: ${freedMb} MB`
    );
  });

  // --- PERINTAH CEK STATUS SANDBOX DOCKER ---
  bot.onText(/^\/(?:sandbox|sbinfo)(?:@\w+)?$/, async (msg) => {
    if (msg.from && msg.from.is_bot) return;

    const access = await checkUserAccess(msg);
    if (!access.allowed) {
      return handleAccessDenied(msg, access.status);
    }

    const sessionId = getSessionId(msg);
    const info = getSandboxInfo(sessionId);
    if (info.exists) {
      await replyText(
        msg,
        `🐳 *Status Sandbox Docker Pribadi Kamu:*\n\n` +
          `• Container: \`${info.containerName}\`\n` +
          `• Info: \`${info.info}\`\n` +
          `• Workspace: \`/workspace\` (ter-mount ke folder host)\n\n` +
          `_💡 Ketik /resetsandbox kapan saja untuk mereset container jika sistem error._`
      );
    } else {
      await replyText(
        msg,
        `🐳 *Sandbox Docker Pribadi:* Belum ada container aktif untuk sesi ini.\nContainer akan otomatis dibuat dan menyala begitu kamu meminta AI menjalankan perintah atau kode.`
      );
    }
  });

  // --- PERINTAH RESET DOCKER SANDBOX ---
  bot.onText(/^\/(?:resetsandbox|resetsb)(?:@\w+)?$/, async (msg) => {
    if (msg.from && msg.from.is_bot) return;

    const access = await checkUserAccess(msg);
    if (!access.allowed) {
      return handleAccessDenied(msg, access.status);
    }

    const sessionId = getSessionId(msg);
    const ok = resetSandbox(sessionId);
    if (ok) {
      await replyText(
        msg,
        "🔄 *Container Sandbox Docker Berhasil Direset!*\n\nContainer lama telah dihapus. Saat kamu meminta AI menjalankan perintah lagi, container baru yang bersih akan dibuat secara otomatis."
      );
    } else {
      await replyText(msg, "ℹ️ Sandbox belum aktif atau sudah dalam keadaan bersih.");
    }
  });

  // --- PERINTAH DAFTAR PENGINGAT & WATCHDOG (dengan tombol batal) ---
  bot.onText(/^\/(?:tasks|reminders|jadwal)(?:@\w+)?$/, async (msg) => {
    if (msg.from && msg.from.is_bot) return;

    const access = await checkUserAccess(msg);
    if (!access.allowed) {
      return handleAccessDenied(msg, access.status);
    }

    const { text, keyboard } = buildTasksMessage(getSessionId(msg));
    await replyText(msg, text, keyboard.length ? { reply_markup: { inline_keyboard: keyboard } } : {});
  });

  // --- PERINTAH BATALKAN PENGINGAT / WATCHDOG ---
  bot.onText(/^\/canceltask(?:@\w+)?(?:\s+(.+))?$/, async (msg, match) => {
    if (msg.from && msg.from.is_bot) return;

    const access = await checkUserAccess(msg);
    if (!access.allowed) {
      return handleAccessDenied(msg, access.status);
    }

    const taskId = match && match[1] ? match[1].trim() : "";
    if (!taskId) {
      return replyText(msg, "ℹ️ Format: `/canceltask <id_tugas>`\nLihat daftar ID dengan `/tasks`");
    }

    const sessionId = getSessionId(msg);
    const removed = removeTask(sessionId, taskId);
    if (removed) {
      await replyText(msg, `✅ Tugas \`${taskId}\` berhasil dibatalkan.`);
    } else {
      await replyText(msg, `❌ Tugas dengan ID \`${taskId}\` tidak ditemukan.`);
    }
  });

  // --- PERINTAH REM DARURAT: STOP / CANCEL PROSES MARATON AI ---
  bot.onText(/^\/(?:stop|cancel|abort)(?:@\w+)?$/, async (msg) => {
    if (msg.from && msg.from.is_bot) return;

    const access = await checkUserAccess(msg);
    if (!access.allowed) {
      return handleAccessDenied(msg, access.status);
    }

    const sessionId = getSessionId(msg);
    const dropped = turnQueue.cancelPending(sessionId);
    if (activeTurnSessions.has(sessionId)) {
      activeTurnSessions.get(sessionId).cancelled = true;
      await replyText(
        msg,
        "🛑 Menghentikan proses AI yang sedang berjalan..." +
          (dropped ? `\n${dropped} pesan yang menunggu di antrean juga dibatalkan.` : "")
      );
    } else if (dropped) {
      await replyText(msg, `🛑 ${dropped} pesan yang menunggu di antrean dibatalkan.`);
    } else {
      await replyText(msg, "ℹ Tidak ada proses AI maraton yang sedang berjalan di sesi ini.");
    }
  });

  bot.onText(/^\/newtopic(?:@\w+)?$/, async (msg) => {
    if (msg.from && msg.from.is_bot) return; // Cegah bot merespons bot

    const access = await checkUserAccess(msg);
    if (!access.allowed) {
      return handleAccessDenied(msg, access.status);
    }

    const sessionId = getSessionId(msg);
    await newTopic(sessionId);

    // Jika dipanggil di dalam Forum Topic Supergroup, coba hapus forum topic di Telegram secara otomatis
    if (msg.message_thread_id && msg.chat.type === "supergroup") {
      try {
        await ctx.bot.deleteForumTopic(msg.chat.id, msg.message_thread_id);
        return; // Topic forum Telegram dan seluruh pesannya berhasil terhapus
      } catch (err) {
        console.warn(
          "[Forum] Gagal menghapus topic forum Telegram (mungkin kurang hak admin manage topics):",
          err.message
        );
      }
    }

    const replyMsg = msg.message_thread_id ? "berhasil mengganti topic di forum ini." : "berhasil mengganti topic.";
    await replyText(msg, replyMsg);
  });

  // --- PERINTAH CEK RINGKASAN MEMORI TOPIK AKTIF ---
  bot.onText(/^\/summary(?:@\w+)?$/, async (msg) => {
    if (msg.from && msg.from.is_bot) return;

    const access = await checkUserAccess(msg);
    if (!access.allowed) {
      return handleAccessDenied(msg, access.status);
    }

    const sessionId = getSessionId(msg);
    const state = await getChatState(sessionId);
    if (!state.summary || state.summary.trim().length === 0) {
      return replyText(msg, "ℹ️ Belum ada ringkasan memori untuk topik ini (obrolan masih sedikit atau baru dimulai).");
    }
    await replyText(msg, `📝 *Ringkasan Memori Topik Saat Ini:*\n\n_${state.summary}_`);
  });

  // --- PERINTAH KATALOG SKILL AKTIF (GLOBAL & WORKSPACE) ---
  bot.onText(/^\/(?:skills|keahlian)(?:@\w+)?$/, async (msg) => {
    if (msg.from && msg.from.is_bot) return;

    const access = await checkUserAccess(msg);
    if (!access.allowed) {
      return handleAccessDenied(msg, access.status);
    }

    const sessionId = getSessionId(msg);
    const allSkills = skillsManager.listSkills(sessionId);
    const globals = allSkills.filter((s) => s.scope !== "workspace");
    const userLearned = allSkills.filter((s) => s.scope === "workspace");

    let reply = `📚 *Katalog Keahlian AI (@NrozBot)*\n\n`;
    reply += `🌐 *Keahlian Bawaan Sistem (${globals.length}):*\n`;
    for (const s of globals) {
      reply += `• \`${s.name}\`: ${s.description}\n`;
    }

    reply += `\n👤 *Keahlian Khusus Kamu (${userLearned.length}):*\n`;
    if (userLearned.length === 0) {
      reply += `_(Belum ada keahlian khusus yang dipelajari. Gunakan /learn [topik] untuk merekam keahlian baru.)_\n`;
    } else {
      for (const s of userLearned) {
        reply += `• \`${s.name}\`: ${s.description}\n`;
      }
    }

    reply += `\n💡 Tips: AI membaca panduan skill secara otomatis menggunakan tool \`read_skill\`.`;
    await replyText(msg, reply);
  });

  // --- PERINTAH /learn (REKAM KEAHLIAN / RESEP BARU DARI PENGALAMAN) ---
  bot.onText(/^\/learn(?:@\w+)?(?:\s+([\s\S]+))?$/, async (msg, match) => {
    if (msg.from && msg.from.is_bot) return;

    const access = await checkUserAccess(msg);
    if (!access.allowed) {
      return handleAccessDenied(msg, access.status);
    }

    const sessionId = getSessionId(msg);
    const topic = match && match[1] ? match[1].trim() : "";
    const promptInstruction = topic
      ? `Rangkum dan dokumentasikan seluruh langkah, konfigurasi, dan solusi yang telah kita lakukan mengenai '${topic}' menjadi sebuah keahlian baru menggunakan tool 'save_skill'. Tuliskan panduan teknis yang presisi, perintah terminal yang berhasil, dan template kodenya.`
      : `Rangkum dan dokumentasikan solusi atau alur kerja terbaik dari percakapan kita baru-baru ini menjadi sebuah keahlian baru menggunakan tool 'save_skill'. Tuliskan panduan teknis yang presisi, perintah terminal yang berhasil, dan template kodenya.`;

    await replyText(
      msg,
      `🧠 *Mempelajari Keahlian Baru...*\nAI sedang menganalisis pengalaman obrolan dan menyusun file SOP di folder \`/workspace/skills/\` kamu.`
    );

    await runQueued(msg, sessionId, async () => {
      const typing = startTyping(msg.chat.id, msg.message_thread_id);
      try {
        await executeAICompletionAndReply({
          msg,
          sessionId,
          messages: buildMessagesWithSystem(await getHistoryForAI(sessionId, 12), sessionId),
          userPromptForFiles: promptInstruction,
          typing
        });
      } catch (err) {
        console.error("LEARN ERROR:", err);
        await replyText(msg, "Gagal mempelajari keahlian baru.");
      } finally {
        stopTyping(typing);
      }
    });
  });

  // --- PERINTAH PAUSE (Jeda Bot untuk Diskusi Sesama Member) ---
  bot.onText(/^\/pause(?:@\w+)?$/, async (msg) => {
    if (msg.from && msg.from.is_bot) return;

    const access = await checkUserAccess(msg);
    if (!access.allowed) {
      return handleAccessDenied(msg, access.status);
    }

    const sessionId = getSessionId(msg);
    await setChatPaused(sessionId, true);

    const scopeText = msg.message_thread_id
      ? "di topik forum ini"
      : msg.chat.type === "private"
        ? "di chat pribadi ini"
        : "di grup ini";

    await replyText(
      msg,
      `⏸️ *Bot dijeda ${scopeText}.*\n\nBot tidak akan merespons pesan biasa agar kalian bebas berdiskusi.\nKetik \`/resume\` kapan saja untuk mengaktifkan kembali bot.`
    );
  });

  // --- PERINTAH RESUME (Aktifkan Kembali Bot) ---
  bot.onText(/^\/resume(?:@\w+)?$/, async (msg) => {
    if (msg.from && msg.from.is_bot) return;

    const access = await checkUserAccess(msg);
    if (!access.allowed) {
      return handleAccessDenied(msg, access.status);
    }

    const sessionId = getSessionId(msg);
    await setChatPaused(sessionId, false);

    const scopeText = msg.message_thread_id
      ? "di topik forum ini"
      : msg.chat.type === "private"
        ? "di chat pribadi ini"
        : "di grup ini";

    await replyText(
      msg,
      `▶️ *Bot kembali aktif ${scopeText}!*\n\nSilakan ajukan pertanyaan atau berdiskusi seperti biasa.`
    );
  });

  // --- PERINTAH OWNER: LIHAT PENGATURAN ---
  bot.onText(/^\/(?:config|settings)(?:@\w+)?$/, async (msg) => {
    if (msg.from && msg.from.is_bot) return;
    if (!isOwner(msg)) {
      return replyText(msg, "⛔ Perintah ini khusus untuk Owner bot.");
    }

    const currentConfig = getConfig();
    const text = `⚙️ *Pengaturan Nroz AI Bot*

• *Model:* \`${currentConfig.model || "(belum diatur)"}\`
• *Base URL:* \`${currentConfig.baseUrl || "(belum diatur)"}\`
• *API Key:* \`${maskKey(currentConfig.apiKey)}\`
• *Owner ID:* \`${OWNER_ID}\`

*Perintah untuk mengubah:*
• \`/setmodel <nama_model>\`
Contoh: \`/setmodel gpt-4o\`

• \`/setbaseurl <url>\`
Contoh: \`/setbaseurl https://router.clouvia.id/v1\`

• \`/setapikey <api_key>\`
Contoh: \`/setapikey clv_live_xxxxxx\`

• \`/approve <user_id>\`
Setujui akses pengguna secara manual

• \`/reject <user_id>\`
Tolak atau cabut akses pengguna

• \`/resetconfig\`
Kembalikan ke pengaturan awal dari .env`;

    await replyText(msg, text);
  });

  // --- PERINTAH OWNER: UBAH MODEL ---
  bot.onText(/^\/setmodel(?:@\w+)?(?:\s+(.+))?$/, async (msg, match) => {
    if (msg.from && msg.from.is_bot) return;
    if (!isOwner(msg)) {
      return replyText(msg, "⛔ Perintah ini khusus untuk Owner bot.");
    }

    const newModel = match[1]?.trim();
    if (!newModel) {
      return replyText(
        msg,
        "Format salah. Silakan ketik:\n`/setmodel <nama_model>`\n\nContoh:\n`/setmodel gpt-4o`\n`/setmodel qwen-3.8-max-thinking-agentic`"
      );
    }

    updateConfig({ model: newModel });
    try {
      await saveBotConfig(getConfig());
    } catch (err) {
      console.warn("[Config] Gagal simpan ke Onlyx DB:", err.message);
    }

    await replyText(msg, `✅ *Model AI berhasil diubah!*\n\nModel aktif sekarang:\n\`${newModel}\``);
  });

  // --- PERINTAH OWNER: UBAH BASE URL ---
  bot.onText(/^\/setbaseurl(?:@\w+)?(?:\s+(.+))?$/, async (msg, match) => {
    if (msg.from && msg.from.is_bot) return;
    if (!isOwner(msg)) {
      return replyText(msg, "⛔ Perintah ini khusus untuk Owner bot.");
    }

    let newUrl = match[1]?.trim();
    if (!newUrl) {
      return replyText(
        msg,
        "Format salah. Silakan ketik:\n`/setbaseurl <url>`\n\nContoh:\n`/setbaseurl https://router.clouvia.id/v1`\n`/setbaseurl https://api.openai.com/v1`"
      );
    }

    newUrl = newUrl.replace(/\/+$/, "");
    updateConfig({ baseUrl: newUrl });
    try {
      await saveBotConfig(getConfig());
    } catch (err) {
      console.warn("[Config] Gagal simpan ke Onlyx DB:", err.message);
    }

    await replyText(msg, `✅ *Base URL berhasil diubah!*\n\nBase URL aktif sekarang:\n\`${newUrl}\``);
  });

  // --- PERINTAH OWNER: UBAH API KEY ---
  bot.onText(/^\/setapikey(?:@\w+)?(?:\s+(.+))?$/, async (msg, match) => {
    if (msg.from && msg.from.is_bot) return;
    if (!isOwner(msg)) {
      return replyText(msg, "⛔ Perintah ini khusus untuk Owner bot.");
    }

    // Jika dikirim di grup, coba hapus demi keamanan kredensial
    if (msg.chat.type !== "private") {
      try {
        await ctx.bot.deleteMessage(msg.chat.id, msg.message_id);
      } catch {}
    }

    const newKey = match[1]?.trim();
    if (!newKey) {
      return replyText(
        msg,
        "Format salah. Silakan ketik:\n`/setapikey <key>`\n\nContoh:\n`/setapikey clv_live_xxxxxx`\n\n_💡 Tips: Sangat disarankan kirim di chat pribadi (private) dengan bot._"
      );
    }

    updateConfig({ apiKey: newKey });
    try {
      await saveBotConfig(getConfig());
    } catch (err) {
      console.warn("[Config] Gagal simpan ke Onlyx DB:", err.message);
    }

    await replyText(msg, `✅ *API Key berhasil diperbarui!*\n\nAPI Key aktif sekarang:\n\`${maskKey(newKey)}\``);
  });

  // --- PERINTAH OWNER: APPROVE PENGGUNA MANUAL ---
  bot.onText(/^\/approve(?:@\w+)?(?:\s+(\d+))?$/, async (msg, match) => {
    if (msg.from && msg.from.is_bot) return;
    if (!isOwner(msg)) {
      return replyText(msg, "⛔ Perintah ini khusus untuk Owner bot.");
    }

    const targetId = match[1]?.trim();
    if (!targetId) {
      return replyText(msg, "Format salah. Contoh:\n`/approve 12345678`");
    }

    const userAccess = await getUserAccess(targetId);
    await setUserAccess(targetId, "approved", userAccess || {});
    await replyText(msg, `✅ User ID \`${targetId}\` berhasil disetujui.`);

    try {
      await ctx.bot.sendMessage(
        targetId,
        "🎉 *Kabar baik!*\n\nAkses Anda telah disetujui oleh Owner. Sekarang Anda dapat menggunakan seluruh fitur Nroz AI!\n\nKetik /start atau kirim pesan untuk memulai.",
        { parse_mode: "Markdown" }
      );
    } catch {}
  });

  // --- PERINTAH OWNER: REJECT PENGGUNA MANUAL ---
  bot.onText(/^\/reject(?:@\w+)?(?:\s+(\d+))?$/, async (msg, match) => {
    if (msg.from && msg.from.is_bot) return;
    if (!isOwner(msg)) {
      return replyText(msg, "⛔ Perintah ini khusus untuk Owner bot.");
    }

    const targetId = match[1]?.trim();
    if (!targetId) {
      return replyText(msg, "Format salah. Contoh:\n`/reject 12345678`");
    }

    const userAccess = await getUserAccess(targetId);
    await setUserAccess(targetId, "rejected", userAccess || {});
    await replyText(msg, `❌ User ID \`${targetId}\` telah ditolak/dicabut aksesnya.`);

    try {
      await ctx.bot.sendMessage(
        targetId,
        "⛔ *Pemberitahuan*\n\nAkses Anda ke bot ini telah dinonaktifkan oleh Owner.",
        { parse_mode: "Markdown" }
      );
    } catch {}
  });

  // --- PERINTAH OWNER: RESET KE DEFAULT .ENV ---
  bot.onText(/^\/resetconfig(?:@\w+)?$/, async (msg) => {
    if (msg.from && msg.from.is_bot) return;
    if (!isOwner(msg)) {
      return replyText(msg, "⛔ Perintah ini khusus untuk Owner bot.");
    }

    const currentConfig = resetConfig();
    try {
      await resetBotConfig();
    } catch (err) {
      console.warn("[Config] Gagal reset di Onlyx DB:", err.message);
    }

    await replyText(
      msg,
      `🔄 *Pengaturan telah direset ke default .env!*\n\n• Model: \`${currentConfig.model}\`\n• Base URL: \`${currentConfig.baseUrl}\`\n• API Key: \`${maskKey(currentConfig.apiKey)}\``
    );
  });
}

module.exports = { registerCommands, registerBotCommands, buildTasksMessage, PUBLIC_COMMANDS, OWNER_COMMANDS };
