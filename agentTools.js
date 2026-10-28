/**
 * agentTools.js — Modul tool-calling untuk Nroz Telegram AI Agent
 *
 * Menyediakan definisi tool (format OpenAI function-calling) dan executor-nya.
 * Semua output dibatasi 4000 karakter, semua proses punya timeout,
 * dan operasi berbahaya diblokir secara proaktif.
 *
 * Ekspor:
 *   - TOOL_DEFINITIONS : Array definisi tool (format OpenAI tools)
 *   - executeTool(name, args) : Fungsi untuk menjalankan tool berdasarkan nama
 */

const { execSync, execFile } = require("child_process");
const fs = require("fs");
const path = require("path");
const os = require("os");
const https = require("https");
const http = require("http");
const {
  execInSandboxAsync,
  startBackgroundInSandbox,
  getSessionWorkspace,
} = require("./sandboxManager.js");
const { startWebPreview, stopWebPreview, listActivePreviews } = require("./webPreviewManager.js");
const { addReminder, addWatchdog, listTasks, removeTask } = require("./schedulerManager.js");
const { queueRender, getRenderQueueStatus } = require("./remotionManager.js");

// ============================================================
// KONSTANTA DAN UTILITAS
// ============================================================

/** Batas maksimum karakter output yang dikembalikan ke model */
const MAX_OUTPUT = 4000;

const WORKSPACE_BASE = path.join(__dirname, "workspace");

/**
 * Helper path — model sering mencampur path host (/root/nroz/workspace/<id>)
 * dengan path sandbox (/workspace). Keduanya adalah folder yang sama, jadi
 * diterjemahkan otomatis agar tidak ada lagi "file tidak ditemukan" palsu.
 */
const toHostPath = (p, sessionId) => {
  if (typeof p !== "string" || !p) return p;
  if (p === "/workspace" || p.startsWith("/workspace/")) {
    return path.join(getSessionWorkspace(sessionId), p.slice("/workspace".length));
  }
  return p;
};

const toSandboxPath = (text, sessionId) => {
  if (typeof text !== "string") return text;
  const hostWs = getSessionWorkspace(sessionId);
  let out = text.includes(hostWs) ? text.split(hostWs).join("/workspace") : text;
  // Container cuma melihat satu folder workspace, jadi path session lain juga dipetakan ke /workspace
  out = out.replace(new RegExp(`${WORKSPACE_BASE.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/[A-Za-z0-9_\\-]+`, "g"), "/workspace");
  return out;
};

/** Job run_command yang jalan di latar belakang: id -> { logPath, exitPath, startedAt, command } */
const backgroundJobs = new Map();
let bgCounter = 0;

/** Perintah yang menyita CPU penuh — diberi prioritas rendah selama video sedang dirender. */
const HEAVY_RENDER_RE = /(npx\s+remotion|remotion\s+render|render\.mjs|moviepy|manim|blender|headless[-_]shell|chrome-headless|ffmpeg\b.*(-c:v|libx264|libx265|--preset)|encod(e|ing))/i;

/** Prioritas rendah kalau berat DAN antrean video sedang merender. */
function lowPriorityFor(command) {
  if (!HEAVY_RENDER_RE.test(command)) return false;
  return getRenderQueueStatus().busy;
}

/**
 * Menerjemahkan path yang diberikan model ke path host:
 * /workspace/... -> folder session, dan path relatif -> di dalam folder session.
 */
function resolveFilePath(filePath, sessionId) {
  const mapped = toHostPath(filePath, sessionId);
  return path.isAbsolute(mapped)
    ? path.resolve(mapped)
    : path.resolve(getSessionWorkspace(sessionId), mapped);
}

/**
 * Memotong teks jika melebihi batas karakter.
 * Menambahkan notifikasi bahwa output terpotong.
 * @param {string} text - Teks yang akan dipotong
 * @param {number} limit - Batas karakter (default MAX_OUTPUT)
 * @returns {string}
 */
function truncate(text, limit = MAX_OUTPUT) {
  if (typeof text !== "string") text = String(text);
  if (text.length <= limit) return text;
  return text.slice(0, limit) + "\n\n... [Output terpotong, total " + text.length + " karakter]";
}

/**
 * Daftar pola perintah berbahaya yang diblokir untuk run_command.
 * Menggunakan pendekatan blacklist — perintah yang cocok akan ditolak.
 */
const BLOCKED_COMMANDS = [
  /\brm\s+(-\w*\s+)*-\w*r\w*\s+.*\//i,   // rm -rf / atau varian
  /\brm\s+(-\w*\s+)*\/\s*/i,               // rm / langsung
  /\bmkfs\b/i,                              // format filesystem
  /\bdd\s+if=/i,                            // dd raw disk write
  /\bshutdown\b/i,                          // matikan server
  /\breboot\b/i,                            // restart server
  /\binit\s+[06]\b/i,                       // init 0 / init 6
  /\bsystemctl\s+(poweroff|halt|reboot)\b/i,
  /\bhalt\b/i,
  /\bpoweroff\b/i,
  /:(){ :\|:& };:/,                         // fork bomb
  />\s*\/dev\/sd[a-z]/i,                    // overwrite disk device
  />\s*\/dev\/nvme/i,                       // overwrite nvme device
  /\bchmod\s+.*\s+\/\s*$/i,                // chmod seluruh root
  /\bchown\s+.*\s+\/\s*$/i,                // chown seluruh root
  /\biptables\s+-F\b/i,                    // flush semua firewall rules
  /\bkill\s+-9\s+1\b/,                     // kill init/systemd
  /\bkillall\b/i,                           // kill semua proses
  /\bpkill\s+-9/i,                          // kill proses secara agresif
];

/**
 * Mengecek apakah sebuah perintah shell mengandung pola berbahaya.
 * @param {string} cmd - Perintah yang akan dicek
 * @returns {string|null} - Pesan error jika berbahaya, null jika aman
 */
function checkBlockedCommand(cmd) {
  for (const pattern of BLOCKED_COMMANDS) {
    if (pattern.test(cmd)) {
      return `⛔ Perintah diblokir karena terdeteksi pola berbahaya: ${pattern}`;
    }
  }
  return null;
}

/**
 * Pola path sensitif yang tidak boleh dibaca.
 */
const BLOCKED_READ_PATHS = [
  /\/etc\/shadow/i,
  /\/etc\/passwd/i,
  /\/etc\/gshadow/i,
  /\/etc\/sudoers/i,
  /\.env$/i,
  /\.env\./i,
  /id_rsa/i,
  /id_ed25519/i,
  /\.pem$/i,
  /\.key$/i,
  /private.*key/i,
];

/**
 * Pola direktori sistem yang tidak boleh ditulis / dilist.
 */
const BLOCKED_SYSTEM_DIRS = [
  /^\/etc(\/|$)/,
  /^\/usr(\/|$)/,
  /^\/bin(\/|$)/,
  /^\/sbin(\/|$)/,
  /^\/boot(\/|$)/,
  /^\/proc(\/|$)/,
  /^\/sys(\/|$)/,
  /^\/dev(\/|$)/,
];

/**
 * Mengecek apakah sebuah path merupakan direktori sistem yang diproteksi.
 * @param {string} p - Path yang akan dicek
 * @returns {boolean}
 */
function isSystemDir(p) {
  const resolved = path.resolve(p);
  return BLOCKED_SYSTEM_DIRS.some((re) => re.test(resolved));
}

/**
 * Mengecek apakah sebuah path file sensitif yang tidak boleh dibaca.
 * @param {string} p - Path yang akan dicek
 * @returns {boolean}
 */
function isSensitiveFile(p) {
  const resolved = path.resolve(p);
  return BLOCKED_READ_PATHS.some((re) => re.test(resolved));
}

// ============================================================
// DEFINISI TOOL — FORMAT OPENAI FUNCTION-CALLING
// ============================================================

const TOOL_DEFINITIONS = [
  // --- a) run_command ---
  {
    type: "function",
    function: {
      name: "run_command",
      description:
        "Menjalankan perintah shell di dalam Persistent Docker Sandbox (Ubuntu Linux) terisolasi. " +
        "Kamu memiliki hak akses root penuh di dalam container sandbox kamu, bebas menginstall paket (apt-get, npm, pip), " +
        "menjalankan script, kompilasi kode, atau mengelola proses tanpa batasan. " +
        "PATH: folder kerja kamu di-mount sebagai /workspace. Path /workspace sama dengan folder yang dipakai file_write/file_read — " +
        "jangan menulis ke /opt atau path host lain karena tidak akan terlihat oleh container. " +
        "PERINTAH LAMA: set 'background': true (tanpa sleep!), lalu baca hasilnya dengan tool 'check_command_output'. " +
        "Timeout perintah biasa 120 detik, instalasi paket 300 detik. " +
        "PERINGATAN: DILARANG menggunakan tool ini untuk merender/membuat video animasi atau membuat klip TTS satu per satu. " +
        "Untuk video dengan suara/narasi, SELALU gunakan satu panggilan tool 'render_remotion_video' dengan tts_text atau tts_lines.",
      parameters: {
        type: "object",
        properties: {
          command: {
            type: "string",
            description: "Perintah shell yang akan dijalankan di dalam sandbox, misal 'ls -la' atau 'apt-get install -y ffmpeg'",
          },
          cwd: {
            type: "string",
            description: "Direktori kerja opsional di dalam container (default: /workspace)",
          },
          background: {
            type: "boolean",
            description:
              "true = jalankan tanpa menunggu selesai (untuk render/encode/batch TTS/download panjang). " +
              "Hasil dibaca nanti lewat check_command_output. Jangan pakai 'sleep' untuk menunggu.",
          },
        },
        required: ["command"],
      },
    },
  },

  // --- a2) check_command_output ---
  {
    type: "function",
    function: {
      name: "check_command_output",
      description:
        "Membaca status dan output perintah yang dijalankan dengan run_command {\"background\": true}. " +
        "Kosongkan job_id untuk melihat daftar semua job background. " +
        "Jangan polling berulang-ulang — cek sekali setelah kamu menyelesaikan pekerjaan lain atau setelah user bertanya.",
      parameters: {
        type: "object",
        properties: {
          job_id: {
            type: "string",
            description: "ID job dari hasil run_command background, misal 'bg1'. Kosong untuk list semua job.",
          },
        },
        required: [],
      },
    },
  },

  // --- b) run_code ---
  {
    type: "function",
    function: {
      name: "run_code",
      description:
        "Menjalankan potongan kode dan mengembalikan output-nya. " +
        "Mendukung JavaScript (Node.js), Python 3, dan Bash. " +
        "Timeout 90 detik; kode yang lebih panjang jalankan lewat run_command dengan file + background:true. " +
        "Kode dieksekusi di dalam sandbox Docker, jadi folder kerja hanya terlihat sebagai /workspace. " +
        "PERINGATAN: DILARANG menggunakan tool ini untuk membuat/merender video animasi (ffmpeg/moviepy/manim/opencv) " +
        "atau membuat klip TTS/audio per segmen. Untuk video bernarasi, gunakan SATU panggilan 'render_remotion_video' " +
        "dengan tts_text (naskah utuh) atau tts_lines (banyak suara).",
      parameters: {
        type: "object",
        properties: {
          language: {
            type: "string",
            enum: ["javascript", "python", "bash"],
            description: "Bahasa pemrograman yang digunakan",
          },
          code: {
            type: "string",
            description: "Kode sumber yang akan dieksekusi",
          },
        },
        required: ["language", "code"],
      },
    },
  },

  // --- c) web_search ---
  {
    type: "function",
    function: {
      name: "web_search",
      description:
        "Mencari informasi di internet menggunakan DuckDuckGo. " +
        "Mengembalikan 5 hasil teratas berupa judul dan cuplikan teks. " +
        "Gunakan untuk mencari informasi terbaru, dokumentasi, atau referensi.",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "Kata kunci pencarian",
          },
        },
        required: ["query"],
      },
    },
  },

  // --- d) read_url ---
  {
    type: "function",
    function: {
      name: "read_url",
      description:
        "Membaca konten dari sebuah URL. Mengambil halaman web, menghapus tag HTML, " +
        "dan mengembalikan teks konten (maks 4000 karakter). Timeout 10 detik.",
      parameters: {
        type: "object",
        properties: {
          url: {
            type: "string",
            description: "URL lengkap yang akan dibaca, misal 'https://example.com'",
          },
        },
        required: ["url"],
      },
    },
  },

  // --- e) system_info ---
  {
    type: "function",
    function: {
      name: "system_info",
      description:
        "Mengambil informasi sistem VPS: hostname, OS, uptime, CPU, memori, dan disk. " +
        "Tidak memerlukan parameter.",
      parameters: {
        type: "object",
        properties: {},
        required: [],
      },
    },
  },

  // --- f) file_read ---
  {
    type: "function",
    function: {
      name: "file_read",
      description:
        "Membaca isi file dari filesystem VPS. Maks 4000 karakter. " +
        "File sensitif (shadow, passwd, .env, private key) diblokir.",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Path absolut atau relatif ke file yang akan dibaca",
          },
        },
        required: ["path"],
      },
    },
  },

  // --- g) file_write ---
  {
    type: "function",
    function: {
      name: "file_write",
      description:
        "Menulis konten ke file di VPS. Direktori induk dibuat otomatis jika belum ada. " +
        "Penulisan ke direktori sistem (/etc, /usr, /bin, dsb.) diblokir.",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Path file tujuan",
          },
          content: {
            type: "string",
            description: "Konten yang akan ditulis ke file",
          },
        },
        required: ["path", "content"],
      },
    },
  },

  // --- h) file_list ---
  {
    type: "function",
    function: {
      name: "file_list",
      description:
        "Menampilkan daftar file dan folder di sebuah direktori. " +
        "Listing direktori sistem (/etc, /usr, /bin, dsb.) diblokir.",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Path direktori yang akan di-list (default: direktori saat ini)",
          },
        },
        required: [],
      },
    },
  },

  // --- i) http_request ---
  {
    type: "function",
    function: {
      name: "http_request",
      description:
        "Membuat HTTP request ke API eksternal. Mendukung GET, POST, PUT, DELETE. " +
        "Timeout 15 detik. Respons dibatasi 4000 karakter.",
      parameters: {
        type: "object",
        properties: {
          method: {
            type: "string",
            enum: ["GET", "POST", "PUT", "DELETE"],
            description: "Metode HTTP",
          },
          url: {
            type: "string",
            description: "URL endpoint tujuan",
          },
          headers: {
            type: "object",
            description: "Header HTTP opsional (key-value)",
          },
          body: {
            type: "string",
            description: "Body request opsional (untuk POST/PUT)",
          },
        },
        required: ["method", "url"],
      },
    },
  },

  // --- j) start_web_preview ---
  {
    type: "function",
    function: {
      name: "start_web_preview",
      description:
        "Membuka link publik instan (Cloudflare Tunnel) untuk preview aplikasi web atau server yang berjalan di port tertentu. " +
        "Mengembalikan URL HTTPS publik yang bisa dibuka di browser dari HP atau komputer.",
      parameters: {
        type: "object",
        properties: {
          port: {
            type: "number",
            description: "Nomor port lokal yang ingin diekspos (misal 3000, 5000, 8080)",
          },
          duration_minutes: {
            type: "number",
            description: "Durasi link aktif dalam menit (default 30 menit)",
          },
        },
        required: ["port"],
      },
    },
  },

  // --- k) create_reminder ---
  {
    type: "function",
    function: {
      name: "create_reminder",
      description:
        "Menjadwalkan pengingat (Reminder). Bot akan otomatis mengirimkan pesan pengingat ke chat Telegram pengguna saat waktu yang ditentukan tiba.",
      parameters: {
        type: "object",
        properties: {
          message: {
            type: "string",
            description: "Pesan pengingat yang akan dikirimkan",
          },
          minutes_from_now: {
            type: "number",
            description: "Berapa menit lagi dari sekarang pengingat harus dibunyikan (misal 15, 60, 1440 untuk 1 hari)",
          },
        },
        required: ["message", "minutes_from_now"],
      },
    },
  },

  // --- l) create_watchdog ---
  {
    type: "function",
    function: {
      name: "create_watchdog",
      description:
        "Memasang watchdog pemantau status website atau API server. Bot akan mengecek target URL secara berkala dan otomatis mengirimkan pesan peringatan di Telegram jika website down/error.",
      parameters: {
        type: "object",
        properties: {
          url: {
            type: "string",
            description: "URL lengkap website yang ingin dipantau (misal 'https://example.com')",
          },
          interval_minutes: {
            type: "number",
            description: "Interval pengecekan dalam menit (default 10 menit)",
          },
        },
        required: ["url"],
      },
    },
  },

  // --- m) media_download ---
  {
    type: "function",
    function: {
      name: "media_download",
      description:
        "Mengunduh video atau audio dari link media (YouTube, TikTok, Instagram, Twitter/X, dsb.) menggunakan yt-dlp ke folder workspace.",
      parameters: {
        type: "object",
        properties: {
          url: {
            type: "string",
            description: "Link/URL video atau audio yang ingin diunduh",
          },
          format: {
            type: "string",
            enum: ["video", "audio"],
            description: "Format yang diinginkan: 'video' (MP4) atau 'audio' (MP3)",
          },
        },
        required: ["url"],
      },
    },
  },

  // --- n) render_remotion_video ---
  {
    type: "function",
    function: {
      name: "render_remotion_video",
      description:
        "Membuat dan merender video animasi berkualitas tinggi (MP4) secara terprogram dari kode React/TypeScript menggunakan Remotion. " +
        "Mendukung animasi hook Remotion (useCurrentFrame, interpolate, spring, useVideoConfig, AbsoluteFill, Sequence), teks dinamis, bentuk, warna, dan styling CSS flexbox. " +
        "VIDEO PANJANG / BERNARASI: cukup SATU panggilan — kirim seluruh naskah lewat tts_text (atau tts_lines untuk banyak suara). " +
        "Durasi video otomatis mengikuti panjang voiceover sampai 900 detik, dan render dikerjakan di antrean latar belakang. " +
        "Dilarang membuat klip TTS/audio/video per segmen memakai run_command/run_code lalu menggabungkannya sendiri. " +
        "TOOL INI BERSIFAT NON-BLOCKING: pangilan langsung mengembalikan nomor job dan render berjalan di latar belakang; " +
        "video dikirim otomatis ke chat saat selesai. Cukup kabari user bahwa video sedang dikerjakan, lalu akhiri jawaban — jangan panggil tool ini dua kali untuk kode yang sama.",
      parameters: {
        type: "object",
        properties: {
          code: {
            type: "string",
            description:
              "Kode sumber React Component (TSX/JSX) untuk video. Gunakan hook Remotion seperti useCurrentFrame, useVideoConfig, spring, interpolate, dsb. " +
              "Bisa berupa komponen yang di-export (contoh: 'export const MyVideo = () => { ... }').",
          },
          duration_seconds: {
            type: "number",
            description: "Durasi video dalam detik (default: 5). Boleh panjang untuk narasi lengkap; render di server ini ±0,35 detik per frame (5 menit @30fps ≈ 53 menit render).",
          },
          fps: {
            type: "number",
            description:
              "Frame per second (default: 30). Server ini merender ±0,35 detik per frame, jadi video panjang lebih cepat dengan fps rendah: " +
              "5 menit @30fps ≈ 53 menit render, @15fps ≈ 26 menit. Untuk video > 2 menit pakai fps 15.",
          },
          width: {
            type: "number",
            description: "Lebar video dalam pixel (default: 1080 untuk vertikal 9:16 Shorts/Reels/TikTok, atau 1920 untuk horizontal 16:9)",
          },
          height: {
            type: "number",
            description: "Tinggi video dalam pixel (default: 1920 untuk vertikal 9:16 Shorts/Reels/TikTok, atau 1080 untuk horizontal 16:9)",
          },
          title: {
            type: "string",
            description: "Judul atau nama singkat untuk video (contoh: 'promo_diskon', 'quotes_video', 'birthday_sarah')",
          },
          tts_text: {
            type: "string",
            description:
              "Naskah narasi lengkap yang diucapkan AI di video (satu suara). DURASI VIDEO OTOMATIS MENGIKUTI PANJANG NASKAH " +
              "sampai maksimum 900 detik — jadi untuk video 5 menit, kirim seluruh naskah di sini dalam SATU panggilan. " +
              "Jangan pecah naskah menjadi klip TTS kecil dengan run_command/run_code.",
          },
          tts_lines: {
            type: "array",
            description:
              "Naskah multi-suara/dialog. Setiap item diucapkan terpisah lalu digabung otomatis menjadi satu voiceover MP3 " +
              "dan durasi video mengikuti total panjangnya. Komponen React-mu otomatis menerima prop " +
              "`nrozTimings`: array [{text, voice, start, end, words:[{text,start,end]}]} dalam detik — pakai ini untuk " +
              "subtitle/kinetic typography yang sinkron, bukan membuat klip TTS sendiri di sandbox.",
            items: {
              type: "object",
              properties: {
                text: { type: "string", description: "Teks yang diucapkan pada baris ini" },
                voice: {
                  type: "string",
                  description:
                    "Suara untuk baris ini: 'id-male', 'id-female', 'en-male', 'en-female', atau nama edge-tts penuh seperti 'id-ID-GadisNeural'. Kosong = pakai tts_voice.",
                },
              },
              required: ["text"],
            },
          },
          tts_voice: {
            type: "string",
            enum: ["id-male", "id-female", "en-male", "en-female"],
            description: "Pilihan suara AI: 'id-male' (Ardi - pria ID), 'id-female' (Gadis - wanita ID), 'en-male' (Christopher), 'en-female' (Jenny). Default: 'id-male'",
          },
          audio_path: {
            type: "string",
            description:
              "Path file audio (MP3/WAV) yang ingin dipakai sebagai backsound/suara user, misalnya /workspace/musik.mp3 " +
              "(file yang kamu buat lewat run_command/file_write di folder kerjamu). Tool menolak lebih dulu kalau file tidak ada.",
          },
        },
        required: ["code"],
      },
    },
  },
];

// ============================================================
// IMPLEMENTASI SETIAP TOOL
// ============================================================

/**
 * Tool: run_command
 * Menjalankan perintah shell di dalam Persistent Docker Sandbox user terisolasi.
 * Bebas tanpa larangan perintah karena terisolasi 100% di dalam container Docker.
 * background=true -> perintah dijalankan tanpa menunggu, cek hasil pakai check_command_output.
 */
async function toolRunCommand({ command, cwd, sessionId, background }) {
  if (!command || typeof command !== "string") {
    return "❌ Parameter 'command' wajib berupa string.";
  }

  const sandboxCommand = toSandboxPath(command, sessionId);
  const lowPriority = lowPriorityFor(command);
  const catatanPrioritas = lowPriority
    ? (() => {
        const q = getRenderQueueStatus();
        return `⚡ Render video #${q.jobId} masih berjalan (sisa ±${Math.max(1, Math.round(q.remainingSec / 60))} menit) — perintah berat ini kujalankan dengan prioritas CPU rendah.\n`;
      })()
    : "";

  if (background) {
    const jobId = `bg${++bgCounter}`;
    try {
      const { logPath, exitPath } = startBackgroundInSandbox(sessionId || "default", sandboxCommand, jobId, { lowPriority });
      backgroundJobs.set(jobId, { logPath, exitPath, startedAt: Date.now(), command: toHostPathPreview(command) });
      return (
        `${catatanPrioritas}🌙 Job ${jobId} dijalankan di latar belakang.\n` +
        `• Cek hasil dengan tool check_command_output({"job_id":"${jobId}"})\n` +
        `• Log: /workspace/.bg/${jobId}.log\n` +
        `Lanjutkan pekerjaan lain, jangan tidur dengan sleep.`
      );
    } catch (err) {
      return `❌ Gagal memulai job background: ${err.message}`;
    }
  }

  // Perintah instalasi package dan batch TTS butuh waktu lama; jangan dipotong 30 detik.
  const isInstallCmd = /\b(apt-get|apt|npm|pip|pip3|cargo)\s+install\b/i.test(command);
  const timeoutMs = isInstallCmd ? 300_000 : 120_000;

  try {
    const output = await execInSandboxAsync(sessionId || "default", sandboxCommand, {
      timeout: timeoutMs,
      maxBuffer: 4 * 1024 * 1024,
      cwd: cwd || "/workspace",
      lowPriority
    });
    return `${catatanPrioritas}${truncate(output || "(Perintah berhasil, tidak ada output)")}`;
  } catch (err) {
    if (err.killed) {
      return (
        `⏱️ Perintah dihentikan karena melebihi timeout ${Math.round(timeoutMs / 1000)} detik.\n` +
        `Untuk pekerjaan yang lebih lama, jalankan lagi dengan {"background": true} lalu cek lewat check_command_output.`
      );
    }
    const stderr = err.stderr ? err.stderr.toString() : "";
    const stdout = err.stdout ? err.stdout.toString() : "";
    const combined = (stdout + "\n" + stderr).trim();
    return truncate(`❌ Perintah gagal (exit code ${exitCodeOf(err)})\n${combined || err.message}`);
  }
}

/** Ambil exit code dari error child_process (execFile menaruh angka di err.code). */
function exitCodeOf(err) {
  const code = typeof err.code === "number" ? err.code : err.status;
  return typeof code === "number" ? String(code) : "?";
}

/** Potongan pendek perintah untuk dict/job registry (bukan untuk dieksekusi). */
function toHostPathPreview(command) {
  const oneLine = String(command).replace(/\s+/g, " ").trim();
  return oneLine.length > 120 ? `${oneLine.slice(0, 120)}…` : oneLine;
}

/** Ambil bagian akhir file tanpa membaca seluruhnya (log job background bisa besar). */
function tailFile(file, maxBytes = 8192) {
  try {
    const stat = fs.statSync(file);
    const len = Math.min(stat.size, maxBytes);
    const buf = Buffer.alloc(len);
    const fd = fs.openSync(file, "r");
    fs.readSync(fd, buf, 0, len, Math.max(0, stat.size - len));
    fs.closeSync(fd);
    return buf.toString("utf-8");
  } catch (_) {
    return "";
  }
}

/**
 * Tool: check_command_output
 * Membaca status/output job run_command yang jalan di latar belakang.
 */
async function toolCheckCommandOutput({ job_id }) {
  const summarize = (id, job) => {
    const done = fs.existsSync(job.exitPath);
    const code = done ? tailFile(job.exitPath, 16).trim() : null;
    const state = !done ? "🌙 jalan" : code === "0" ? "✅ selesai" : `❌ exit ${code}`;
    return `- ${id}: ${state} selama ${Math.round((Date.now() - job.startedAt) / 1000)}s | ${job.command}`;
  };

  if (!job_id) {
    if (backgroundJobs.size === 0) return "Tidak ada job background yang pernah dijalankan di proses ini.";
    return `Job background aktif:\n${[...backgroundJobs.entries()].map(([id, j]) => summarize(id, j)).join("\n")}`;
  }

  const job = backgroundJobs.get(String(job_id));
  if (!job) {
    return `❌ Job '${job_id}' tidak ditemukan. Job yang dikenal: ${[...backgroundJobs.keys()].join(", ") || "(kosong)"}`;
  }

  const finished = fs.existsSync(job.exitPath);
  const exitCode = finished ? tailFile(job.exitPath, 16).trim() : null;
  const log = tailFile(job.logPath).trim();
  const header = !finished
    ? `🌙 Job ${job_id} MASIH BERJALAN (${Math.round((Date.now() - job.startedAt) / 1000)} detik)`
    : exitCode === "0"
      ? `✅ Job ${job_id} selesai (exit 0)`
      : `❌ Job ${job_id} selesai dengan error (exit ${exitCode})`;

  return truncate(
    `${header}\n• Perintah: ${job.command}\n` +
    `• Output terakhir:\n${log || "(belum ada output)"}\n` +
    (finished ? "" : "\nJangan cek berulang — lanjutkan pekerjaan lain dan cek lagi saat user bertanya.")
  );
}

/**
 * Tool: run_code
 * Menjalankan kode dalam bahasa yang didukung (JavaScript, Python, Bash)
 * di dalam Persistent Docker Sandbox user.
 */
async function toolRunCode({ language, code, sessionId }) {
  if (!language || !code) {
    return "❌ Parameter 'language' dan 'code' wajib diisi.";
  }

  const lang = language.toLowerCase();
  const b64 = Buffer.from(code, "utf-8").toString("base64");
  let cmd = "";

  if (lang === "javascript" || lang === "js" || lang === "node") {
    cmd = `echo "${b64}" | base64 -d | node -`;
  } else if (lang === "python" || lang === "py" || lang === "python3") {
    cmd = `echo "${b64}" | base64 -d | python3 -`;
  } else if (lang === "bash" || lang === "sh") {
    cmd = `echo "${b64}" | base64 -d | bash`;
  } else {
    return `❌ Bahasa '${language}' tidak didukung. Pilih: javascript, python, bash.`;
  }

  const sandboxCommand = toSandboxPath(cmd, sessionId);
  try {
    const output = await execInSandboxAsync(sessionId || "default", sandboxCommand, {
      timeout: 90_000,
      maxBuffer: 4 * 1024 * 1024,
      cwd: "/workspace"
    });
    return truncate(output || "(Kode berhasil dijalankan, tidak ada output)");
  } catch (err) {
    if (err.killed) {
      return (
        "⏱️ Eksekusi kode dihentikan karena melebihi timeout 90 detik.\n" +
        "Untuk pekerjaan panjang, simpan skrip ke file lalu jalankan run_command dengan {\"background\": true}."
      );
    }
    const stderr = err.stderr ? err.stderr.toString() : "";
    const stdout = err.stdout ? err.stdout.toString() : "";
    return truncate(
      `❌ Error saat menjalankan ${language} (exit ${exitCodeOf(err)}):\n${(stdout + "\n" + stderr).trim() || err.message}`
    );
  }
}

/**
 * Tool: web_search
 * Mencari di internet via DuckDuckGo HTML endpoint.
 * Menggunakan fetch bawaan Node.js (v18+).
 */
async function toolWebSearch({ query }) {
  if (!query || typeof query !== "string") {
    return "❌ Parameter 'query' wajib berupa string.";
  }

  try {
    const encodedQuery = encodeURIComponent(query);
    const url = `https://html.duckduckgo.com/html/?q=${encodedQuery}`;

    const response = await fetch(url, {
      method: "GET",
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      },
      signal: AbortSignal.timeout(10_000),
    });

    const html = await response.text();

    const titleMatches = [...html.matchAll(/<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi)];
    const snippetMatches = [...html.matchAll(/<a[^>]*class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/gi)];

    const results = [];
    for (let i = 0; i < Math.min(5, titleMatches.length); i++) {
      const rawTitle = titleMatches[i][2].replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").trim();
      let rawUrl = titleMatches[i][1];
      // Unpack duckduckgo redirect link if present
      const matchUddg = rawUrl.match(/uddg=([^&]+)/);
      if (matchUddg) {
        try {
          rawUrl = decodeURIComponent(matchUddg[1]);
        } catch (_) {}
      } else if (rawUrl.startsWith("//")) {
        rawUrl = "https:" + rawUrl;
      }

      const snippet = snippetMatches[i]
        ? snippetMatches[i][1].replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").trim()
        : "(tidak ada ringkasan)";

      results.push(`${i + 1}. ${rawTitle}\n   ${snippet}\n   🔗 ${rawUrl}`);
    }

    if (results.length === 0) {
      return `🔍 Pencarian "${query}": Tidak ditemukan hasil.`;
    }

    return `🔍 Hasil pencarian "${query}":\n\n${results.join("\n\n")}`;
  } catch (err) {
    if (err.name === "TimeoutError" || err.name === "AbortError") {
      return `⏱️ Pencarian timeout setelah 10 detik.`;
    }
    return `❌ Gagal melakukan pencarian: ${err.message}`;
  }
}

/**
 * Tool: read_url
 * Membaca konten dari URL, menghapus tag HTML, mengembalikan teks bersih.
 */
async function toolReadUrl({ url }) {
  if (!url || typeof url !== "string") {
    return "❌ Parameter 'url' wajib berupa string URL yang valid.";
  }

  // Validasi format URL dasar
  if (!/^https?:\/\//i.test(url)) {
    return "❌ URL harus dimulai dengan http:// atau https://";
  }

  try {
    const response = await fetch(url, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (compatible; NrozBot/1.0; +https://github.com/nroz)",
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,text/plain;q=0.8,*/*;q=0.7",
      },
      signal: AbortSignal.timeout(10_000),
      redirect: "follow",
    });

    const contentType = response.headers.get("content-type") || "";
    const rawBody = await response.text();

    // Jika konten bukan HTML, kembalikan langsung
    if (!contentType.includes("html")) {
      return truncate(rawBody);
    }

    // Bersihkan HTML: hapus script, style, lalu semua tag
    let text = rawBody
      .replace(/<script[\s\S]*?<\/script>/gi, "")   // hapus <script>
      .replace(/<style[\s\S]*?<\/style>/gi, "")      // hapus <style>
      .replace(/<nav[\s\S]*?<\/nav>/gi, "")           // hapus navigasi
      .replace(/<footer[\s\S]*?<\/footer>/gi, "")     // hapus footer
      .replace(/<header[\s\S]*?<\/header>/gi, "")     // hapus header (nav bar)
      .replace(/<[^>]+>/g, " ")                        // hapus semua tag HTML
      .replace(/&nbsp;/gi, " ")                        // entitas HTML umum
      .replace(/&amp;/gi, "&")
      .replace(/&lt;/gi, "<")
      .replace(/&gt;/gi, ">")
      .replace(/&quot;/gi, '"')
      .replace(/&#\d+;/g, "")                          // entitas HTML numerik
      .replace(/[ \t]+/g, " ")                         // multiple spasi -> satu spasi
      .replace(/\n\s*\n/g, "\n")                       // multiple baris kosong -> satu
      .trim();

    if (!text) {
      return "⚠️ Halaman berhasil diambil tapi tidak mengandung teks yang bisa diekstrak.";
    }

    return truncate(text);
  } catch (err) {
    if (err.name === "TimeoutError" || err.name === "AbortError") {
      return `⏱️ Request ke URL timeout setelah 10 detik.`;
    }
    return `❌ Gagal membaca URL: ${err.message}`;
  }
}

/**
 * Tool: system_info
 * Mengumpulkan informasi sistem VPS menggunakan modul os dan child_process.
 */
async function toolSystemInfo() {
  try {
    const uptime = os.uptime();
    const hours = Math.floor(uptime / 3600);
    const mins = Math.floor((uptime % 3600) / 60);

    const totalMem = os.totalmem();
    const freeMem = os.freemem();
    const usedMem = totalMem - freeMem;

    // Format bytes ke human-readable
    const fmt = (bytes) => {
      const gb = bytes / (1024 ** 3);
      return gb >= 1 ? `${gb.toFixed(2)} GB` : `${(bytes / (1024 ** 2)).toFixed(2)} MB`;
    };

    // Ambil info disk dengan df -h
    let diskInfo = "(tidak tersedia)";
    try {
      diskInfo = execSync("df -h --total 2>/dev/null || df -h", {
        timeout: 5000,
        encoding: "utf-8",
      }).trim();
    } catch (e) {
      diskInfo = `(error: ${e.message})`;
    }

    // CPU info
    const cpus = os.cpus();
    const cpuModel = cpus.length > 0 ? cpus[0].model.trim() : "(tidak diketahui)";

    // Load average
    const loadAvg = os.loadavg().map((v) => v.toFixed(2)).join(", ");

    const info = [
      `🖥️  Hostname  : ${os.hostname()}`,
      `💻  OS        : ${os.type()} ${os.release()} (${os.arch()})`,
      `⏱️  Uptime    : ${hours} jam ${mins} menit`,
      `🧠  CPU       : ${cpuModel} (${cpus.length} core)`,
      `📊  Load Avg  : ${loadAvg}`,
      `💾  Memori    : ${fmt(usedMem)} / ${fmt(totalMem)} (free: ${fmt(freeMem)})`,
      ``,
      `📁  Disk:`,
      diskInfo,
    ].join("\n");

    return truncate(info);
  } catch (err) {
    return `❌ Gagal mengambil info sistem: ${err.message}`;
  }
}

/**
 * Tool: file_read
 * Membaca isi file dengan validasi keamanan.
 */
async function toolFileRead({ path: filePath, sessionId }) {
  if (!filePath || typeof filePath !== "string") {
    return "❌ Parameter 'path' wajib berupa string.";
  }

  const resolved = resolveFilePath(filePath, sessionId);

  // Cek apakah file sensitif
  if (isSensitiveFile(resolved)) {
    return `⛔ Akses ditolak: file '${filePath}' termasuk file sensitif yang diproteksi.`;
  }

  try {
    // Pastikan file ada dan bisa dibaca
    if (!fs.existsSync(resolved)) {
      return `❌ File tidak ditemukan: ${resolved}`;
    }

    const stat = fs.statSync(resolved);
    if (stat.isDirectory()) {
      return `❌ Path '${resolved}' adalah direktori, bukan file. Gunakan tool file_list.`;
    }

    // Cek ukuran — tolak file terlalu besar untuk efisiensi
    if (stat.size > 5 * 1024 * 1024) {
      return `⚠️ File terlalu besar (${(stat.size / 1024 / 1024).toFixed(2)} MB). Maksimum 5 MB.`;
    }

    const content = fs.readFileSync(resolved, "utf-8");
    return truncate(`📄 ${resolved} (${stat.size} bytes):\n\n${content}`);
  } catch (err) {
    return `❌ Gagal membaca file: ${err.message}`;
  }
}

/**
 * Tool: file_write
 * Menulis konten ke file, membuat direktori induk otomatis.
 */
async function toolFileWrite({ path: filePath, content, sessionId }) {
  if (!filePath || typeof filePath !== "string") {
    return "❌ Parameter 'path' wajib berupa string.";
  }
  if (content === undefined || content === null) {
    return "❌ Parameter 'content' wajib diisi.";
  }

  const resolved = resolveFilePath(filePath, sessionId);

  // Cek apakah target di direktori sistem
  if (isSystemDir(resolved)) {
    return `⛔ Akses ditolak: tidak boleh menulis ke direktori sistem '${resolved}'.`;
  }

  try {
    // Buat direktori induk jika belum ada
    const dir = path.dirname(resolved);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    fs.writeFileSync(resolved, content, "utf-8");
    const size = Buffer.byteLength(content, "utf-8");
    const sessionWs = getSessionWorkspace(sessionId);
    if (!resolved.startsWith(sessionWs + path.sep) && resolved !== sessionWs) {
      return (
        `✅ Berhasil menulis ke ${resolved} (${size} bytes)\n` +
        `⚠️ File itu ada di host dan TIDAK terlihat oleh run_command — sandbox Docker hanya mount folder session sebagai /workspace. ` +
        `Kalau file ini akan dipakai run_command/run_code, tulis ulang ke /workspace/${path.basename(resolved)}.`
      );
    }
    return `✅ Berhasil menulis ke ${resolved} (${size} bytes) — dari sandbox terlihat sebagai ${toSandboxPath(resolved, sessionId)}`;
  } catch (err) {
    return `❌ Gagal menulis file: ${err.message}`;
  }
}

/**
 * Tool: file_list
 * Menampilkan daftar file di sebuah direktori.
 */
async function toolFileList({ path: dirPath, sessionId }) {
  const target = dirPath || ".";
  const resolved = resolveFilePath(target, sessionId);

  // Cek apakah target di direktori sistem
  if (isSystemDir(resolved)) {
    return `⛔ Akses ditolak: tidak boleh me-list direktori sistem '${resolved}'.`;
  }

  try {
    if (!fs.existsSync(resolved)) {
      return `❌ Direktori tidak ditemukan: ${resolved}`;
    }

    const stat = fs.statSync(resolved);
    if (!stat.isDirectory()) {
      return `❌ Path '${resolved}' bukan direktori. Gunakan tool file_read untuk membaca file.`;
    }

    const entries = fs.readdirSync(resolved, { withFileTypes: true });

    if (entries.length === 0) {
      return `📁 ${resolved}: (direktori kosong)`;
    }

    // Urutkan: folder dulu, lalu file
    const sorted = entries.sort((a, b) => {
      if (a.isDirectory() && !b.isDirectory()) return -1;
      if (!a.isDirectory() && b.isDirectory()) return 1;
      return a.name.localeCompare(b.name);
    });

    const lines = sorted.map((entry) => {
      const icon = entry.isDirectory() ? "📁" : "📄";
      let sizeStr = "";
      if (!entry.isDirectory()) {
        try {
          const s = fs.statSync(path.join(resolved, entry.name));
          const kb = s.size / 1024;
          sizeStr = kb >= 1024
            ? ` (${(kb / 1024).toFixed(1)} MB)`
            : ` (${kb.toFixed(1)} KB)`;
        } catch (_) {
          // Abaikan error saat baca ukuran file individual
        }
      }
      return `  ${icon} ${entry.name}${sizeStr}`;
    });

    return truncate(`📁 ${resolved} (${entries.length} item):\n\n${lines.join("\n")}`);
  } catch (err) {
    return `❌ Gagal membaca direktori: ${err.message}`;
  }
}

/**
 * Tool: http_request
 * Membuat HTTP request ke API eksternal menggunakan fetch bawaan Node.js.
 */
async function toolHttpRequest({ method, url, headers, body }) {
  if (!method || !url) {
    return "❌ Parameter 'method' dan 'url' wajib diisi.";
  }

  // Validasi format URL
  if (!/^https?:\/\//i.test(url)) {
    return "❌ URL harus dimulai dengan http:// atau https://";
  }

  try {
    const options = {
      method: method.toUpperCase(),
      headers: {
        "User-Agent": "NrozBot/1.0",
        ...(headers || {}),
      },
      signal: AbortSignal.timeout(15_000),
    };

    // Tambahkan body untuk POST/PUT
    if (body && (method === "POST" || method === "PUT")) {
      options.body = body;
      // Set Content-Type default jika belum ada
      if (!options.headers["Content-Type"] && !options.headers["content-type"]) {
        // Coba deteksi apakah body berupa JSON
        try {
          JSON.parse(body);
          options.headers["Content-Type"] = "application/json";
        } catch (_) {
          options.headers["Content-Type"] = "text/plain";
        }
      }
    }

    const response = await fetch(url, options);
    const responseText = await response.text();

    const statusLine = `${response.status} ${response.statusText}`;
    const respHeaders = {};
    response.headers.forEach((value, key) => {
      respHeaders[key] = value;
    });

    const result = [
      `📡 ${method.toUpperCase()} ${url}`,
      `Status: ${statusLine}`,
      `Content-Type: ${respHeaders["content-type"] || "(tidak ada)"}`,
      ``,
      `Response Body:`,
      responseText,
    ].join("\n");

    return truncate(result);
  } catch (err) {
    if (err.name === "TimeoutError" || err.name === "AbortError") {
      return `⏱️ HTTP request timeout setelah 15 detik.`;
    }
    return `❌ Gagal melakukan HTTP request: ${err.message}`;
  }
}

/**
 * Tool: start_web_preview
 * Membuka tunnel Cloudflare ke port lokal
 */
async function toolStartWebPreview({ port, duration_minutes }) {
  try {
    const url = await startWebPreview(port, duration_minutes || 30);
    return `🌐 Link Web Preview Publik Aktif:\n🔗 ${url}\n\nLink ini dapat langsung dibuka di browser mana saja (aktif selama ${duration_minutes || 30} menit).`;
  } catch (err) {
    return `❌ Gagal membuat web preview: ${err.message}`;
  }
}

/**
 * Tool: create_reminder
 * Menjadwalkan pengingat Telegram
 */
async function toolCreateReminder({ message, minutes_from_now, sessionId }) {
  if (!message || !minutes_from_now) return "❌ 'message' dan 'minutes_from_now' wajib diisi.";
  const mins = Number(minutes_from_now);
  if (isNaN(mins) || mins <= 0) return "❌ 'minutes_from_now' harus berupa angka positif.";

  const targetTime = Date.now() + (mins * 60 * 1000);
  const targetDateStr = new Date(targetTime).toLocaleString("id-ID");
  addReminder(sessionId || "default", message, targetTime);
  return `⏰ Pengingat berhasil dijadwalkan!\n• Pesan: "${message}"\n• Waktu: ${targetDateStr} (${mins} menit dari sekarang).`;
}

/**
 * Tool: create_watchdog
 * Memasang pemantau server/website
 */
async function toolCreateWatchdog({ url, interval_minutes, sessionId }) {
  if (!url) return "❌ 'url' wajib diisi.";
  const interval = Number(interval_minutes) || 10;
  addWatchdog(sessionId || "default", url, interval);
  return `🚨 Watchdog pemantau server aktif untuk: ${url}\n• Interval pengecekan: Setiap ${interval} menit.\nBot akan otomatis mengirimkan peringatan di Telegram jika website down/error.`;
}

/**
 * Tool: media_download
 * Mengunduh video/audio dari link media via yt-dlp
 */
async function toolMediaDownload({ url, format = "video", sessionId }) {
  if (!url) return "❌ 'url' wajib diisi.";
  const safeSession = String(sessionId || "default").replace(/[^a-zA-Z0-9_\-]/g, "_");
  const workspaceDir = path.join("/root/nroz/workspace", safeSession);
  if (!fs.existsSync(workspaceDir)) fs.mkdirSync(workspaceDir, { recursive: true });

  const isAudio = format === "audio" || format === "mp3";
  const outputTemplate = path.join(workspaceDir, "%(title).40s.%(ext)s");
  const cmd = isAudio
    ? `yt-dlp -x --audio-format mp3 --max-filesize 45M -o "${outputTemplate}" "${url}"`
    : `yt-dlp -f "best[ext=mp4]/best" --max-filesize 45M -o "${outputTemplate}" "${url}"`;

  try {
    const output = execSync(cmd, {
      timeout: 120_000,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"]
    });

    const items = fs.readdirSync(workspaceDir);
    let downloadedFile = "";
    let newestTime = 0;
    for (const item of items) {
      const p = path.join(workspaceDir, item);
      try {
        const st = fs.statSync(p);
        if (st.isFile() && st.mtimeMs > newestTime) {
          newestTime = st.mtimeMs;
          downloadedFile = p;
        }
      } catch (_) {}
    }

    if (downloadedFile) {
      return `✅ Berhasil mengunduh media:\n${path.basename(downloadedFile)}\n\nKirimkan file ini ke user menggunakan tag:\n<<<SENDFILE:${downloadedFile}>>>`;
    }
    return `✅ Selesai:\n${truncate(output)}`;
  } catch (err) {
    const stderr = err.stderr ? err.stderr.toString() : "";
    return `❌ Gagal mengunduh media: ${stderr || err.message}`;
  }
}

/**
 * Tool: render_remotion_video
 * Membuat dan merender video animasi secara terprogram dari kode React/Remotion (Opsi B).
 */
async function toolRenderRemotionVideo({ code, duration_seconds, fps, width, height, title, sessionId, tts_text, tts_lines, tts_voice, audio_path, chatId, threadId }) {
  if (!code || typeof code !== "string") {
    return "❌ Parameter 'code' (kode React/Remotion) wajib diisi.";
  }

  let narration = tts_lines;
  if (typeof narration === "string") {
    try {
      narration = JSON.parse(narration);
    } catch (_) {
      return "❌ Parameter 'tts_lines' tidak bisa dibaca. Kirim sebagai array objek: [{\"text\":\"...\",\"voice\":\"id-female\"}]";
    }
  }
  if (narration && !Array.isArray(narration)) {
    return "❌ Parameter 'tts_lines' harus berupa array baris naskah.";
  }

  let catatanAudio = "";
  if (audio_path) {
    const hostAudio = toHostPath(String(audio_path).trim(), sessionId || "default");
    if (!fs.existsSync(hostAudio) || !fs.statSync(hostAudio).isFile()) {
      return (
        `❌ audio_path "${audio_path}" tidak ditemukan.\n` +
        `File harus ada di folder kerjamu: taruh sebagai /workspace/${path.basename(hostAudio)} ` +
        `(run_command/file_write hanya menulis ke sandbox kalau path dimulai /workspace), lalu panggil render lagi.\n` +
        `Kalau yang dimaksud adalah suara narasi, pakai tts_text atau tts_lines saja — sistem yang membuat audionya.`
      );
    }
    if ((tts_text && String(tts_text).trim()) || (narration && narration.length)) {
      catatanAudio = "\n• Catatan: audio_path diabaikan karena voiceover TTS dipakai; suara AI yang masuk ke video.";
    }
    audio_path = hostAudio;
  }

  const { job, position } = queueRender(
    {
      code,
      durationSeconds: duration_seconds,
      fps,
      width,
      height,
      title,
      sessionId: sessionId || "default",
      tts_text,
      tts_lines: narration,
      tts_voice,
      audio_path
    },
    { chatId, threadId }
  );

  const estimasiMenit = Math.max(1, Math.round((job.estimateSec + job.waitSec) / 60));
  const catatanAntrean = position > 1 ? `\n• Posisi antrean: ${position} (render sebelumnya masih berjalan)` : "";
  const catatanNarasi = narration && narration.length ? `\n• Voiceover: ${narration.length} baris naskah, durasi video mengikuti panjang suara` : "";

  return (
    `⏳ Render video #${job.id} dimulai di latar belakang.\n` +
    `• Judul: ${title || "video"}\n` +
    `• Durasi: ${job.duration} detik (${job.frames} frame${duration_seconds > job.duration ? `, diminta ${duration_seconds}s tapi dipangkas ke batas maksimum` : ""})${catatanNarasi}\n` +
    `• Estimasi selesai: ±${estimasiMenit} menit${catatanAntrean}${catatanAudio}\n\n` +
    `PENTING: Video akan DIKIRIM OTOMATIS oleh sistem ke chat ini saat render selesai.\n` +
    `Selama rendering, sistem menampilkan satu pesan progres (persen, jumlah frame, sisa waktu) yang di-update sendiri — ` +
    `bilang saja ke user bahwa progresnya bisa dipantau di chat, jangan membuat pesan progres sendiri.\n` +
    `Hasil ≤ 48 MB masuk sebagai video native; yang lebih besar dikirim otomatis sebagai link unduhan HTTPS — ` +
    `jadi JANGAN mengompres ulang, menurunkan bitrate, atau memecah video supaya muat 50 MB.\n` +
    `Jangan menunggu hasil, jangan render ulang kode yang sama, dan jangan pakai tag <<<SENDVIDEO>>>.\n` +
    `Cukup kabari user bahwa videonya sedang dikerjakan, lalu akhiri jawabanmu.`
  );
}

// ============================================================
// EXECUTOR UTAMA — MAPPING NAMA TOOL KE IMPLEMENTASI
// ============================================================

/**
 * Peta nama tool ke fungsi implementasinya.
 * Setiap fungsi menerima objek args dan mengembalikan string.
 */
const TOOL_HANDLERS = {
  run_command: toolRunCommand,
  check_command_output: toolCheckCommandOutput,
  run_code: toolRunCode,
  web_search: toolWebSearch,
  read_url: toolReadUrl,
  system_info: toolSystemInfo,
  file_read: toolFileRead,
  file_write: toolFileWrite,
  file_list: toolFileList,
  http_request: toolHttpRequest,
  start_web_preview: toolStartWebPreview,
  create_reminder: toolCreateReminder,
  create_watchdog: toolCreateWatchdog,
  media_download: toolMediaDownload,
  render_remotion_video: toolRenderRemotionVideo,
};

/**
 * Ringkasan satu baris yang aman ditampilkan ke user: bukan dump argumen, tapi apa yang
 * sebenarnya sedang dikerjakan. Nilai yang terlihat seperti secret disamarkan.
 */
function describeToolCall(name, args = {}) {
  // Draft Telegram dikirim tanpa parse_mode, jadi karakter asli (underscore nama file,
  // tanda kutip, path) boleh dan justru harus ditampilkan apa adanya.
  const oneLine = (text, max = 90, fallback = "...") => {
    const bersih = String(text ?? "").replace(/\s+/g, " ").trim().slice(0, max).trim();
    return bersih || fallback;
  };

  const maskSecret = (text) =>
    oneLine(text, 4000)
      .replace(/(["']?(api[_-]?key|token|secret|password|authorization)["']?)\s*[:=]\s*["']?[^\s,"'}]+/gi, "$1:***");

  switch (name) {
    case "run_command": {
      const cmd = oneLine(maskSecret(args.command), 90, "perintah");
      return `menjalankan \`${cmd}\`${args.background ? " (latar belakang)" : ""}`;
    }
    case "check_command_output":
      return `mengecek output job ${oneLine(args.job_id, 20, "semua")}`;
    case "run_code": {
      const firstLine = oneLine(
        String(args.code || "")
          .split("\n")
          .map((l) => l.trim())
          .find((l) => l && !l.startsWith("//") && !l.startsWith("#") && !l.startsWith("/*")) || "",
        70
      );
      return `menjalankan ${oneLine(args.language || "kode", 12)}: ${firstLine}`;
    }
    case "web_search":
      return `mencari "${oneLine(args.query, 70)}"`;
    case "read_url":
      return `membaca ${oneLine(args.url, 70)}`;
    case "http_request":
      return `${oneLine((args.method || "GET").toUpperCase(), 8)} ${oneLine(args.url, 70)}`;
    case "file_read":
      return `membaca ${oneLine(path.basename(args.path || ""), 40)}`;
    case "file_write":
      return `menulis ${oneLine(path.basename(args.path || ""), 40)} (${Buffer.byteLength(String(args.content || ""))} byte)`;
    case "file_list":
      return `daftar isi ${oneLine(args.path || ".", 40)}`;
    case "system_info":
      return "mengecek kondisi server";
    case "start_web_preview":
      return `membuka preview web di port ${oneLine(args.port, 6)}`;
    case "create_reminder":
      return `menjadwalkan pengingat ${oneLine(args.minutes_from_now, 6)} menit lagi: ${oneLine(args.message, 50)}`;
    case "create_watchdog":
      return `memantau ${oneLine(args.url, 60)}`;
    case "media_download":
      return `mengunduh media dari ${oneLine(args.url, 70)}`;
    case "render_remotion_video": {
      const bagian = [];
      if (args.title) bagian.push(oneLine(args.title, 30));
      if (args.duration_seconds) bagian.push(`${args.duration_seconds}s`);
      if (args.fps) bagian.push(`${args.fps}fps`);
      if (args.tts_lines?.length) bagian.push(`${args.tts_lines.length} baris naskah`);
      else if (args.tts_text) bagian.push(`${oneLine(args.tts_text, 24)}...`);
      return `merender video ${bagian.join(" · ") || "(tanpa judul)"}`;
    }
    default:
      return oneLine(maskSecret(`${name} ${JSON.stringify(args)}`), 90, name);
  }
}

/**
 * Menjalankan tool berdasarkan nama, argumen, dan context (sessionId).
 * Selalu mengembalikan string — tidak pernah melempar error.
 *
 * @param {string} name - Nama tool yang akan dijalankan
 * @param {object} args - Argumen untuk tool tersebut
 * @param {object} context - Konteks eksekusi (sessionId dsb)
 * @returns {Promise<string>} - Hasil eksekusi tool
 */
async function executeTool(name, args, context = {}) {
  try {
    // Cari handler tool
    const handler = TOOL_HANDLERS[name];
    if (!handler) {
      return `❌ Tool '${name}' tidak ditemukan. Tool yang tersedia: ${Object.keys(TOOL_HANDLERS).join(", ")}`;
    }

    // Pastikan args berupa objek
    const safeArgs = typeof args === "object" && args !== null ? { ...args } : {};
    if (context && context.sessionId) {
      safeArgs.sessionId = context.sessionId;
    }
    if (context && context.chatId !== undefined) {
      safeArgs.chatId = context.chatId;
    }
    if (context && context.threadId !== undefined) {
      safeArgs.threadId = context.threadId;
    }

    // Jalankan tool dan kembalikan hasilnya
    const result = await handler(safeArgs);
    return typeof result === "string" ? result : String(result);
  } catch (err) {
    // Lapisan keamanan terakhir — jangan pernah lempar error ke pemanggil
    return `❌ Error tak terduga saat menjalankan tool '${name}': ${err.message}`;
  }
}

// ============================================================
// EKSPOR MODUL
// ============================================================

module.exports = {
  TOOL_DEFINITIONS,
  executeTool,
  describeToolCall,
};
