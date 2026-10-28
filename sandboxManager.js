/**
 * sandboxManager.js — Pengelola Persistent Docker Sandbox untuk Nroz AI Agent
 *
 * Mengelola container Docker terisolasi untuk setiap session/user Telegram.
 * Fitur:
 * - Persistent container per user: nroz-sandbox-<sessionId>
 * - Auto-start jika container mati
 * - Eksekusi perintah di dalam sandbox terisolasi
 * - Proteksi resource (maks 1GB RAM, 2 CPU)
 * - Mount folder workspace host ke /workspace container
 * - Eksekusi async (tidak memblokir bot) dan mode jalan di latar belakang
 * - Reset sandbox on demand (/resetsandbox)
 */

const { execSync, execFile, spawn } = require("child_process");
const fs = require("fs");
const path = require("path");

const SANDBOX_IMAGE = "nroz-sandbox:latest";
const WORKSPACE_BASE = path.join(__dirname, "workspace");

function getSafeSessionId(sessionId) {
  return String(sessionId || "default").trim().replace(/[^a-zA-Z0-9_\-]/g, "_");
}

/**
 * Direktori workspace host yang ter-mount sebagai /workspace di dalam container.
 * Dipakai tool file_* supaya path host dan path sandbox artinya sama.
 */
function getSessionWorkspace(sessionId) {
  const dir = path.join(WORKSPACE_BASE, getSafeSessionId(sessionId));
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function toSandboxCwd(cwd) {
  if (!cwd) return "/workspace";
  // Normalisasi cwd jika dikasih path host
  if (cwd.includes(WORKSPACE_BASE)) {
    const parts = cwd.split(WORKSPACE_BASE);
    const sub = parts[1] ? parts[1].replace(/^\/[^\/]+/, "") : "";
    return path.posix.join("/workspace", sub || "/");
  }
  return cwd;
}

function getSafeContainerName(sessionId) {
  const safe = String(sessionId || "default").trim().replace(/[^a-zA-Z0-9_\-]/g, "_");
  return `nroz-sandbox-${safe}`;
}

/**
 * Memastikan image Docker sandbox (nroz-sandbox:latest) sudah tersedia.
 * Jika belum ada di sistem (misal deploy di VPS baru), otomatis build dari Dockerfile.sandbox.
 */
function ensureSandboxImage() {
  try {
    execSync(`docker image inspect ${SANDBOX_IMAGE}`, {
      stdio: ["pipe", "pipe", "pipe"],
      encoding: "utf-8"
    });
    return true; // Image sudah tersedia
  } catch (_) {
    console.log(`[Sandbox Auto-Build] Image '${SANDBOX_IMAGE}' belum ada di VPS ini.`);
    const dockerfilePath = path.join(__dirname, "Dockerfile.sandbox");

    if (fs.existsSync(dockerfilePath)) {
      console.log(`[Sandbox Auto-Build] Membangun image '${SANDBOX_IMAGE}' dari ${dockerfilePath}...`);
      try {
        execSync(`docker build -f "${dockerfilePath}" -t ${SANDBOX_IMAGE} "${__dirname}"`, {
          stdio: "inherit"
        });
        console.log(`[Sandbox Auto-Build] ✅ Berhasil membangun image '${SANDBOX_IMAGE}'!`);
        return true;
      } catch (err) {
        console.error(`[Sandbox Auto-Build] Gagal build Dockerfile: ${err.message}. Mencoba fallback ke ubuntu:24.04...`);
      }
    }

    // Fallback jika Dockerfile tidak ditemukan atau build gagal
    try {
      console.log(`[Sandbox Auto-Build] Mengunduh base image ubuntu:24.04 sebagai fallback...`);
      execSync(`docker pull ubuntu:24.04 && docker tag ubuntu:24.04 ${SANDBOX_IMAGE}`, {
        stdio: "inherit"
      });
      console.log(`[Sandbox Auto-Build] ✅ Selesai mengunduh fallback image!`);
      return true;
    } catch (pullErr) {
      console.error(`[Sandbox Auto-Build] Gagal pull fallback image:`, pullErr.message);
      throw pullErr;
    }
  }
}

function ensureSandbox(sessionId) {
  const containerName = getSafeContainerName(sessionId);
  const hostWorkspace = path.join(WORKSPACE_BASE, getSafeSessionId(sessionId));

  if (!fs.existsSync(hostWorkspace)) {
    fs.mkdirSync(hostWorkspace, { recursive: true });
  }

  try {
    // Cek apakah container sudah ada
    const inspect = execSync(`docker inspect -f '{{.State.Running}}' ${containerName}`, {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"]
    }).trim();

    if (inspect === "true") {
      return containerName; // Sudah berjalan
    } else {
      // Container ada tapi sedang berhenti -> start kembali
      execSync(`docker start ${containerName}`, { stdio: ["pipe", "pipe", "pipe"] });
      return containerName;
    }
  } catch (_) {
    // Container belum ada -> pastikan image tersedia, lalu buat baru
    try {
      ensureSandboxImage();
      execSync(
        `docker run -d ` +
        `--name ${containerName} ` +
        `--restart unless-stopped ` +
        `--memory 1024m ` +
        `--cpus 2.0 ` +
        `-v "${hostWorkspace}:/workspace" ` +
        `-w /workspace ` +
        `${SANDBOX_IMAGE} tail -f /dev/null`,
        { stdio: ["pipe", "pipe", "pipe"], encoding: "utf-8" }
      );
      return containerName;
    } catch (createErr) {
      console.error(`[Sandbox Error] Gagal membuat container ${containerName}:`, createErr.message);
      throw createErr;
    }
  }
}

/**
 * Menjalankan perintah di dalam sandbox container session
 * @param {string} sessionId
 * @param {string} command
 * @param {object} options
 * @returns {string} output terminal
 */
function execInSandbox(sessionId, command, options = {}) {
  const containerName = ensureSandbox(sessionId);
  const timeoutMs = options.timeout || 30_000;
  const maxBuffer = options.maxBuffer || 1024 * 1024;
  const cwd = toSandboxCwd(options.cwd);

  // Eksekusi di dalam container menggunakan docker exec
  return execSync(
    `docker exec -i -w "${cwd}" ${containerName} bash -c ${JSON.stringify(command)}`,
    {
      timeout: timeoutMs,
      maxBuffer: maxBuffer,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"]
    }
  );
}

/**
 * Versi async — tidak memblokir event loop bot, jadi user tetap bisa dibalas
 * dan pesan lain tetap diproses selama perintah berjalan.
 * @returns {Promise<string>} stdout perintah
 */
function execInSandboxAsync(sessionId, command, options = {}) {
  const containerName = ensureSandbox(sessionId);
  const timeoutMs = options.timeout || 120_000;
  const maxBuffer = options.maxBuffer || 4 * 1024 * 1024;
  const cwd = toSandboxCwd(options.cwd);
  // lowPriority dipakai saat antrean video sedang merender, supaya pekerjaan berat
  // di sandbox tidak merebut CPU dan memperlambat render yang sedang dijanjikan ke user.
  const niceArgs = options.lowPriority ? ["nice", "-n", "10", "ionice", "-c2", "-n7"] : [];

  return new Promise((resolve, reject) => {
    // Perintah dikirim lewat stdin (bash -s), bukan sebagai argumen, supaya cmdline proses di
    // dalam container hanya "bash -s". Kalau tidak, `pkill -f render.mjs` akan mencocokki
    // shell yang sedang menjalankan perintah itu sendiri dan membunuhnya.
    // cat: execFile dengan opsi `input` tidak menutup stream ke `docker exec -i`, jadi bash
    // menunggu selamanya; stdin harus ditulis dan di-end eksplisit memakai spawn.
    const child = spawn("docker", ["exec", "-i", "-w", cwd, containerName, ...niceArgs, "bash", "-s"], {
      stdio: ["pipe", "pipe", "pipe"]
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let overflow = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);

    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      if (stdout.length > maxBuffer) {
        overflow = true;
        child.kill("SIGKILL");
      }
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.stdin.on("error", () => {}); // EPIPE biasa terjadi bila perintah selesai lebih cepat
    child.on("error", (err) => {
      clearTimeout(timer);
      err.stdout = stdout;
      err.stderr = stderr;
      reject(err);
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      if (timedOut) {
        const err = new Error(`Perintah dihentikan setelah ${Math.round(timeoutMs / 1000)} detik`);
        err.killed = true;
        err.stdout = stdout;
        err.stderr = stderr;
        reject(err);
        return;
      }
      if (overflow) {
        const err = new Error("Output perintah melebihi batas buffer dan dihentikan");
        err.stdout = stdout;
        err.stderr = stderr;
        err.code = code;
        reject(err);
        return;
      }
      if (code !== 0) {
        const err = new Error(`Perintah selesai dengan kode ${code ?? signal}`);
        err.code = code;
        err.signal = signal;
        err.stdout = stdout;
        err.stderr = stderr;
        reject(err);
        return;
      }
      resolve(stdout);
    });

    child.stdin.write(command.endsWith("\n") ? command : `${command}\n`);
    child.stdin.end();
  });
}

/**
 * Menjalankan perintah tanpa menunggu selesai (mode background).
 * Output ditampung ke <workspace>/.bg/<jobId>.log dan exit code ke .exit,
 * keduanya terlihat dari host maupun container karena folder workspace ter-mount.
 */
function startBackgroundInSandbox(sessionId, command, jobId, options = {}) {
  const containerName = ensureSandbox(sessionId);
  const hostWorkspace = getSessionWorkspace(sessionId);
  const bgDir = path.join(hostWorkspace, ".bg");
  if (!fs.existsSync(bgDir)) fs.mkdirSync(bgDir, { recursive: true });

  const logPath = path.join(bgDir, `${jobId}.log`);
  const exitPath = path.join(bgDir, `${jobId}.exit`);
  fs.writeFileSync(logPath, "", "utf-8");
  if (fs.existsSync(exitPath)) fs.unlinkSync(exitPath);

  const niceArgs = options.lowPriority ? ["nice", "-n", "10", "ionice", "-c2", "-n7"] : [];
  const script = `{ ${command}\n} > /workspace/.bg/${jobId}.log 2>&1; echo $? > /workspace/.bg/${jobId}.exit`;
  const child = spawn("docker", ["exec", "-i", "-w", "/workspace", containerName, ...niceArgs, "bash", "-lc", script], {
    detached: true,
    stdio: ["ignore", "ignore", "ignore"]
  });
  child.on("error", (err) => console.error(`[Sandbox BG] Job ${jobId} gagal dimulai:`, err.message));
  child.unref();

  return { logPath, exitPath, jobId };
}

function resetSandbox(sessionId) {
  const containerName = getSafeContainerName(sessionId);
  try {
    execSync(`docker rm -f ${containerName}`, { stdio: ["pipe", "pipe", "pipe"] });
    return true;
  } catch (_) {
    return false;
  }
}

function getSandboxInfo(sessionId) {
  const containerName = getSafeContainerName(sessionId);
  try {
    const raw = execSync(
      `docker inspect -f 'Status: {{.State.Status}} | Started: {{.State.StartedAt}}' ${containerName}`,
      { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }
    ).trim();
    return { exists: true, info: raw, containerName };
  } catch (_) {
    return { exists: false, containerName };
  }
}

module.exports = {
  ensureSandbox,
  ensureSandboxImage,
  execInSandbox,
  execInSandboxAsync,
  startBackgroundInSandbox,
  getSessionWorkspace,
  toSandboxCwd,
  resetSandbox,
  getSandboxInfo,
  getSafeContainerName,
  SANDBOX_IMAGE
};
