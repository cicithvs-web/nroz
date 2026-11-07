/**
 * tools/shell.js — Tool eksekusi di Docker sandbox: run_command, check_command_output, run_code.
 */

const fs = require("fs");
const { execInSandboxAsync, startBackgroundInSandbox } = require("../sandboxManager.js");
const { getRenderQueueStatus } = require("../remotionManager.js");
const { startTerminalStream } = require("../bot/terminalStream.js");
const { truncate, toSandboxPath, exitCodeOf, toHostPathPreview, tailFile } = require("./common");

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
 * Tool: run_command
 * Menjalankan perintah shell di dalam Persistent Docker Sandbox user terisolasi.
 * Bebas tanpa larangan perintah karena terisolasi 100% di dalam container Docker.
 * background=true -> perintah dijalankan tanpa menunggu, cek hasil pakai check_command_output.
 */
async function toolRunCommand({ command, cwd, sessionId, background, chatId, threadId }) {
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
      // Live tail: chat pribadi = draft streaming native, grup = pesan yang diedit berkala.
      startTerminalStream(jobId, {
        sessionId: sessionId || "default",
        chatId,
        threadId,
        logPath,
        exitPath,
        command: toHostPathPreview(command)
      });
      return (
        `${catatanPrioritas}🌙 Job ${jobId} dijalankan di latar belakang.\n` +
        `• Cek hasil dengan check_command_output, atau tunggu sekali jalan dengan wait_command_output({"job_id":"${jobId}"})\n` +
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
 * Tool: wait_command_output
 * MENUNGGU job background selesai (maks 10 menit) lalu mengembalikan status akhirnya.
 * Satu panggilan menggantikan poling check_command_output berulang-ulang yang memakan
 * ronde tool dan token. Selagi menunggu, user melihat live tail terminal di chat.
 */
async function toolWaitCommandOutput({ job_id, timeout_seconds }) {
  const job = backgroundJobs.get(String(job_id));
  if (!job) {
    return `❌ Job '${job_id}' tidak ditemukan. Job yang dikenal: ${[...backgroundJobs.keys()].join(", ") || "(kosong)"}`;
  }

  const timeoutMs = Math.min(Math.max(Number(timeout_seconds) || 600, 5), 600) * 1000;
  const start = Date.now();
  while (!fs.existsSync(job.exitPath) && Date.now() - start < timeoutMs) {
    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  if (!fs.existsSync(job.exitPath)) {
    return (
      `⏱️ Job ${job_id} masih berjalan setelah ${Math.round(timeoutMs / 1000)} detik — menunggu dihentikan.\n` +
      `Panggil lagi wait_command_output dengan timeout lebih panjang, atau cek sekilas lewat check_command_output.`
    );
  }
  return toolCheckCommandOutput({ job_id });
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

module.exports = { toolRunCommand, toolCheckCommandOutput, toolWaitCommandOutput, toolRunCode };
