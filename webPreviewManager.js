/**
 * webPreviewManager.js — Pengelola Cloudflare Quick Tunnel untuk Web Preview
 * Membuat link HTTPS publik instan dari server lokal/container
 */

const { spawn } = require("child_process");
const net = require("net");
const { getSandboxIP } = require("./sandboxManager.js");

const activeTunnels = new Map(); // key -> { process, url, port, targetHost, startedAt, timer }

/**
 * Memeriksa apakah port pada host tertentu terbuka dan menerima koneksi TCP.
 */
function checkPortOpen(host, port, timeoutMs = 800) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("timeout", () => {
      socket.destroy();
      resolve(false);
    });
    socket.once("error", () => {
      socket.destroy();
      resolve(false);
    });
    socket.connect(port, host);
  });
}

/**
 * Menentukan IP tujuan tunnel:
 * 1. Jika targetHost diberikan eksplisit -> gunakan itu.
 * 2. Cek apakah port aktif di dalam container sandbox user (docker bridge).
 * 3. Cek apakah port aktif di host 127.0.0.1.
 * 4. Fallback ke container sandbox jika ada sessionId, atau 127.0.0.1 jika tidak.
 */
async function resolveTargetHost(port, options = {}) {
  const p = Number(port);
  if (options.targetHost) return options.targetHost;

  const sessionId = options.sessionId;
  let containerIP = null;
  if (sessionId) {
    try {
      containerIP = getSandboxIP(sessionId);
    } catch (_) {}
  }

  // 1. Cek port di dalam container sandbox user
  if (containerIP && (await checkPortOpen(containerIP, p))) {
    return containerIP;
  }

  // 2. Cek port di host (127.0.0.1)
  if (await checkPortOpen("127.0.0.1", p)) {
    return "127.0.0.1";
  }

  // 3. Fallback: bila belum open (server baru mau booting) tapi ada sandbox, arahkan ke container
  if (containerIP) {
    return containerIP;
  }

  return "127.0.0.1";
}

async function startWebPreview(port, durationMinutes = 30, options = {}) {
  const p = Number(port);
  if (!p || p < 1 || p > 65535) {
    throw new Error("Port tidak valid (1 - 65535)");
  }

  const targetHost = await resolveTargetHost(p, options);
  const key = `${targetHost}:${p}`;

  // Jika sudah ada tunnel aktif ke targetHost & port yang sama, kembalikan URL yang sudah ada
  if (activeTunnels.has(key)) {
    const existing = activeTunnels.get(key);
    if (existing.process && !existing.process.killed) {
      return existing.url;
    }
    activeTunnels.delete(key);
  }

  // Jika port ini sebelumnya ditunnel ke targetHost lain, hentikan tunnel lama
  for (const [k, item] of Array.from(activeTunnels.entries())) {
    if (item.port === p) {
      stopWebPreview(p, item.targetHost);
    }
  }

  return new Promise((resolve, reject) => {
    const targetUrl = `http://${targetHost}:${p}`;
    console.log(`[Web Preview] Menghubungkan Cloudflare Tunnel ke ${targetUrl}...`);
    const tunnel = spawn("cloudflared", ["tunnel", "--url", targetUrl]);
    let resolved = false;

    const timeout = setTimeout(() => {
      if (!resolved) {
        try { tunnel.kill("SIGKILL"); } catch (_) {}
        reject(new Error(`Timeout menunggu link Cloudflare Tunnel (30 detik). Pastikan server web aktif di ${targetUrl}.`));
      }
    }, 30_000);

    const onData = (data) => {
      const text = data.toString();
      const match = text.match(/https:\/\/[a-zA-Z0-9-]+\.trycloudflare\.com/);
      if (match && !resolved) {
        resolved = true;
        clearTimeout(timeout);
        const urlFound = match[0];

        const timer = setTimeout(() => {
          stopWebPreview(p, targetHost);
        }, durationMinutes * 60 * 1000);

        activeTunnels.set(key, {
          process: tunnel,
          url: urlFound,
          port: p,
          targetHost,
          startedAt: Date.now(),
          timer
        });

        console.log(`[Web Preview] Tunnel aktif: ${urlFound} -> ${targetUrl} (${durationMinutes} menit)`);
        resolve(urlFound);
      }
    };

    tunnel.stdout.on("data", onData);
    tunnel.stderr.on("data", onData);

    tunnel.on("error", (err) => {
      if (!resolved) {
        clearTimeout(timeout);
        reject(err);
      }
    });

    tunnel.on("exit", () => {
      activeTunnels.delete(key);
    });
  });
}

function stopWebPreview(port, targetHost = null) {
  const p = Number(port);
  let stopped = false;
  for (const [k, item] of Array.from(activeTunnels.entries())) {
    if (item.port === p && (!targetHost || item.targetHost === targetHost)) {
      clearTimeout(item.timer);
      try {
        item.process.kill("SIGTERM");
      } catch (_) {}
      activeTunnels.delete(k);
      stopped = true;
    }
  }
  return stopped;
}

function listActivePreviews() {
  const list = [];
  for (const item of activeTunnels.values()) {
    list.push({
      port: item.port,
      targetHost: item.targetHost,
      url: item.url,
      startedAt: item.startedAt
    });
  }
  return list;
}

process.on("exit", () => {
  for (const item of activeTunnels.values()) {
    try {
      item.process.kill("SIGKILL");
    } catch (_) {}
  }
});

module.exports = {
  startWebPreview,
  stopWebPreview,
  listActivePreviews
};
