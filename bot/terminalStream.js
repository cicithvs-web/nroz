/**
 * bot/terminalStream.js — Live tail terminal untuk job background di sandbox.
 *
 * Output perintah `run_command {background: true}` ditulis ke /workspace/.bg/<jobId>.log
 * (bind mount yang sama dilihat host dan container), jadi watcher di proses bot cukup
 * membaca file itu secara inkremental (offset-based) dan menampilkannya live ke Telegram.
 *
 * Dua mode render (riset Bot API 9.3+/10.3):
 * - Chat pribadi  -> `sendDraft` (sendMessageDraft): bubble live nempel di bawah chat,
 *   otomatis bersih saat pesan final dikirim, dengan stop-generation native
 *   (can_stop + update MessageGenerationStopped, Bot API 10.3).
 * - Grup/topic    -> kirim satu pesan lalu editMessageText berkala (draft tidak
 *   tersedia untuk grup: "live drafts can only be sent to users").
 *
 * Batas rate draft: 20 panggilan/5 dtk dan 40/30 dtk per peer — push draft dibatasi
 * ~1,5 detik (edit mode ~5 detik). Satu draft terminal per chat (klien Telegram belum
 * semua mendukung beberapa draft bersamaan), dan draft respons AI ditunda selagi
 * terminal streaming (lihat agentLoop.js).
 */

const fs = require("fs");
const ctx = require("./context");
const { sendDraft, sendMessageSafe } = require("./send");
const { killBackgroundJob } = require("../sandboxManager.js");

const DRAFT_PUSH_MS = Number(process.env.TERMINAL_STREAM_DRAFT_MS) || 1500;
const EDIT_PUSH_MS = Number(process.env.TERMINAL_STREAM_EDIT_MS) || 5000;
const WATCH_INTERVAL_MS = 1000;
const TAIL_MAX_CHARS = 3400;
const RAW_KEEP_CHARS = 20_000;
const STOP_PARAMS_ON = (process.env.TERMINAL_STREAM_STOP || "on").toLowerCase() !== "off";

/** jobId -> session; dan chatKey -> jobId untuk eksklusivitas draft per chat. */
const sessions = new Map();
const chatDraft = new Map();

// ============================================================
// FUNGSI MURNI (diuji di test/terminalStream.test.js)
// ============================================================

/** Buang escape sequence ANSI (warna/kursor output terminal). */
function stripAnsi(text) {
  return String(text || "").replace(
    /\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~]|\].*?(?:\x07|\x1B\\))/g,
    ""
  );
}

/**
 * Bersihkan output terminal agar aman ditampilkan di pesan Telegram:
 * buang ANSI, lipat progress-bar \r (ambil segmen terakhir per baris),
 * netralkan backtick agar code block Markdown tidak rusak.
 */
function sanitizeTerminalText(raw, maxChars = TAIL_MAX_CHARS) {
  let t = stripAnsi(raw);
  t = t
    .split("\n")
    .map((line) => {
      const parts = line.split("\r");
      return parts[parts.length - 1];
    })
    .join("\n");
  t = t.replace(/```/g, "``'");
  t = t.replace(/\n{4,}/g, "\n\n\n").trimEnd();
  if (t.length > maxChars) t = "…\n" + t.slice(-maxChars);
  return t;
}

const STATE_LABEL = { running: "⏳", ok: "✅", failed: "❌", stopped: "🛑" };

/** Susun teks pesan terminal. state: running | ok | failed | stopped. */
function formatTerminalMessage({ jobId, command, elapsedSec, tail, state, exitCode }) {
  const cmd = String(command || "").replace(/\s+/g, " ").trim().slice(0, 70);
  const head =
    `${STATE_LABEL[state] || "🖥️"} Terminal — ${jobId} · ${cmd}\n` +
    (state === "running"
      ? `berjalan ${Math.round(elapsedSec)}s`
      : `selesai ${Math.round(elapsedSec)}s${exitCode !== null && exitCode !== undefined ? ` · exit ${exitCode}` : ""}`);
  const body = tail ? `\n\n\`\`\`\n${tail}\n\`\`\`` : "";
  return `${head}${body}`;
}

/** Isi file .exit -> kode exit (angka) atau null. */
function parseExitContent(content) {
  const m = String(content || "").trim().match(/^(\d+)$/);
  return m ? Number(m[1]) : null;
}

// ============================================================
// SESI STREAM
// ============================================================

function chatKey(chatId, threadId) {
  return threadId ? `${chatId}_t${threadId}` : String(chatId);
}

/** true jika ada draft terminal aktif di chat ini (untuk menunda draft respons AI). */
function isDraftStreaming(chatId) {
  return chatDraft.has(String(chatId));
}

/**
 * Mulai stream terminal untuk satu job background.
 * @returns {object|null} sesi, atau null jika fitur dimatikan / input tidak lengkap.
 */
function startTerminalStream(jobId, { sessionId, chatId, threadId, logPath, exitPath, command }) {
  if ((process.env.TERMINAL_STREAM || "on").toLowerCase() === "off") return null;
  if (!jobId || !chatId || !logPath) return null;

  const key = chatKey(chatId, threadId);
  const draftMode = Number(chatId) > 0 && !chatDraft.has(String(chatId));

  const session = {
    jobId,
    sessionId,
    chatId,
    threadId: threadId || null,
    command: command || "",
    logPath,
    exitPath,
    draftMode,
    draftId: draftMode ? Number(String(jobId).replace(/\D/g, "")) || Math.floor(Math.random() * 1e9) : null,
    messageId: null,
    offset: 0,
    raw: "",
    lastText: "",
    lastPush: 0,
    startedAt: Date.now(),
    done: false,
    timer: null
  };

  sessions.set(jobId, session);
  if (draftMode) chatDraft.set(String(chatId), jobId);
  session.timer = setInterval(() => {
    tickSession(session).catch((err) => console.warn(`[TerminalStream] tick ${jobId}:`, err.message));
  }, WATCH_INTERVAL_MS);
  if (session.timer.unref) session.timer.unref();

  // Push pertama segera supaya user langsung melihat pesannya.
  tickSession(session).catch(() => {});
  return session;
}

async function readNewBytes(session) {
  let size;
  try {
    size = fs.statSync(session.logPath).size;
  } catch {
    return false; // log belum dibuat
  }
  if (size < session.offset) {
    // file di-truncate (job baru menimpa log) — mulai ulang
    session.offset = 0;
    session.raw = "";
  }
  if (size === session.offset) return false;

  const len = Math.min(size - session.offset, 512 * 1024);
  const buf = Buffer.alloc(len);
  const fd = fs.openSync(session.logPath, "r");
  try {
    fs.readSync(fd, buf, 0, len, session.offset);
  } finally {
    fs.closeSync(fd);
  }
  session.offset += len;
  session.raw = (session.raw + buf.toString("utf8")).slice(-RAW_KEEP_CHARS);
  return true;
}

function exitCodeOfSession(session) {
  try {
    return parseExitContent(fs.readFileSync(session.exitPath, "utf8"));
  } catch {
    return null;
  }
}

async function tickSession(session) {
  if (session.done) return;

  const dirty = await readNewBytes(session);
  const exitCode = exitCodeOfSession(session);
  if (exitCode !== null) {
    await finalizeTerminalStream(session, exitCode);
    return;
  }

  const now = Date.now();
  const cadence = session.draftMode ? DRAFT_PUSH_MS : EDIT_PUSH_MS;
  // Header pesan terminal langsung tampil (push pertama walau log masih kosong).
  if ((!dirty && session.lastText) || now - session.lastPush < cadence) return;
  await pushSession(session, "running");
}

async function pushSession(session, state, exitCode = null) {
  const tail = sanitizeTerminalText(session.raw);
  const text = formatTerminalMessage({
    jobId: session.jobId,
    command: session.command,
    elapsedSec: (Date.now() - session.startedAt) / 1000,
    tail,
    state,
    exitCode
  });
  if (text === session.lastText) return;
  session.lastText = text;
  session.lastPush = Date.now();

  const bot = ctx.bot;
  if (!bot) return;

  if (session.draftMode) {
    const extra = STOP_PARAMS_ON ? { can_stop: true, keep_on_stop: true } : {};
    await sendDraft(session.chatId, session.draftId, text, session.threadId, extra);
  } else if (!session.messageId) {
    const sent = await sendMessageSafe(session.chatId, text, {
      ...(session.threadId ? { message_thread_id: session.threadId } : {}),
      reply_markup: terminalKeyboard(session.jobId)
    });
    if (sent && sent.message_id) session.messageId = sent.message_id;
  } else {
    try {
      await bot.editMessageText(text, {
        chat_id: session.chatId,
        message_id: session.messageId,
        parse_mode: "Markdown",
        reply_markup: terminalKeyboard(session.jobId),
        ...(session.threadId ? { message_thread_id: session.threadId } : {})
      });
    } catch (err) {
      if (!/message is not modified/i.test(err.message)) {
        // Markdown ditolak (karakter aneh dari output) — coba tanpa format.
        try {
          await bot.editMessageText(text.replace(/[*_`]/g, ""), {
            chat_id: session.chatId,
            message_id: session.messageId,
            reply_markup: terminalKeyboard(session.jobId),
            ...(session.threadId ? { message_thread_id: session.threadId } : {})
          });
        } catch (_) { /* biarkan push berikutnya mencoba lagi */ }
      }
    }
  }
}

function terminalKeyboard(jobId) {
  return {
    inline_keyboard: [
      [
        { text: "⏹ Stop", callback_data: `term_stop:${jobId}` },
        { text: "📄 Log lengkap", callback_data: `term_log:${jobId}` }
      ]
    ]
  };
}

/** Finalisasi: pesan final (draft auto-bersih setelahnya / edit terakhir tanpa tombol). */
async function finalizeTerminalStream(session, exitCode, { stopped = false } = {}) {
  if (session.done) return;
  session.done = true;
  if (session.timer) clearInterval(session.timer);
  sessions.delete(session.jobId);
  if (session.draftMode) {
    const key = String(session.chatId);
    if (chatDraft.get(key) === session.jobId) chatDraft.delete(key);
  }

  const tail = sanitizeTerminalText(session.raw);
  const state = stopped ? "stopped" : exitCode === 0 ? "ok" : "failed";
  const text = formatTerminalMessage({
    jobId: session.jobId,
    command: session.command,
    elapsedSec: (Date.now() - session.startedAt) / 1000,
    tail,
    state,
    exitCode
  });

  try {
    if (session.draftMode) {
      // Pesan normal membuat draft streaming hilang otomatis (perilaku Telegram).
      await sendMessageSafe(session.chatId, text, session.threadId ? { message_thread_id: session.threadId } : {});
    } else if (session.messageId) {
      await ctx.bot.editMessageText(text, {
        chat_id: session.chatId,
        message_id: session.messageId,
        ...(session.threadId ? { message_thread_id: session.threadId } : {}),
        reply_markup: { inline_keyboard: [] }
      }).catch(() => {});
    }
  } catch (err) {
    console.warn(`[TerminalStream] finalisasi ${session.jobId}:`, err.message);
  }
}

// ============================================================
// STOP: native (MessageGenerationStopped) & tombol (grup)
// ============================================================

async function stopSession(session, reason) {
  killBackgroundJob(session.sessionId, session.jobId);
  await finalizeTerminalStream(session, exitCodeOfSession(session), { stopped: true });
  void reason;
}

/**
 * Update `stopped_message_generation` dari Telegram (user menekan stop di draft
 * native). Dipanggil dari bot.js via monkey-patch processUpdate.
 * @returns {boolean} true jika update ini milik draft terminal.
 */
async function handleGenerationStopped(stopped) {
  const chatId = String(stopped?.chat?.id ?? "");
  const draftId = Number(stopped?.draft_id);
  if (!chatId || !Number.isFinite(draftId)) return false;

  for (const session of sessions.values()) {
    if (session.draftMode && String(session.chatId) === chatId && session.draftId === draftId) {
      await stopSession(session, "dihentikan lewat tombol stop Telegram");
      return true;
    }
  }
  return false;
}

/** Tombol ⏹ Stop / 📄 Log lengkap pada mode grup (bot/callbacks.js). */
async function handleTerminalCallback(query) {
  const bot = ctx.bot;
  const [action, jobId] = String(query.data).split(":");
  const session = sessions.get(jobId);

  if (action === "term_stop") {
    if (!session) {
      return bot.answerCallbackQuery(query.id, { text: "Job ini sudah tidak berjalan." });
    }
    await stopSession(session, "dihentikan lewat tombol Stop");
    return bot.answerCallbackQuery(query.id, { text: "🛑 Proses dihentikan." });
  }

  if (action === "term_log") {
    if (!session || !fs.existsSync(session.logPath)) {
      return bot.answerCallbackQuery(query.id, { text: "Log tidak tersedia." });
    }
    try {
      await bot.sendDocument(query.message.chat.id, session.logPath, {
        ...(session.threadId ? { message_thread_id: session.threadId } : {})
      });
      return bot.answerCallbackQuery(query.id);
    } catch (err) {
      return bot.answerCallbackQuery(query.id, { text: `Gagal kirim log: ${err.message}` });
    }
  }
  return bot.answerCallbackQuery(query.id);
}

module.exports = {
  startTerminalStream,
  finalizeTerminalStream,
  handleGenerationStopped,
  handleTerminalCallback,
  isDraftStreaming,
  // fungsi murni untuk unit test
  stripAnsi,
  sanitizeTerminalText,
  formatTerminalMessage,
  parseExitContent
};
