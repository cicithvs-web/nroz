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
const { execInSandbox } = require("./sandboxManager.js");
const { startWebPreview, stopWebPreview, listActivePreviews } = require("./webPreviewManager.js");
const { addReminder, addWatchdog, listTasks, removeTask } = require("./schedulerManager.js");
const { renderRemotionVideo } = require("./remotionManager.js");

// ============================================================
// KONSTANTA DAN UTILITAS
// ============================================================

/** Batas maksimum karakter output yang dikembalikan ke model */
const MAX_OUTPUT = 4000;

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
        "menjalankan script, kompilasi kode, atau mengelola proses tanpa batasan.",
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
        },
        required: ["command"],
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
        "Timeout 15 detik. Cocok untuk kalkulasi, pemrosesan data, atau testing kode.",
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
        "Video hasil render disimpan di workspace pengguna.",
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
            description: "Durasi video dalam detik (1 sampai 60 detik, default: 5 detik)",
          },
          fps: {
            type: "number",
            description: "Frame per second (default: 30)",
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
            description: "Naskah narasi / suara manusia yang ingin diucapkan oleh AI di video (Voiceover otomatis berkualitas studio)",
          },
          tts_voice: {
            type: "string",
            enum: ["id-male", "id-female", "en-male", "en-female"],
            description: "Pilihan suara AI: 'id-male' (Ardi - pria ID), 'id-female' (Gadis - wanita ID), 'en-male' (Christopher), 'en-female' (Jenny). Default: 'id-male'",
          },
          audio_path: {
            type: "string",
            description: "Path file audio (MP3/WAV) di workspace server jika ingin memasukkan backsound atau suara rekaman user sendiri",
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
 */
async function toolRunCommand({ command, cwd, sessionId }) {
  if (!command || typeof command !== "string") {
    return "❌ Parameter 'command' wajib berupa string.";
  }

  // Berikan waktu ekstra (60 detik) untuk perintah instalasi package
  const isInstallCmd = /\b(apt-get|apt|npm|pip|pip3|cargo)\s+install\b/i.test(command);
  const timeoutMs = isInstallCmd ? 60_000 : 30_000;

  try {
    const output = execInSandbox(sessionId || "default", command, {
      timeout: timeoutMs,
      maxBuffer: 1024 * 1024,
      cwd: cwd || "/workspace"
    });
    return truncate(output || "(Perintah berhasil, tidak ada output)");
  } catch (err) {
    if (err.killed) {
      return `⏱️ Perintah dihentikan karena melebihi timeout ${timeoutMs / 1000} detik.`;
    }
    const stderr = err.stderr ? err.stderr.toString() : "";
    const stdout = err.stdout ? err.stdout.toString() : "";
    const combined = (stdout + "\n" + stderr).trim();
    return truncate(
      `❌ Perintah gagal (exit code ${err.status || "?"})\n${combined || err.message}`
    );
  }
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

  try {
    const output = execInSandbox(sessionId || "default", cmd, {
      timeout: 20_000,
      maxBuffer: 1024 * 1024,
      cwd: "/workspace"
    });
    return truncate(output || "(Kode berhasil dijalankan, tidak ada output)");
  } catch (err) {
    if (err.killed) {
      return `⏱️ Eksekusi ${language} dihentikan karena melebihi timeout 20 detik.`;
    }
    const stderr = err.stderr ? err.stderr.toString() : "";
    const stdout = err.stdout ? err.stdout.toString() : "";
    return truncate(
      `❌ Error saat menjalankan ${language}:\n${(stdout + "\n" + stderr).trim() || err.message}`
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
async function toolFileRead({ path: filePath }) {
  if (!filePath || typeof filePath !== "string") {
    return "❌ Parameter 'path' wajib berupa string.";
  }

  const resolved = path.resolve(filePath);

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
async function toolFileWrite({ path: filePath, content }) {
  if (!filePath || typeof filePath !== "string") {
    return "❌ Parameter 'path' wajib berupa string.";
  }
  if (content === undefined || content === null) {
    return "❌ Parameter 'content' wajib diisi.";
  }

  const resolved = path.resolve(filePath);

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
    return `✅ Berhasil menulis ke ${resolved} (${size} bytes)`;
  } catch (err) {
    return `❌ Gagal menulis file: ${err.message}`;
  }
}

/**
 * Tool: file_list
 * Menampilkan daftar file di sebuah direktori.
 */
async function toolFileList({ path: dirPath }) {
  const target = dirPath || ".";
  const resolved = path.resolve(target);

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
async function toolRenderRemotionVideo({ code, duration_seconds, fps, width, height, title, sessionId, tts_text, tts_voice, audio_path }) {
  if (!code || typeof code !== "string") {
    return "❌ Parameter 'code' (kode React/Remotion) wajib diisi.";
  }

  try {
    const res = await renderRemotionVideo({
      code,
      durationSeconds: duration_seconds,
      fps,
      width,
      height,
      title,
      sessionId: sessionId || "default",
      tts_text,
      tts_voice,
      audio_path,
    });

    if (!res.success) {
      return `❌ Gagal merender video Remotion:\n${res.error}`;
    }

    return (
      `🎬 Video Remotion Berhasil Dirender!\n` +
      `• Path File: ${res.videoPath}\n` +
      `• Durasi: ${res.duration} detik\n` +
      `• Ukuran File: ${res.sizeMb} MB\n` +
      `• Waktu Render: ${res.elapsedSec} detik\n\n` +
      `PENTING: Segera kirimkan video ini kepada user di Telegram menggunakan tag berikut:\n` +
      `<<<SENDVIDEO:${res.videoPath}>>>`
    );
  } catch (err) {
    return `❌ Error saat proses rendering Remotion: ${err.message}`;
  }
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
};
