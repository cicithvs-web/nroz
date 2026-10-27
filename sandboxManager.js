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
 * - Reset sandbox on demand (/resetsandbox)
 */

const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const SANDBOX_IMAGE = "nroz-sandbox:latest";
const WORKSPACE_BASE = path.join(__dirname, "workspace");

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
  const hostWorkspace = path.join(
    WORKSPACE_BASE,
    String(sessionId || "default").trim().replace(/[^a-zA-Z0-9_\-]/g, "_")
  );

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
  let cwd = options.cwd || "/workspace";

  // Normalisasi cwd jika dikasih path host
  if (cwd.includes("/root/nroz/workspace")) {
    const parts = cwd.split("/root/nroz/workspace");
    const sub = parts[1] ? parts[1].replace(/^\/[^\/]+/, "") : "";
    cwd = path.posix.join("/workspace", sub || "/");
  }

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
  resetSandbox,
  getSandboxInfo,
  getSafeContainerName,
  SANDBOX_IMAGE
};
