/**
 * webPreviewManager.js — Pengelola Cloudflare Quick Tunnel untuk Web Preview
 * Membuat link HTTPS publik instan dari server lokal/container
 */

const { spawn } = require("child_process");

const activeTunnels = new Map(); // port -> { process, url, port, startedAt, timer }

function startWebPreview(port, durationMinutes = 30) {
  return new Promise((resolve, reject) => {
    const p = Number(port);
    if (!p || p < 1 || p > 65535) {
      return reject(new Error("Port tidak valid (1 - 65535)"));
    }

    if (activeTunnels.has(p)) {
      return resolve(activeTunnels.get(p).url);
    }

    const tunnel = spawn("cloudflared", ["tunnel", "--url", `http://127.0.0.1:${p}`]);
    let resolved = false;

    const timeout = setTimeout(() => {
      if (!resolved) {
        tunnel.kill();
        reject(new Error("Timeout menunggu link Cloudflare Tunnel (15 detik). Pastikan server web aktif di port tersebut."));
      }
    }, 15_000);

    const onData = (data) => {
      const text = data.toString();
      const match = text.match(/https:\/\/[a-zA-Z0-9-]+\.trycloudflare\.com/);
      if (match && !resolved) {
        resolved = true;
        clearTimeout(timeout);
        const urlFound = match[0];

        const timer = setTimeout(() => {
          stopWebPreview(p);
        }, durationMinutes * 60 * 1000);

        activeTunnels.set(p, {
          process: tunnel,
          url: urlFound,
          port: p,
          startedAt: Date.now(),
          timer
        });

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
      activeTunnels.delete(p);
    });
  });
}

function stopWebPreview(port) {
  const p = Number(port);
  if (activeTunnels.has(p)) {
    const item = activeTunnels.get(p);
    clearTimeout(item.timer);
    try {
      item.process.kill();
    } catch (_) {}
    activeTunnels.delete(p);
    return true;
  }
  return false;
}

function listActivePreviews() {
  const list = [];
  for (const [port, item] of activeTunnels.entries()) {
    list.push({ port, url: item.url, startedAt: item.startedAt });
  }
  return list;
}

module.exports = {
  startWebPreview,
  stopWebPreview,
  listActivePreviews
};
