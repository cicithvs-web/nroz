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
 * Menentukan IP tujuan tunnel.
 *
 * Tool AI (start_web_preview) HANYA boleh men-tunnel ke container sandbox milik sesinya.
 * Dulu ada fallback ke 127.0.0.1 di host, sehingga "preview port 42235" bisa membuka
 * layanan internal VPS (DevTools Chrome, database, dll.) ke internet. Port di host hanya
 * boleh dibuka oleh kode bot sendiri lewat options.allowHost (misal link unduhan video).
 */
async function resolveTargetHost(port, options = {}) {
  if (options.allowHost) return "127.0.0.1";

  const sessionId = options.sessionId;
  if (!sessionId) {
    throw new Error("Web preview butuh sesi sandbox; port di server host tidak boleh dibuka.");
  }

  let containerIP = null;
  try {
    containerIP = getSandboxIP(sessionId);
  } catch (_) {}
  if (!containerIP) {
    throw new Error(
      "Container sandbox sesi ini belum berjalan. Jalankan server web-nya dulu di sandbox lewat run_command " +
      "(dengarkan di 0.0.0.0), lalu panggil start_web_preview lagi."
    );
  }

  // Server yang baru booting mungkin belum membuka port; tetap arahkan ke container sendiri.
  if (!(await checkPortOpen(containerIP, Number(port)))) {
    console.log(`[Web Preview] Port ${port} belum terbuka di container ${containerIP}, tunnel tetap diarahkan ke sana.`);
  }
  return containerIP;
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

  // Jika port ini sebelumnya ditunnel ke tujuan lain OLEH PEMILIK YANG SAMA, hentikan tunnel lama.
  // (Dulu tunnel milik sesi lain dengan nomor port sama ikut dimatikan.)
  for (const item of Array.from(activeTunnels.values())) {
    if (item.port === p && item.targetHost !== targetHost && (item.owner || null) === (options.sessionId || null)) {
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
          owner: options.sessionId || null,
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
  listActivePreviews,
  _resolveTargetHost: resolveTargetHost
};
