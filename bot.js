process.env.NTBA_FIX_350 = 1;
require("dotenv").config();
const TelegramBot = require("node-telegram-bot-api");
const OpenAI = require("openai");
const axios = require("axios");
const pdf = require("pdf-parse");
const mammoth = require("mammoth");
const AdmZip = require("adm-zip"); // <-- Tambahan modul untuk membaca ZIP

const fs = require("fs");
const path = require("path");

// Import semua helper database dari onlyxHelper.js (Onlyx DB)
const {
  saveMemory,
  getHistory,
  getHistoryForAI,
  getReplyContext,
  getChatState,
  updateChatSummary,
  getMessagesToSummarize,
  newTopic,
  getBotConfig,
  saveBotConfig,
  resetBotConfig,
  getUserAccess,
  setUserAccess,
  setChatPaused,
  isChatPaused
} = require("./onlyxHelper.js");

// Import modul agent tools untuk kemampuan AI Agent (tool-calling)
const { TOOL_DEFINITIONS, executeTool, describeToolCall } = require("./agentTools.js");
const { resetSandbox, getSandboxInfo } = require("./sandboxManager.js");
const { initScheduler, listTasks, removeTask } = require("./schedulerManager.js");
const { transcribeAudio } = require("./voiceManager.js");
const { onRenderComplete, onRenderProgress, STAGE_LABEL } = require("./remotionManager.js");
const { createShareLink } = require("./videoShareManager.js");
const {
  ensureWorkspaceStructure,
  appendRawLog,
  getInjectedMemoryContext
} = require("./workspaceMemoryManager.js");
const skillsManager = require("./skillsManager.js");

const OWNER_ID = process.env.OWNER_ID ? String(process.env.OWNER_ID).trim() : "7368157605";
const CONFIG_FILE = path.join(__dirname, "config.json");

// Bot API menolak upload > 50 MB, jadi video di atas ambang ini dikirim sebagai link unduhan.
const TELEGRAM_SEND_MAX_MB = Number(process.env.TELEGRAM_SEND_MAX_MB) || 48;

const bot = new TelegramBot(process.env.BOT_TOKEN, { polling: true });
initScheduler(bot);

/**
 * PROGRES RENDER DI CHAT
 *
 * Render video makan menit, jadi user melihat satu pesan yang di-edit di tempat dengan
 * persen, jumlah frame, dan sisa waktu perkiraan Remotion sendiri. Pesan dihapus begitu
 * hasil final (video atau link) dikirim.
 */
const renderProgressState = new Map(); // jobId -> { messageId, stage, lastEdit }
const PROGRESS_EDIT_MS = 20_000;

function renderProgressBar(percent) {
  const filled = Math.max(0, Math.min(10, Math.round((percent || 0) / 10)));
  return "▓".repeat(filled) + "░".repeat(10 - filled);
}

function humanizeSeconds(sec) {
  const s = Math.max(0, Math.round(sec || 0));
  if (s < 60) return `${s} detik`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} menit`;
  return `${Math.floor(m / 60)} jam ${m % 60} menit`;
}

async function updateRenderProgress(job, progress) {
  if (!job.chatId || process.env.RENDER_PROGRESS_MESSAGE === "off") return;

  const st = renderProgressState.get(job.id) || {};
  const stageChanged = st.stage !== progress.stage;
  if (progress.stage === "done" && !st.messageId) return;
  if (st.messageId && !stageChanged && Date.now() - st.lastEdit < PROGRESS_EDIT_MS) return;

  const sisa = progress.remainingText
    ? `sisa ±${progress.remainingText}`
    : `sisa ±${humanizeSeconds((job.estimateSec || 0) - (progress.elapsedSec || 0))}`;

  const text =
    `🎬 Render #${job.id} — ${String(job.options?.title || "video").replace(/\s+/g, " ").slice(0, 40)}\n` +
    `${renderProgressBar(progress.percent)} ${Math.round(progress.percent || 0)}%\n` +
    `• ${STAGE_LABEL[progress.stage] || progress.stage}${progress.total ? ` · ${progress.rendered}/${progress.total} frame` : ""}\n` +
    `• ${sisa} · sudah jalan ${humanizeSeconds(progress.elapsedSec)}\n` +
    `• Video ${job.duration} detik — hasilnya dikirim otomatis ke chat ini`;

  const sendOpts = job.threadId ? { message_thread_id: job.threadId } : {};
  try {
    if (st.messageId) {
      await bot.editMessageText(text, { chat_id: job.chatId, message_id: st.messageId, ...sendOpts });
    } else {
      const sent = await bot.sendMessage(job.chatId, text, sendOpts);
      st.messageId = sent.message_id;
    }
    st.stage = progress.stage;
    st.lastEdit = Date.now();
    renderProgressState.set(job.id, st);
  } catch (err) {
    // Kegagalan update progres tidak boleh menggagalkan render.
    console.warn(`[Remotion Queue] Update progres job #${job.id} gagal: ${err.message}`);
    if (/not found|not modified|too old|message can't be edited/i.test(err.message)) {
      renderProgressState.delete(job.id);
    }
  }
}

async function clearRenderProgress(job) {
  const st = renderProgressState.get(job.id);
  renderProgressState.delete(job.id);
  if (!st?.messageId) return;
  try {
    await bot.deleteMessage(job.chatId, st.messageId);
  } catch (_) {
    // Pesan mungkin sudah dihapus manual; tidak penting.
  }
}

onRenderProgress((job, progress) => {
  updateRenderProgress(job, progress).catch((err) =>
    console.warn(`[Remotion Queue] Handler progres job #${job.id} error:`, err.message)
  );
});

// Render video berjalan di latar belakang, jadi hasilnya dikirim ke chat
// saat job selesai — bukan lewat jawaban AI yang sudah lama berakhir.
// Video yang lebih besar dari batas upload bot dikirim sebagai link unduhan (Cloudflare Tunnel),
// karena kompres paksa sampai muat 50 MB akan menghancurkan kualitasnya.
async function deliverRenderResult(job) {
  const res = job.result || {};
  const sendOpts = job.threadId ? { message_thread_id: job.threadId } : {};

  if (!res.success || !res.videoPath || !fs.existsSync(res.videoPath)) {
    await bot.sendMessage(
      job.chatId,
      `❌ Render video (job #${job.id}) gagal:\n${String(res.error || "penyebab tidak diketahui").slice(0, 800)}`,
      sendOpts
    );
    return;
  }

  const sizeMb = fs.statSync(res.videoPath).size / (1024 * 1024);
  const kirimSebagaiLink = async () => {
    const share = await createShareLink(res.videoPath, { chatId: job.chatId });
    const kadarKedaluwarsa = new Date(share.expiresAt).toLocaleString("id-ID", { timeZone: "Asia/Jakarta" });
    await bot.sendMessage(
      job.chatId,
      `🎬 Video selesai dirender (job #${job.id}) — tapi ukurannya ${share.sizeMb} MB, di atas batas upload bot 50 MB, jadi diambil lewat link.\n\n` +
        `🔗 ${share.url}\n\n` +
        `• Durasi: ${res.duration} detik\n` +
        `• Ukuran: ${share.sizeMb} MB\n` +
        `• Waktu render: ${res.elapsedSec} detik\n` +
        `• Link aktif sampai ${kadarKedaluwarsa} WIB, bisa langsung diputar dan di-seek di browser HP.` +
        (share.ready ? "" : "\n• Link baru akan bisa dibuka ±1 menit lagi (DNS Cloudflare masih menyebarkan alamatnya).") +
        `\nKalau link tidak terbuka (server baru saja direstart), bilang saja — aku kirim link baru.`,
      sendOpts
    );
    console.log(`[Remotion Queue] Job #${job.id} dikirim sebagai link unduhan (${share.sizeMb} MB > ${TELEGRAM_SEND_MAX_MB} MB, ready=${share.ready}).`);
  };

  if (sizeMb > TELEGRAM_SEND_MAX_MB) {
    try {
      await kirimSebagaiLink();
    } catch (err) {
      console.error(`[Remotion Queue] Gagal membuat link unduhan job #${job.id}:`, err.message);
      await bot.sendMessage(
        job.chatId,
        `🎬 Video job #${job.id} sudah jadi (${sizeMb.toFixed(1)} MB) tapi link unduhannya gagal dibuat: ${err.message}\n` +
          `File tersimpan di workspace sebagai ${path.basename(res.videoPath)}.`,
        sendOpts
      );
    }
    return;
  }

  try {
    await bot.sendVideo(
      job.chatId,
      res.videoPath,
      {
        caption:
          `🎬 *Video Selesai Dirender* (job #${job.id})\n` +
          `• File: \`${path.basename(res.videoPath)}\`\n` +
          `• Durasi: ${res.duration} detik\n` +
          `• Ukuran: ${res.sizeMb} MB\n` +
          `• Waktu render: ${res.elapsedSec} detik`,
        parse_mode: "Markdown",
        supports_streaming: true,
        ...sendOpts
      }
    );
  } catch (err) {
    // Telegram masih bisa menolak (413) untuk file di dekat batas; link adalah jalan keluar.
    if (/413|too large/i.test(err.message)) {
      console.warn(`[Remotion Queue] Job #${job.id} ditolak Telegram (413), beralih ke link unduhan.`);
      try {
        await kirimSebagaiLink();
        return;
      } catch (linkErr) {
        console.error(`[Remotion Queue] Fallback link job #${job.id} juga gagal:`, linkErr.message);
      }
    }
    throw err;
  }
}

onRenderComplete(async (job) => {
  if (!job.chatId) {
    console.warn(`[Remotion Queue] Job #${job.id} selesai tapi tidak punya chatId, hasil tidak dikirim.`);
    return;
  }
  try {
    await deliverRenderResult(job);
  } catch (err) {
    console.error(`[Remotion Queue] Gagal mengirim hasil job #${job.id} ke chat ${job.chatId}:`, err.message);
  } finally {
    await clearRenderProgress(job);
  }
});

let BOT_USERNAME = "NrozBot";
bot.getMe().then((me) => {
  if (me && me.username) {
    BOT_USERNAME = me.username;
    console.log(`[Bot] Terhubung sebagai @${BOT_USERNAME} (ID: ${me.id})`);
  }
  if (me && !me.can_read_all_group_messages) {
    console.warn(`[Bot Warning] Group Privacy Mode aktif (can_read_all_group_messages: false). Telegram TIDAK AKAN mengirim pesan biasa di supergroup ke bot kecuali ditag! Jadikan bot sebagai Admin di supergroup atau matikan Privacy Mode via @BotFather.`);
  }
}).catch((err) => {
  console.warn("[Bot] Gagal membaca info profil bot:", err.message);
});

// Nilai default dari .env
const defaultConfig = {
  apiKey: process.env.API_KEY || "",
  baseUrl: (process.env.BASE_URL || "").replace(/\/+$/, ""),
  model: process.env.MODEL || ""
};

let currentConfig = { ...defaultConfig };

// Baca dari config.json lokal jika ada (agar langsung siap saat bot start)
try {
  if (fs.existsSync(CONFIG_FILE)) {
    const local = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf-8"));
    if (local.apiKey) currentConfig.apiKey = local.apiKey;
    if (local.baseUrl) currentConfig.baseUrl = local.baseUrl.replace(/\/+$/, "");
    if (local.model) currentConfig.model = local.model;
  }
} catch (e) {
  console.warn("[Config] Gagal membaca config.json lokal:", e.message);
}

// Inisialisasi client OpenAI
let client = new OpenAI({
  apiKey: currentConfig.apiKey,
  baseURL: currentConfig.baseUrl
});

function refreshClient() {
  client = new OpenAI({
    apiKey: currentConfig.apiKey,
    baseURL: currentConfig.baseUrl
  });
}

function saveLocalConfig() {
  try {
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(currentConfig, null, 2), "utf-8");
  } catch (e) {
    console.warn("[Config] Gagal menyimpan config.json lokal:", e.message);
  }
}

// Sinkronisasi dari Onlyx DB saat startup
(async () => {
  try {
    const remote = await getBotConfig();
    if (remote) {
      if (remote.apiKey) currentConfig.apiKey = remote.apiKey;
      if (remote.baseUrl) currentConfig.baseUrl = remote.baseUrl.replace(/\/+$/, "");
      if (remote.model) currentConfig.model = remote.model;
      refreshClient();
      saveLocalConfig();
      console.log(`[Config] Pengaturan sinkron dari Onlyx DB (Model: ${currentConfig.model})`);
    } else {
      console.log(`[Config] Menggunakan pengaturan default (Model: ${currentConfig.model})`);
    }
  } catch (err) {
    console.warn("[Config] Gagal sinkronisasi DB saat startup:", err.message);
  }
})();

function maskKey(key) {
  if (!key) return "(belum diatur)";
  if (key.length <= 10) return "********";
  return key.slice(0, 7) + "..." + key.slice(-4);
}

function isOwner(msg) {
  const senderId = String(msg.from?.id || "");
  return OWNER_ID && senderId === OWNER_ID;
}

// === SUMMARY BUFFER BACKGROUND COMPACTION (ALA ANTIGRAVITY) ===
const activeSummaries = new Set();

async function triggerBackgroundCompaction(chatId) {
  const key = String(chatId);
  if (activeSummaries.has(key)) return;

  activeSummaries.add(key);
  try {
    // Ambil pesan-pesan lama jika total obrolan belum dipadatkan sudah >= 10 pesan
    // Menyisakan 4 pesan terbaru di working memory
    const data = await getMessagesToSummarize(chatId, 4, 10);
    if (!data) return;

    const { currentSummary, messagesToSummarize, upToTs } = data;

    const formatted = messagesToSummarize
      .map((m) => `${m.role.toUpperCase()}: ${m.content.slice(0, 400)}`)
      .join("\n\n");

    const prompt = 
`Kamu adalah asisten pengelola memori percakapan AI. Tugasmu adalah memperbarui ringkasan obrolan antara User dan Assistant agar tetap padat dan mempertahankan konteks jangka panjang.

${currentSummary ? `[Ringkasan Sebelumnya]:\n${currentSummary}\n\n` : ""}[Potongan Obrolan Baru yang Perlu Dirangkum]:
${formatted}

Instruksi:
1. Buat ringkasan baru yang menggabungkan konteks lama dan obrolan baru di atas.
2. Catat informasi krusial seperti: nama user, preferensi, topik diskusi, dan fakta penting.
3. Tulis maksimal 3-5 kalimat ringkas berbahasa Indonesia tanpa basa-basi atau kata pembuka.`;

    const res = await client.chat.completions.create({
      model: currentConfig.model,
      messages: [{ role: "user", content: prompt }],
      temperature: 0.3
    });

    const newSummary = res.choices[0]?.message?.content?.trim();
    if (newSummary && newSummary.length > 0) {
      await updateChatSummary(chatId, newSummary, upToTs);
      console.log(`[Summary Compaction] Berhasil memadatkan memori chat ${chatId}`);
    }
  } catch (err) {
    console.warn(`[Summary Compaction] Gagal memadatkan chat ${chatId}:`, err.message);
  } finally {
    activeSummaries.delete(key);
  }
}

// === SISTEM PROMPT INTI (LEAN CORE) DENGAN ON-DEMAND SKILLS (ALA ANTIGRAVITY) ===
function getBaseSystemPrompt() {
  const skillsIndex = skillsManager.getSkillsPromptIndex();
  return `Kamu adalah Nroz AI, asisten dan AI Agent yang cerdas, praktis, dan serba bisa.
Kemampuan AI Agent & Eksekusi di VPS Terisolasi (Persistent Docker Sandbox):
- Kamu memiliki akses tools lengkap:
  1. run_command: menjalankan perintah terminal Linux di dalam Persistent Docker Sandbox user terisolasi. Kamu memiliki hak akses root di container. Gunakan \`background: true\` untuk perintah lama tanpa memakai sleep.
  2. run_code: menjalankan potongan kode (JavaScript/Node.js, Python 3, Bash) secara instan.
  3. web_search: mencari informasi internet terbaru via DuckDuckGo.
  4. read_url: membaca isi konten halaman web/artikel.
  5. http_request: memanggil API REST eksternal.
  6. file_read, file_write, file_list: mengelola file dan kode di server/workspace.
  7. system_info: memantau beban CPU, RAM, disk VPS.
  8. start_web_preview: membuka URL publik HTTPS instan (Cloudflare Tunnel) untuk web app lokal di sandbox.
  9. create_reminder: menjadwalkan pengingat/alarm pesan Telegram untuk user.
  10. create_watchdog: memantau uptime/status website atau server dan memberi notifikasi otomatis jika down.
  11. media_download: mengunduh video atau audio dari link internet (YouTube, TikTok, Instagram, Twitter/X, dll).
  12. render_remotion_video: membuat dan merender video animasi berkualitas tinggi (MP4) dari kode React/Remotion.
  13. check_command_output: membaca status dan output perintah yang dijalankan dengan run_command {"background": true}.
  14. delegate_task: mendelegasikan tugas berat/multi-langkah ke Subagent Mandiri dengan context terisolasi ala Antigravity.
  15. record_decision: mencatat keputusan/pilihan user ke .memory/decisions.md agar selalu kamu ingat.
  16. update_project_context: memperbarui status proyek aktif ke .memory/project_context.md.
  17. search_raw_memory: mencari arsip chat masa lalu di .memory/raw/.
  18. send_photo: mengirim gambar/foto/grafik/diagram (.png, .jpg, .webp) dari workspace langsung ke chat Telegram user.
  19. send_file: mengirim file fisik/dokumen/arsip (.zip, .pdf, .txt, .csv, kode) dari workspace langsung ke chat Telegram user sebagai lampiran.
  20. read_skill: MEMBACA PANDUAN MENDALAM DARI KATALOG SKILL untuk keahlian tertentu sebelum mengeksekusi tugas.
- Gunakan tools yang tersedia kapan pun dibutuhkan secara proaktif. Jangan pernah bilang "saya tidak bisa" untuk hal yang bisa kamu lakukan dengan tools.

${skillsIndex}

Aturan Inti & Lingkungan Eksekusi:
- Kemandirian Sistem: Jika perintah terminal membutuhkan program atau dependensi yang belum terpasang ("command not found"), kamu memiliki izin penuh untuk menginstallnya secara otomatis menggunakan: \`apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y <nama_paket>\` (selalu gunakan flag -y agar tidak macet).
- Semua file dan foto yang dikirimkan user disimpan di workspace masing-masing di VPS:
  Path: /root/nroz/workspace/<chatId>/ (ter-mount ke /workspace di dalam sandbox).
- Pengiriman File Fisik:
  Gunakan tool \`send_file\` untuk dokumen/arsip atau \`send_photo\` untuk gambar. Kamu juga tetap bisa menyertakan tag teks <<<SENDFILE:/path/file>>> atau <<<SENDPHOTO:/path/gambar>>>.
- Struktur Workspace & Manajemen Memori AI:
  Folder kerjamu (/workspace) terorganisir rapi dengan zona:
  • /workspace/uploads/ : Berisi semua file/dokumen/foto mentah kiriman user (referensi asli).
  • /workspace/work/    : Tempat utama kamu ngoding, install dependensi, uji kode, dan jalankan server/script.
  • /workspace/artifacts/ : Tempat menyimpan hasil jadi/final (video MP4, ZIP project, gambar final siap kirim).
  • /workspace/.memory/ : Pusat memori cerdas kamu (decisions.md, project_context.md, raw/).
    - Gunakan tool \`record_decision\` setiap kali user menyetujui opsi/pilihan penting.
    - Gunakan tool \`update_project_context\` setiap kali ada perubahan status atau milestone proyek.
    - Gunakan tool \`search_raw_memory\` hanya jika butuh mencari riwayat obrolan masa lalu yang spesifik.

Kemampuan Tambahan Membuat File Baru:
Jika user meminta untuk membuatkan file baru atau file ZIP dari awal:
Gunakan tag:
<<<FILE:path/ke/nama_file.ext>>>
(isi konten file di sini)
<<<ENDFILE>>>
Jika ingin menentukan nama file ZIP tertentu (misal: project.zip), sertakan:
<<<ZIP:nama_file.zip>>>

Format Tabel & Respon:
- Jika user meminta perbandingan, jadwal, daftar harga, spesifikasi, atau data terstruktur, selalu sajikan dalam format Markdown Table standar dengan header dan pemisah kolom.
- Berikan respon yang ramah, ringkas, solutif, dan profesional.`;
}

function buildMessagesWithSystem(historyMessages, sessionId = null) {
  let systemContent = getBaseSystemPrompt();
  if (sessionId) {
    const memoryInject = getInjectedMemoryContext(sessionId);
    if (memoryInject) {
      systemContent += `\n\n=== MEMORI PROYEK & KEPUTUSAN TERKINI ===\n${memoryInject}`;
    }
  }
  return [
    { role: "system", content: systemContent },
    ...historyMessages
  ];
}

function sanitizePath(filePath) {
  if (!filePath) return "";
  return filePath
    .trim()
    .replace(/^(\/|\\)+/, "") // Hapus slash di awal
    .replace(/\.\.+[\/\\]/g, "") // Cegah path traversal ../
    .replace(/[<>:"|?*]/g, ""); // Hapus karakter tidak valid pada file sistem
}

// === PENGELOLAAN WORKSPACE USER & AUTO-CLEANUP ===
const WORKSPACE_BASE = path.join(__dirname, "workspace");
if (!fs.existsSync(WORKSPACE_BASE)) {
  fs.mkdirSync(WORKSPACE_BASE, { recursive: true });
}

function getChatWorkspace(sessionId) {
  const safeSession = String(sessionId).trim().replace(/[^a-zA-Z0-9_\-]/g, "_");
  const dir = path.join(WORKSPACE_BASE, safeSession);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return dir;
}

/**
 * Auto-cleanup: membersihkan file dan folder di workspace yang berusia lebih dari N hari.
 * @param {number} maxAgeDays - Batas usia file dalam hari (default 3 hari)
 * @returns {{ deletedCount: number, freedBytes: number }}
 */
function cleanupOldWorkspaceFiles(maxAgeDays = 3) {
  if (!fs.existsSync(WORKSPACE_BASE)) return { deletedCount: 0, freedBytes: 0 };

  const MAX_AGE_MS = maxAgeDays * 24 * 60 * 60 * 1000;
  const now = Date.now();
  let deletedCount = 0;
  let freedBytes = 0;

  try {
    const userDirs = fs.readdirSync(WORKSPACE_BASE);
    for (const userDir of userDirs) {
      const userDirPath = path.join(WORKSPACE_BASE, userDir);
      try {
        const userDirStat = fs.statSync(userDirPath);
        if (!userDirStat.isDirectory()) continue;

        const items = fs.readdirSync(userDirPath);
        for (const item of items) {
          const itemPath = path.join(userDirPath, item);
          try {
            const itemStat = fs.statSync(itemPath);
            const ageMs = now - itemStat.mtimeMs;

            if (ageMs > MAX_AGE_MS) {
              freedBytes += itemStat.size || 0;
              fs.rmSync(itemPath, { recursive: true, force: true });
              deletedCount++;
            }
          } catch (_) {}
        }

        // Hapus folder user jika kosong dan folder tersebut sudah berumur > maxAgeDays
        const remaining = fs.readdirSync(userDirPath);
        if (remaining.length === 0 && (now - userDirStat.mtimeMs > MAX_AGE_MS)) {
          try {
            fs.rmdirSync(userDirPath);
          } catch (_) {}
        }
      } catch (_) {}
    }

    if (deletedCount > 0) {
      const freedMb = (freedBytes / (1024 * 1024)).toFixed(2);
      console.log(`[Auto-Cleanup] Berhasil membersihkan ${deletedCount} item lama (> ${maxAgeDays} hari, freed ${freedMb} MB) di workspace.`);
    }
  } catch (err) {
    console.warn("[Auto-Cleanup] Error saat menjalankan pembersihan:", err.message);
  }

  return { deletedCount, freedBytes };
}

// Jalankan pembersihan saat startup bot...
cleanupOldWorkspaceFiles(3);

// ...dan jalankan secara berkala setiap 6 jam
const CLEANUP_INTERVAL_MS = 6 * 60 * 60 * 1000;
setInterval(() => {
  cleanupOldWorkspaceFiles(3);
}, CLEANUP_INTERVAL_MS);

function extractZipName(text, userPrompt = "") {
  // 1. Cek dari tag AI: <<<ZIP:nama.zip>>>
  const aiZipMatch = text.match(/<<<ZIP:\s*([a-zA-Z0-9_\-\.]+\.zip)\s*>>>/i);
  if (aiZipMatch) return path.basename(aiZipMatch[1].trim());

  // 2. Cek dari prompt user jika menyebutkan nama_file.zip (misal: contoh.zip)
  const userZipMatch = userPrompt.match(/\b([a-zA-Z0-9_\-]+\.zip)\b/i);
  if (userZipMatch) return path.basename(userZipMatch[1].trim());

  return "project.zip";
}

function cleanFileTags(text) {
  if (!text) return "";
  return text
    .replace(/<<<ZIP:\s*[^\n>]+\.zip\s*>>>/gi, "")
    .replace(/<<<SENDFILE:\s*[^\n>]+\s*>>>/gi, "")
    .replace(/<<<(?:SENDPHOTO|SENDIMAGE):\s*[^\n>]+\s*>>>/gi, "")
    .replace(/<<<SENDVIDEO:\s*[^\n>]+\s*>>>/gi, "")
    .replace(/<<<FILE:\s*([^\n>]+)>>>\s*\n([\s\S]*?)<<<ENDFILE>>>/gi, (match, fname, code) => {
      const ext = path.extname(fname).replace(".", "") || "";
      return `\`\`\`${ext}\n// File: ${fname}\n${code}\n\`\`\``;
    });
}

function extractFilesFromPrompt(prompt) {
  if (!prompt) return [];
  const list = [];
  const regex = /(?:^|[\s`*(\[])([a-zA-Z0-9_\-\.\/]+\.[a-zA-Z0-9_]{1,10})(?:$|[\s`*)\],:;])/g;
  let m;
  while ((m = regex.exec(prompt)) !== null) {
    const fn = sanitizePath(m[1]);
    if (!fn.endsWith(".zip") && fn.includes(".") && !fn.startsWith("http") && !list.includes(fn)) {
      list.push(fn);
    }
  }
  return list;
}

function detectFilename(fullText, codeBlockMatch, codeBlockIndex, promptFiles, blockIndex) {
  const info = codeBlockMatch[1].trim();
  const code = codeBlockMatch[2].trimEnd();

  // 1. Info string code block: ```html:public/index.html atau ```public/index.html
  if (info) {
    const m = info.match(/(?:file:)?([a-zA-Z0-9_\-\.\/]+\.[a-zA-Z0-9_]{1,10})/i);
    if (m && m[1].includes(".")) return sanitizePath(m[1]);
  }

  // 2. Baris pertama komentar di dalam kode
  const firstLine = code.split("\n")[0].trim();
  const commentMatch = firstLine.match(/^(?:#|\/\/|\/\*|<!--|;)\s*(?:file:?\s*)?([a-zA-Z0-9_\-\.\/]+\.[a-zA-Z0-9_]{1,10})\b/i);
  if (commentMatch) {
    return sanitizePath(commentMatch[1]);
  }

  // 3. Teks tepat sebelum codeblock (sampai 300 karakter ke belakang)
  const prevText = fullText.slice(Math.max(0, codeBlockIndex - 300), codeBlockIndex);
  const pathRegex = /(?:`|\*\*|\#{1,6}\s*|\bfile:?\s*)([a-zA-Z0-9_\-\.\/]+\.[a-zA-Z0-9_]{1,10})/gi;
  let pMatch, lastCandidate = null;
  while ((pMatch = pathRegex.exec(prevText)) !== null) {
    const fn = sanitizePath(pMatch[1]);
    if (fn.includes(".") && !fn.startsWith("http") && !fn.endsWith(".zip")) {
      lastCandidate = fn;
    }
  }
  if (lastCandidate) return lastCandidate;

  // 4. Ambil dari nama file yang secara spesifik diminta user di prompt jika ada
  if (promptFiles && promptFiles.length > blockIndex) {
    return promptFiles[blockIndex];
  }

  // 5. Nama cerdas berdasarkan konten & bahasa (tidak pernah menggunakan file_1)
  const lang = info.toLowerCase();
  if (code.includes("<html") || lang === "html") return blockIndex === 0 ? "index.html" : `page_${blockIndex + 1}.html`;
  if (lang === "css" || code.includes("body {") || code.includes(":root")) return "style.css";
  if (lang === "javascript" || lang === "js") return blockIndex === 0 ? "index.js" : `script_${blockIndex + 1}.js`;
  if (lang === "typescript" || lang === "ts") return blockIndex === 0 ? "index.ts" : `script_${blockIndex + 1}.ts`;
  if (lang === "python" || lang === "py") return blockIndex === 0 ? "main.py" : `script_${blockIndex + 1}.py`;
  if (lang === "json") return "data.json";

  return `script_${blockIndex + 1}.txt`;
}

function extractFilesFromAnswer(text, userPrompt = "") {
  const files = [];

  // 1. Pola eksplisit tag <<<FILE:path/ke/nama_file.ext>>> ... <<<ENDFILE>>>
  const explicitRegex = /<<<FILE:\s*([^\n>]+)>>>\s*\n([\s\S]*?)<<<ENDFILE>>>/gi;
  let match;
  while ((match = explicitRegex.exec(text)) !== null) {
    const filename = sanitizePath(match[1]);
    const content = match[2].trimEnd();
    if (filename && content) files.push({ filename, content });
  }

  // 2. Pola fallback cerdas jika AI menggunakan codeblock standar
  if (files.length === 0) {
    const wantsFile = /file|dokumen|script|unduh|download|kirim.*file|jadikan.*zip|buatkan.*zip|isinya/i.test(userPrompt);
    if (wantsFile) {
      const promptFiles = extractFilesFromPrompt(userPrompt);
      const codeblockRegex = /```([a-zA-Z0-9_\-\.\:\=\s]*)\n([\s\S]*?)```/g;
      let count = 0;
      while ((match = codeblockRegex.exec(text)) !== null) {
        const code = match[2].trimEnd();
        if (!code) continue;

        const filename = detectFilename(text, match, match.index, promptFiles, count++);
        files.push({ filename, content: code });
      }
    }
  }

  return files;
}

/**
 * Menerjemahkan path dari model (baik /workspace/..., path host, atau path relatif)
 * ke path absolut host yang benar di dalam workspace user.
 */
function resolveToHost(rawPath, sessionId) {
  if (!rawPath || typeof rawPath !== "string") return "";
  const clean = rawPath.trim();
  const userWs = getChatWorkspace(sessionId);

  // Jika format sandbox /workspace/...
  if (clean === "/workspace") return userWs;
  if (clean.startsWith("/workspace/")) {
    const candidateDirect = path.join(userWs, clean.slice("/workspace/".length));
    if (fs.existsSync(candidateDirect)) return candidateDirect;
    // Cek juga di folder artifacts/ jika nama file cocok
    const candidateInArtifacts = path.join(userWs, "artifacts", path.basename(clean));
    if (fs.existsSync(candidateInArtifacts)) return candidateInArtifacts;
    return candidateDirect;
  }

  // Jika sudah merupakan path host di workspace
  if (clean.startsWith("/root/nroz/workspace/")) {
    return path.resolve(clean);
  }

  // Jika path absolut lain tapi ada di dalam userWs
  if (path.isAbsolute(clean)) {
    const candidateInWs = path.join(userWs, clean.replace(/^\/+/, ""));
    if (fs.existsSync(candidateInWs)) return candidateInWs;
    const candidateInArtifacts = path.join(userWs, "artifacts", path.basename(clean));
    if (fs.existsSync(candidateInArtifacts)) return candidateInArtifacts;
    return path.resolve(clean);
  }

  // Path relatif: cek langsung di userWs
  const directPath = path.resolve(userWs, clean);
  if (fs.existsSync(directPath)) return directPath;

  // Cek jika ada di userWs/artifacts/
  const inArtifacts = path.resolve(userWs, "artifacts", clean);
  if (fs.existsSync(inArtifacts)) return inArtifacts;

  return directPath;
}

async function handleGeneratedFiles(chatId, msg, rawAnswer, userPrompt, turnMediaSent = { photos: 0, files: 0 }) {
  try {
    const sendOpts = {};
    if (msg.message_thread_id) {
      sendOpts.message_thread_id = msg.message_thread_id;
    }
    const sessionId = getSessionId(msg);
    const userWs = getChatWorkspace(sessionId);

    // 1. Cek jika AI meminta mengirimkan file fisik dari server (<<<SENDFILE:/path/ke/file>>>)
    const sendFileMatches = [...rawAnswer.matchAll(/<<<SENDFILE:\s*([^\n>]+)>>>/gi)];
    for (const match of sendFileMatches) {
      const rawPath = match[1].trim();
      const targetPath = resolveToHost(rawPath, sessionId);
      try {
        if (fs.existsSync(targetPath)) {
          const stats = fs.statSync(targetPath);
          if (stats.isFile()) {
            const fileName = path.basename(targetPath);
            await bot.sendDocument(
              chatId,
              targetPath,
              {
                caption: `📦 *File dari Server:* \`${fileName}\``,
                parse_mode: "Markdown",
                ...sendOpts
              }
            );
            turnMediaSent.files++;
          }
        }
      } catch (err) {
        console.error(`[SendFile Error] Gagal kirim file fisik ${targetPath}:`, err.message);
      }
    }

    // 1.5 Cek jika AI meminta mengirimkan foto / grafik / visualisasi data (<<<SENDPHOTO:...>>> atau <<<SENDIMAGE:...>>>)
    const sendPhotoMatches = [...rawAnswer.matchAll(/<<<(?:SENDPHOTO|SENDIMAGE):\s*([^\n>]+)>>>/gi)];
    for (const match of sendPhotoMatches) {
      const rawPath = match[1].trim();
      const targetPath = resolveToHost(rawPath, sessionId);
      try {
        if (fs.existsSync(targetPath)) {
          const stats = fs.statSync(targetPath);
          if (stats.isFile()) {
            const fileName = path.basename(targetPath);
            await bot.sendPhoto(
              chatId,
              targetPath,
              {
                caption: `🖼️ *Gambar / Visual:* \`${fileName}\``,
                parse_mode: "Markdown",
                ...sendOpts
              }
            );
            turnMediaSent.photos++;
          }
        }
      } catch (err) {
        console.error(`[SendPhoto Error] Gagal kirim foto ${targetPath}:`, err.message);
      }
    }

    // 1.8 Cek jika AI meminta mengirimkan video MP4 / Remotion (<<<SENDVIDEO:/path/ke/video.mp4>>>)
    const sendVideoMatches = [...rawAnswer.matchAll(/<<<SENDVIDEO:\s*([^\n>]+)>>>/gi)];
    for (const match of sendVideoMatches) {
      const rawPath = match[1].trim();
      const targetPath = resolveToHost(rawPath, sessionId);
      try {
        if (fs.existsSync(targetPath)) {
          const stats = fs.statSync(targetPath);
          if (stats.isFile()) {
            const fileName = path.basename(targetPath);
            await bot.sendVideo(
              chatId,
              targetPath,
              {
                caption: `🎬 *Video Dibuat:* \`${fileName}\``,
                parse_mode: "Markdown",
                supports_streaming: true,
                ...sendOpts
              }
            );
          }
        }
      } catch (err) {
        console.error(`[SendVideo Error] Gagal kirim video ${targetPath}:`, err.message);
      }
    }

    // 1.9 Fallback Cerdas: Jika user meminta gambar dan belum ada foto yang terkirim di turn ini
    if (turnMediaSent.photos === 0) {
      const isImageIntent = /\b(gambar|foto|lukis|image|photo|draw|chart|grafik|ilustrasi|diagram)\b/i.test(userPrompt || "");
      if (isImageIntent) {
        const imageExts = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif"]);
        const searchDirs = [path.join(userWs, "artifacts"), userWs];
        let newestImage = null;
        let newestMtime = 0;
        const now = Date.now();
        const MAX_IMAGE_AGE_MS = 3 * 60 * 1000; // 3 menit terakhir

        for (const dir of searchDirs) {
          if (fs.existsSync(dir)) {
            try {
              const files = fs.readdirSync(dir);
              for (const file of files) {
                const full = path.join(dir, file);
                try {
                  const st = fs.statSync(full);
                  if (st.isFile() && imageExts.has(path.extname(file).toLowerCase())) {
                    const age = now - st.mtimeMs;
                    if (age < MAX_IMAGE_AGE_MS && st.mtimeMs > newestMtime) {
                      newestMtime = st.mtimeMs;
                      newestImage = full;
                    }
                  }
                } catch (_) {}
              }
            } catch (_) {}
          }
        }

        if (newestImage) {
          console.log(`[AutoImageDelivery] Mengirimkan gambar terbaru hasil buatan AI ke chat: ${newestImage}`);
          const fileName = path.basename(newestImage);
          try {
            await bot.sendPhoto(chatId, newestImage, {
              caption: `🖼️ *Hasil Gambar:* \`${fileName}\``,
              parse_mode: "Markdown",
              ...sendOpts
            });
            turnMediaSent.photos++;
          } catch (autoErr) {
            console.error(`[AutoImageDelivery Error] Gagal kirim foto ${newestImage}:`, autoErr.message);
          }
        }
      }
    }

    // 2. File atau ZIP yang di-generate langsung dari AI code block
    const generatedFiles = extractFilesFromAnswer(rawAnswer, userPrompt);
    if (!generatedFiles || generatedFiles.length === 0) return;

    const wantsZip = /jadikan.*zip|buatkan.*zip|\.zip\b|arsip/i.test(userPrompt || "") || /<<<ZIP:/i.test(rawAnswer);

    if (generatedFiles.length === 1 && !wantsZip) {
      // Kirim 1 file tunggal
      const f = generatedFiles[0];
      const buf = Buffer.from(f.content, "utf8");
      await bot.sendDocument(
        chatId,
        buf,
        {
          caption: `📄 *File dibuat:* \`${f.filename}\``,
          parse_mode: "Markdown",
          ...sendOpts
        },
        {
          filename: path.basename(f.filename),
          contentType: "application/octet-stream"
        }
      );
    } else {
      // Kirim kumpulan file dalam bentuk ZIP (mendukung struktur folder seperti public/index.html)
      const zipName = extractZipName(rawAnswer, userPrompt);
      const zip = new AdmZip();
      for (const f of generatedFiles) {
        zip.addFile(f.filename, Buffer.from(f.content, "utf8"));
      }
      const zipBuffer = zip.toBuffer();
      const fileList = generatedFiles.map((f) => `• \`${f.filename}\``).join("\n");
      await bot.sendDocument(
        chatId,
        zipBuffer,
        {
          caption: `📦 *File ZIP dibuat:* \`${zipName}\`\n\n*Daftar isi file & folder:*\n${fileList}`,
          parse_mode: "Markdown",
          ...sendOpts
        },
        {
          filename: zipName,
          contentType: "application/zip"
        }
      );
    }
  } catch (err) {
    console.error("[File Generation Error] Gagal mengirim file/zip:", err.message);
  }
}

// === FUNGSI UTILITY ===
function cleanAnswer(text) {
  return text
    .replace(/\*\*/g, "*")    // Ubah **bold** (OpenAI) menjadi *bold* (Telegram Markdown)
    .replace(/### /g, "");     // Hapus simbol heading ###
}

function startTyping(chatId, threadId = null) {
  const opts = threadId ? { message_thread_id: threadId } : undefined;
  bot.sendChatAction(chatId, "typing", opts);
  return setInterval(() => {
    bot.sendChatAction(chatId, "typing", opts);
  }, 4050);
}

function stopTyping(interval) {
  if (interval) {
    clearInterval(interval);
  }
}

// Session ID unik: jika di supergroup topic, pisahkan per topic thread
function getSessionId(msg) {
  if (msg.message_thread_id) {
    return `${msg.chat.id}_t${msg.message_thread_id}`;
  }
  return String(msg.chat.id);
}

// Helper deteksi apakah teks berisi tabel Markdown (| Kolom | Kolom |\n|---|---|)
function hasMarkdownTable(text) {
  if (!text) return false;
  return /\|[^\n\r]+\|\r?\n\|[\s\-:|]+\|\r?\n\|[^\n\r]+\|/.test(text);
}

// Helper kirim rich message (mendukung tabel native Telegram Bot API 10.1+)
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
  return await bot._request("sendRichMessage", { form });
}

// Kirim pesan panjang dengan menjaga format Markdown (khususnya Code Block) & Tabel Native
async function sendLongMessage(chatId, text, options = {}) {
  const LIMIT = 4050; // Sedikit di bawah batas maksimal 4096 agar aman
  if (text.length <= LIMIT) {
    if (hasMarkdownTable(text)) {
      try {
        return await sendRichMessage(chatId, text, options);
      } catch (err) {
        console.warn("[Rich Table Error] Fallback ke sendMessage biasa:", err.message);
      }
    }
    return await bot.sendMessage(chatId, text, options);
  }

  const lines = text.split("\n");
  const chunks = [];
  let currentChunk = "";
  let isCodeBlockOpen = false;
  let currentLanguage = "";

  for (const line of lines) {
    // Cek apakah baris ini membuka atau menutup code block (```)
    if (line.trim().startsWith("```")) {
      isCodeBlockOpen = !isCodeBlockOpen;
      if (isCodeBlockOpen) {
        // Simpan nama bahasanya (misal: js, python) jika ada
        currentLanguage = line.trim().replace(/`/g, ""); 
      } else {
        currentLanguage = "";
      }
    }

    // Jika menambah baris ini bikin overlimit, kita potong pesannya
    if (currentChunk.length + line.length + 1 > LIMIT) {
      if (isCodeBlockOpen) {
        // Tutup sementara code block di pesan ini agar format Telegram tidak error
        currentChunk += "\n```";
      }
      chunks.push(currentChunk);

      // Mulai potongan pesan baru
      if (isCodeBlockOpen) {
        // Buka kembali code block di pesan selanjutnya dengan bahasa yang sama
        currentChunk = "```" + currentLanguage + "\n" + line + "\n";
      } else {
        currentChunk = line + "\n";
      }
    } else {
      currentChunk += line + "\n";
    }
  }

  // Masukkan sisa teks terakhir
  if (currentChunk.trim().length > 0) {
    chunks.push(currentChunk);
  }

  let lastSent;
  for (let i = 0; i < chunks.length; i++) {
    // Penanda bersambung yang rapi
    const suffix = (i !== chunks.length - 1) ? "\n\n_...bersambung ke pesan selanjutnya_" : "";
    const chunkOptions = { ...options };
    if (i > 0) {
      delete chunkOptions.reply_to_message_id; // Hanya potongan pertama yang me-reply pesan user
    }
    
    const contentToSend = chunks[i] + suffix;
    if (hasMarkdownTable(contentToSend)) {
      try {
        lastSent = await sendRichMessage(chatId, contentToSend, chunkOptions);
        if (i !== chunks.length - 1) await new Promise(r => setTimeout(r, 500));
        continue;
      } catch (err) {
        console.warn("[Rich Table Chunk Error] Fallback ke sendMessage biasa:", err.message);
      }
    }

    try {
      lastSent = await bot.sendMessage(chatId, contentToSend, chunkOptions);
    } catch (err) {
      console.error("[Markdown Error] Gagal mengirim potongan pesan:", err.message);
      // Fallback jika masih ada format markdown lain yang tidak valid
      const plainOptions = { ...chunkOptions };
      delete plainOptions.parse_mode; 
      lastSent = await bot.sendMessage(chatId, contentToSend, plainOptions);
    }
    
    if (i !== chunks.length - 1) await new Promise(r => setTimeout(r, 500)); // Jeda 0.5 detik
  }
  return lastSent;
}

// Opsi pengiriman pesan: dukung reply user dan message_thread_id (Supergroup Topics)
function getSendOptions(msg) {
  const options = { parse_mode: "Markdown" };
  if (msg && msg.reply_to_message) {
    const isTopicRoot = msg.message_thread_id && msg.reply_to_message.message_id === msg.message_thread_id;
    if (!isTopicRoot) {
      options.reply_to_message_id = msg.message_id;
    }
  }
  if (msg && msg.message_thread_id) {
    options.message_thread_id = msg.message_thread_id;
  }
  return options;
}

// === TELEGRAM BOT API 9.5+ NATIVE STREAMING DRAFT ENGINE ===
const draftCooldowns = new Map(); // chatId -> timestamp allowed

async function sendDraft(chatId, draftId, text, threadId = null) {
  const now = Date.now();
  if (draftCooldowns.has(chatId) && now < draftCooldowns.get(chatId)) {
    return;
  }

  try {
    const form = {
      chat_id: chatId,
      draft_id: draftId,
      text: text
    };
    if (threadId) form.message_thread_id = threadId;
    await bot._request("sendMessageDraft", { form });
  } catch (err) {
    if (err.message && err.message.includes("429")) {
      const retryMatch = err.message.match(/retry after (\d+)/i);
      const waitSec = retryMatch ? parseInt(retryMatch[1], 10) : 5;
      draftCooldowns.set(chatId, Date.now() + (waitSec * 1000));
    }
  }
}

function cleanDraftPreview(text) {
  if (!text) return "";
  return cleanAnswer(cleanFileTags(text))
    .replace(/<<<ZIP:[^\n>]*>?/gi, "")
    .replace(/<<<FILE:\s*([^\n>]+)>>>?/gi, "\n[File: $1]\n")
    .replace(/<<<ENDFILE>>>?/gi, "");
}

async function executeAICompletionAndReply({ msg, sessionId, messages, userPromptForFiles, typing }) {
  const chatId = msg.chat.id;
  const isPrivate = msg.chat?.type === "private" || chatId > 0;
  let rawAnswer = "";
  const turnMediaSent = { photos: 0, files: 0 };

  // Loop tool-calling: dibatasi 40 iterasi untuk mencegah loop tak terbatas
  const MAX_TOOL_ROUNDS = 40;
  let currentMessages = [...messages];
  let finalAnswerReceived = false;
  // Satu draft dipakai sepanjang giliran ini, jadi user melihat perintah yang sebenarnya
  // dijalankan AI (bukan hanya nama tool) tanpa menambah pesan baru ke chat.
  const turnDraftId = Math.floor(Math.random() * 2000000000) + 1;
  let stepIndex = 0;

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    let isStreamSuccess = false;
    let assistantContent = "";
    let toolCalls = [];

    // 1. Coba streaming terlebih dahulu
    try {
      const stream = await client.chat.completions.create({
        model: currentConfig.model,
        messages: currentMessages,
        tools: TOOL_DEFINITIONS,
        tool_choice: "auto",
        stream: true
      });

      const draftId = isPrivate ? Math.floor(Math.random() * 2000000000) + 1 : null;
      let lastDraftTime = 0;
      // Akumulator untuk tool calls dari chunk streaming
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

        // Akumulasi tool calls dari stream
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
          model: currentConfig.model,
          messages: currentMessages,
          tools: TOOL_DEFINITIONS,
          tool_choice: "auto",
          stream: false
        });
        const choice = fallbackRes.choices[0];
        assistantContent = choice.message?.content || "";
        toolCalls = choice.message?.tool_calls || [];
      } catch (fallbackErr) {
        console.error("[AI Fallback] Gagal total:", fallbackErr.message);
        stopTyping(typing);
        await replyText(msg, "Terjadi kesalahan saat menghubungi AI.");
        return;
      }
    }

    // Jika tidak ada tool calls, ini adalah jawaban final
    if (!toolCalls || toolCalls.length === 0) {
      rawAnswer = assistantContent;
      finalAnswerReceived = true;
      break;
    }

    // Bangun pesan assistant untuk riwayat percakapan
    const assistantMsg = { role: "assistant", content: assistantContent || null };
    if (toolCalls.length > 0) {
      assistantMsg.tool_calls = toolCalls;
    }
    currentMessages.push(assistantMsg);

    // Eksekusi setiap tool call dan tambahkan hasilnya
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
        await sendDraft(chatId, turnDraftId, `⏳ [${stepIndex}/${MAX_TOOL_ROUNDS}] ${langkah}`, msg.message_thread_id);
      }

      console.log(`[Agent Tool] Executing: ${fnName}(${JSON.stringify(fnArgs).slice(0, 200)})`);
      const result = await executeTool(fnName, fnArgs, {
        sessionId,
        chatId,
        threadId: msg.message_thread_id,
        client,
        model: currentConfig.model,
        bot,
        onMediaSent: (type) => {
          if (type === "photo") turnMediaSent.photos++;
          if (type === "file") turnMediaSent.files++;
        },
        onSubagentProgress: async ({ role, step, total, tool, args }) => {
          if (isPrivate) {
            const actionDesc = describeToolCall(tool, args);
            await sendDraft(
              chatId,
              turnDraftId,
              `🤖 [Subagent: ${role}] Langkah ${step}/${total}: ${actionDesc}`,
              msg.message_thread_id
            );
          }
        }
      });
      console.log(`[Agent Tool] Result (${fnName}): ${result.slice(0, 200)}...`);

      if (isPrivate) {
        const garis = result.split("\n").find((l) => l.trim()) || "";
        const tanda = garis.startsWith("❌") ? "❌" : "✅";
        await sendDraft(
          chatId,
          turnDraftId,
          `${tanda} [${stepIndex}/${MAX_TOOL_ROUNDS}] ${langkah} — ${garis.slice(0, 90)}`,
          msg.message_thread_id
        );
      }

      currentMessages.push({
        role: "tool",
        tool_call_id: toolCall.id,
        content: result
      });
    }

    // Lanjut loop — LLM akan memproses hasil tool
  }

  // Hentikan indikator typing sebelum mengirim pesan final
  stopTyping(typing);

  // 3. Bersihkan jawaban dan kirim pesan permanen
  let answer = cleanAnswer(cleanFileTags(rawAnswer));
  if (!answer && rawAnswer) answer = rawAnswer;
  if (!answer) {
    if (finalAnswerReceived) {
      answer = "(AI mengembalikan jawaban kosong)";
    } else {
      console.warn(`[Tool Loop] Batas ${MAX_TOOL_ROUNDS} ronde tool tercapai tanpa jawaban final.`);
      answer = `⚠️ Batas ${MAX_TOOL_ROUNDS} langkah tool tercapai sebelum AI memberi jawaban final. Biasanya ada tool yang terus gagal — cek pm2 logs atau ulangi permintaan lebih spesifik.`;
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

  // 5. Otomatis padatkan riwayat ke Summary di background jika obrolan sudah banyak
  triggerBackgroundCompaction(sessionId);
}

// Helper kirim pesan balasan cepat yang otomatis menghormati forum topic
function replyText(msg, text, extraOpts = {}) {
  const options = {
    parse_mode: "Markdown",
    ...extraOpts
  };
  if (msg.message_thread_id) {
    options.message_thread_id = msg.message_thread_id;
  }
  return bot.sendMessage(msg.chat.id, text, options);
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
    await bot.sendMessage(
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

// === HANDLER COMMAND (Perintah) ===
bot.onText(/^\/start(?:@\w+)?$/, async (msg) => {
  if (msg.from && msg.from.is_bot) return; // Cegah bot merespons bot

  const access = await checkUserAccess(msg);
  if (!access.allowed) {
    return handleAccessDenied(msg, access.status);
  }

  let text = "Halo! Saya *Nroz AI Agent* 🤖\n\nSiap membantumu berdiskusi, mengeksekusi kode, memeriksa server VPS, browsing internet, mengelola proyek coding di *Persistent Docker Sandbox* terisolasi, serta berbagai fitur canggih:\n• 🎙️ *Voice Note Transcriber* (bicara langsung via pesan suara)\n• 📊 *Data Analyst & Auto Chart* (grafik & visualisasi data otomatis)\n• 🎥 *Remotion React Video Creator* (bikin video MP4 animasi dari React)\n• 🌐 *Instant Web Preview* (link publik HTTPS live via Cloudflare Tunnel)\n• ⏰ *Pengingat & Pemantau Web* (Reminder & Server Watchdog)\n• 🎬 *Media Downloader & Converter* (yt-dlp & ffmpeg)\n\n*Perintah Tersedia:*\n• /newtopic : Mulai obrolan / topik baru\n• /workspace : Cek daftar file di folder server kamu\n• /sandbox : Cek status container sandbox Docker kamu\n• /resetsandbox : Reset container sandbox jika terjadi error\n• /tasks : Cek jadwal pengingat & pemantau web aktif\n• /clean : Hapus & bersihkan file di workspace kamu\n• /summary : Lihat ringkasan memori percakapan\n• /pause & /resume : Jeda / aktifkan respon bot";
  if (isOwner(msg)) {
    text += "\n\n👑 *Menu Khusus Owner:*\n• /config : Cek & kelola Model, Base URL, dan API Key\n• /cleanall : Bersihkan semua workspace > 3 hari\n• /approve <id> : Izinkan user manual\n• /reject <id> : Tolak/cabut user manual";
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

// --- PERINTAH DAFTAR PENGINGAT & WATCHDOG ---
bot.onText(/^\/(?:tasks|reminders|jadwal)(?:@\w+)?$/, async (msg) => {
  if (msg.from && msg.from.is_bot) return;

  const access = await checkUserAccess(msg);
  if (!access.allowed) {
    return handleAccessDenied(msg, access.status);
  }

  const sessionId = getSessionId(msg);
  const { reminders: rList, watchdogs: wList } = listTasks(sessionId);

  if (rList.length === 0 && wList.length === 0) {
    return replyText(
      msg,
      "⏰ *Tidak ada pengingat atau pemantau aktif.*\n\nKamu bisa meminta AI Agent membuat pengingat (misal: _ingatkan saya 15 menit lagi untuk meeting_) atau pemantau web (misal: _pantau server https://example.com tiap 10 menit_)."
    );
  }

  let text = "📋 *Daftar Tugas & Pengingat Aktif:*\n\n";
  if (rList.length > 0) {
    text += "*⏰ Pengingat:*\n";
    for (const r of rList) {
      const timeStr = new Date(r.targetTime).toLocaleString("id-ID");
      text += `• \`${r.id}\`: "${r.message}" (${timeStr})\n`;
    }
    text += "\n";
  }

  if (wList.length > 0) {
    text += "*🚨 Pemantau Web (Watchdog):*\n";
    for (const w of wList) {
      const lastCheck = w.lastCheck ? new Date(w.lastCheck).toLocaleTimeString("id-ID") : "belum";
      text += `• \`${w.id}\`: \`${w.url}\` (tiap ${w.intervalMinutes}m, status: ${w.status}, terakhir: ${lastCheck})\n`;
    }
  }

  text += `\n_💡 Untuk membatalkan tugas, ketik: /canceltask <id>_`;
  await replyText(msg, text);
});

// --- PERINTAH BATALKAN PENGINGAT / WATCHDOG ---
bot.onText(/^\/canceltask(?:@\w+)?(?:\s+(.+))?$/, async (msg, match) => {
  if (msg.from && msg.from.is_bot) return;

  const access = await checkUserAccess(msg);
  if (!access.allowed) {
    return handleAccessDenied(msg, access.status);
  }

  const taskId = (match && match[1]) ? match[1].trim() : "";
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
      await bot.deleteForumTopic(msg.chat.id, msg.message_thread_id);
      return; // Topic forum Telegram dan seluruh pesannya berhasil terhapus
    } catch (err) {
      console.warn("[Forum] Gagal menghapus topic forum Telegram (mungkin kurang hak admin manage topics):", err.message);
    }
  }

  const replyMsg = msg.message_thread_id
    ? "berhasil mengganti topic di forum ini."
    : "berhasil mengganti topic.";
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
    return replyText(
      msg,
      "ℹ️ Belum ada ringkasan memori untuk topik ini (obrolan masih sedikit atau baru dimulai)."
    );
  }
  await replyText(
    msg,
    `📝 *Ringkasan Memori Topik Saat Ini:*\n\n_${state.summary}_`
  );
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
    : (msg.chat.type === "private" ? "di chat pribadi ini" : "di grup ini");

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
    : (msg.chat.type === "private" ? "di chat pribadi ini" : "di grup ini");

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

  const text = 
`⚙️ *Pengaturan Nroz AI Bot*

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

  currentConfig.model = newModel;
  saveLocalConfig();
  try {
    await saveBotConfig(currentConfig);
  } catch (err) {
    console.warn("[Config] Gagal simpan ke Onlyx DB:", err.message);
  }

  await replyText(
    msg,
    `✅ *Model AI berhasil diubah!*\n\nModel aktif sekarang:\n\`${newModel}\``
  );
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
  currentConfig.baseUrl = newUrl;
  refreshClient();
  saveLocalConfig();
  try {
    await saveBotConfig(currentConfig);
  } catch (err) {
    console.warn("[Config] Gagal simpan ke Onlyx DB:", err.message);
  }

  await replyText(
    msg,
    `✅ *Base URL berhasil diubah!*\n\nBase URL aktif sekarang:\n\`${newUrl}\``
  );
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
      await bot.deleteMessage(msg.chat.id, msg.message_id);
    } catch {}
  }

  const newKey = match[1]?.trim();
  if (!newKey) {
    return replyText(
      msg,
      "Format salah. Silakan ketik:\n`/setapikey <key>`\n\nContoh:\n`/setapikey clv_live_xxxxxx`\n\n_💡 Tips: Sangat disarankan kirim di chat pribadi (private) dengan bot._"
    );
  }

  currentConfig.apiKey = newKey;
  refreshClient();
  saveLocalConfig();
  try {
    await saveBotConfig(currentConfig);
  } catch (err) {
    console.warn("[Config] Gagal simpan ke Onlyx DB:", err.message);
  }

  await replyText(
    msg,
    `✅ *API Key berhasil diperbarui!*\n\nAPI Key aktif sekarang:\n\`${maskKey(newKey)}\``
  );
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
    await bot.sendMessage(
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
    await bot.sendMessage(
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

  currentConfig = { ...defaultConfig };
  refreshClient();
  saveLocalConfig();
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

// === HANDLER TOMBOL INLINE (APPROVAL / REJECTION OLEH OWNER) ===
bot.on("callback_query", async (query) => {
  if (!query.data) return;

  const senderId = String(query.from.id);
  if (senderId !== OWNER_ID) {
    return bot.answerCallbackQuery(query.id, {
      text: "⛔ Hanya Owner yang berhak menentukan persetujuan akses.",
      show_alert: true
    });
  }

  if (query.data.startsWith("acc_app_")) {
    const targetUserId = query.data.replace("acc_app_", "");
    const userAccess = await getUserAccess(targetUserId);
    const name = userAccess?.name || targetUserId;

    await setUserAccess(targetUserId, "approved", userAccess || {});
    await bot.answerCallbackQuery(query.id, { text: "✅ Akses pengguna telah disetujui!" });

    try {
      await bot.editMessageText(
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
      await bot.sendMessage(
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
    await bot.answerCallbackQuery(query.id, { text: "❌ Akses pengguna telah ditolak." });

    try {
      await bot.editMessageText(
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
      await bot.sendMessage(
        targetUserId,
        "⛔ *Pemberitahuan*\n\nMaaf, permintaan akses Anda ke bot ini telah ditolak oleh Owner.",
        { parse_mode: "Markdown" }
      );
    } catch (e) {
      console.warn(`[Access] Gagal kirim notifikasi penolakan ke user ${targetUserId}:`, e.message);
    }
  }
});

// === HANDLER TEKS ===
bot.on("message", async (msg) => {
  if (msg.from && msg.from.is_bot) return; // [FIX] Mencegah infinite loop bot spam
  if (hasIgnorePrefix(msg.text)) return;   // Abaikan jika berawalan slash, //, atau !

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
  let typing;

  try {
    typing = startTyping(chatId, msg.message_thread_id);
    let userText = msg.text;

    // Bersihkan mention bot dari userText jika ada
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

    await executeAICompletionAndReply({
      msg,
      sessionId,
      messages: buildMessagesWithSystem(await getHistoryForAI(sessionId, 12), sessionId),
      userPromptForFiles: userText,
      typing
    });
  } catch(err) {
    console.error("TEXT ERROR:", err);
    await replyText(msg, "Terjadi kesalahan.");
  } finally {
    stopTyping(typing);
  }
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
    fs.writeFileSync(savedFilePath, bufferData);
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

    await saveMemory(sessionId, "user", `[Kirim Foto]: ${prompt || "(tanpa caption)"} (disimpan di uploads/${photoName})`);
    appendRawLog(sessionId, "user", `[Kirim Foto]: ${prompt || "(tanpa caption)"} (uploads/${photoName})`, { messageId: msg.message_id });

    const currentHistory = await getHistoryForAI(sessionId, 12);
    await executeAICompletionAndReply({
      msg,
      sessionId,
      messages: buildMessagesWithSystem([...currentHistory, ...currentMessage], sessionId),
      userPromptForFiles: prompt,
      typing
    });
  } catch(err) {
    console.error("PHOTO ERROR:", err);
    await replyText(msg, "Gagal memproses foto.");
  } finally {
    stopTyping(typing);
  }
});

// === HANDLER DOKUMEN ===
bot.on("document", async (msg) => {
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
    fs.writeFileSync(savedFilePath, bufferData);
    
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
    } else if ([".js", ".ts", ".jsx", ".tsx", ".py", ".sh", ".json", ".html", ".css", ".txt", ".md", ".sql", ".yaml", ".yml"].includes(ext)) {
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
      const mime = ext === ".png" ? "image/png" : 
                   ext === ".webp" ? "image/webp" : "image/jpeg";
      
      const userTextPrompt = 
        `🖼️ [Gambar HD Diterima]\n` +
        `• Disimpan di: \`uploads/${safeName}\` (path host: \`${savedFilePath}\`, ${fileSizeKb} KB)\n` +
        `• Path sandbox container: \`/workspace/uploads/${safeName}\`\n` +
        (prompt ? `• Instruksi user: ${prompt}\n` : "") +
        `\nKamu bisa melihat gambar secara visual (Vision). Hasil olahan simpan di \`/workspace/work/\` atau \`/workspace/artifacts/\`.`;

      await saveMemory(sessionId, "user", `[Kirim Gambar HD]: ${safeName} (${fileSizeKb} KB, path: uploads/${safeName})`);
      appendRawLog(sessionId, "user", `[Kirim Gambar HD]: ${safeName} (${fileSizeKb} KB, path: uploads/${safeName})`, { messageId: msg.message_id });
      
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

    // Catat ke memori Onlyx & raw memory
    await saveMemory(sessionId, "user", `[Kirim Dokumen]: ${safeName} (${fileSizeKb} KB, path: uploads/${safeName}). Instruksi: ${prompt || "-"}`);
    appendRawLog(sessionId, "user", `[Kirim Dokumen]: ${safeName} (${fileSizeKb} KB, path: uploads/${safeName}). Instruksi: ${prompt || "-"}`, { messageId: msg.message_id });

    const currentHistory = await getHistoryForAI(sessionId, 12);
    await executeAICompletionAndReply({
      msg,
      sessionId,
      messages: buildMessagesWithSystem([
        ...currentHistory,
        { role: "user", content: userPrompt }
      ], sessionId),
      userPromptForFiles: prompt || userPrompt,
      typing
    });
  } catch(err) {
    console.error("DOCUMENT ERROR:", err);
    await replyText(msg, "Gagal memproses dokumen.");
  } finally {
    stopTyping(typing);
  }
});

// === HANDLER PESAN SUARA & AUDIO (VOICE TRANSCRIBER VIA FASTER-WHISPER) ===
async function handleVoiceOrAudio(msg, isVoice = true) {
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
    fs.writeFileSync(savedAudioPath, bufferData);

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

    // 5. Catat ke memori Onlyx & raw memory
    await saveMemory(
      sessionId,
      "user",
      `[Pesan Suara / Voice Note]: "${cleanedText}"`,
      msg.message_id
    );
    appendRawLog(
      sessionId,
      "user",
      `[Pesan Suara / Voice Note]: "${cleanedText}" (uploads/${audioFileName})`,
      { messageId: msg.message_id }
    );

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
      messages: buildMessagesWithSystem([
        ...currentHistory,
        { role: "user", content: userPrompt }
      ], sessionId),
      userPromptForFiles: cleanedText,
      typing
    });
  } catch (err) {
    console.error("VOICE/AUDIO ERROR:", err);
    await replyText(msg, "Gagal memproses pesan suara.");
  } finally {
    stopTyping(typing);
  }
}

bot.on("voice", (msg) => handleVoiceOrAudio(msg, true));
bot.on("audio", (msg) => handleVoiceOrAudio(msg, false));

// === PENANGAN ERROR POLLING (Agar Log Railway Bersih) ===
bot.on("polling_error", (error) => {
  console.log(`[Polling Error]: ${error.message}`);
});
