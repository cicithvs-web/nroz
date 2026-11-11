/**
 * desktopManager.js — Pengelola Virtual Desktop GUI (Xvfb + Fluxbox + Chromium GUI + x11vnc + noVNC)
 *
 * Menyediakan "Komputer Virtual" 1280x720 yang selalu hidup (persistent):
 *   - DISPLAY=:99 (Xvfb 1280x720x24)
 *   - Window Manager: Fluxbox
 *   - Browser GUI: Chromium dengan profil permanen (/opt/nroz/workspace/.browser-profile)
 *     dan CDP port 127.0.0.1:9222 (bisa dipakai bersama @playwright/mcp & computer_use)
 *   - Remote Live View & Control: x11vnc (127.0.0.1:5999) + websockify/noVNC (127.0.0.1:6080)
 *     yang dapat dibuka lewat Cloudflare Tunnel (/desktop).
 */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const axios = require("axios");
const { spawn, execSync, execFileSync } = require("child_process");
const { checkPortOpen, startWebPreview, stopWebPreview, listActivePreviews } = require("./webPreviewManager.js");

const DISPLAY_NUM = ":99";
const SCREEN_WIDTH = 1280;
const SCREEN_HEIGHT = 720;
const VNC_PORT = 5999;
const NOVNC_PORT = 6080;
const CDP_PORT = 9222;

const PROFILE_DIR = path.join(__dirname, "workspace", ".browser-profile");
const TOKEN_FILE = path.join(PROFILE_DIR, ".vnc_token");

let desktopInitPromise = null;
let lastDesktopActivityAt = Date.now();
const IDLE_SLEEP_MS = (Number(process.env.DESKTOP_IDLE_MINUTES) || 60) * 60 * 1000;

const childProcesses = {
  xvfb: null,
  fluxbox: null,
  x11vnc: null,
  websockify: null,
  chromium: null
};

function touchDesktopActivity() {
  lastDesktopActivityAt = Date.now();
}

function isBlankTabUrl(url) {
  const u = String(url || "").trim().toLowerCase();
  return !u || u === "about:blank" || u.startsWith("chrome://newtab") || u.startsWith("chrome://welcome");
}

/**
 * Mengambil atau membuat password VNC unik agar akses noVNC aman namun otomatis login lewat parameter URL.
 */
function getVncPassword() {
  if (process.env.DESKTOP_VNC_PASSWORD) {
    return process.env.DESKTOP_VNC_PASSWORD.trim();
  }
  try {
    if (!fs.existsSync(PROFILE_DIR)) fs.mkdirSync(PROFILE_DIR, { recursive: true });
    if (fs.existsSync(TOKEN_FILE)) {
      const saved = fs.readFileSync(TOKEN_FILE, "utf8").trim();
      if (saved) return saved;
    }
    const token = crypto.randomBytes(6).toString("hex");
    fs.writeFileSync(TOKEN_FILE, token, { mode: 0o600 });
    return token;
  } catch (_) {
    return "nrozdesktop";
  }
}

/**
 * Mencari path binary Chromium / Chrome yang terpasang di VPS.
 */
function findChromiumBinary() {
  const candidates = [];
  // 1. Cek Playwright cache di /root/.cache/ms-playwright
  const pwCache = "/root/.cache/ms-playwright";
  if (fs.existsSync(pwCache)) {
    try {
      const dirs = fs
        .readdirSync(pwCache)
        .filter((d) => d.startsWith("chromium-"))
        .sort()
        .reverse();
      for (const d of dirs) {
        const bin = path.join(pwCache, d, "chrome-linux64", "chrome");
        if (fs.existsSync(bin)) candidates.push(bin);
      }
    } catch (_) {}
  }

  // 2. Binary sistem
  candidates.push(
    "/usr/bin/google-chrome-stable",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser"
  );

  for (const bin of candidates) {
    if (fs.existsSync(bin)) return bin;
  }
  return null;
}

/**
 * Mengecek apakah Xvfb :99 sudah berjalan dan merespons.
 */
function isDisplayActive() {
  if (!fs.existsSync("/tmp/.X11-unix/X99")) return false;
  try {
    execSync(`xset -display ${DISPLAY_NUM} q >/dev/null 2>&1`, { timeout: 2000 });
    return true;
  } catch (_) {
    return false;
  }
}

/**
 * Menyiapkan konfigurasi Fluxbox minimalis agar jendela aplikasi tampil bersih & maksimal.
 */
function ensureFluxboxConfig() {
  const fbDir = "/root/.fluxbox";
  if (!fs.existsSync(fbDir)) fs.mkdirSync(fbDir, { recursive: true });
  const initPath = path.join(fbDir, "init");
  if (!fs.existsSync(initPath)) {
    fs.writeFileSync(
      initPath,
      [
        "session.screen0.toolbar.visible:\tfalse",
        "session.screen0.slit.autoHide:\ttrue",
        "session.screen0.focusModel:\tClickToFocus",
        "session.screen0.windowPlacement:\tRowSmartPlacement",
        "session.screen0. workspaces:\t1"
      ].join("\n") + "\n"
    );
  }
}

/**
 * Membersihkan file lock Chromium jika prosesnya sudah mati (mencegah error "profile in use").
 */
function cleanStaleChromiumLocks() {
  if (!fs.existsSync(PROFILE_DIR)) {
    fs.mkdirSync(PROFILE_DIR, { recursive: true });
    return;
  }
  for (const lockName of ["SingletonLock", "SingletonCookie", "SingletonSocket"]) {
    const p = path.join(PROFILE_DIR, lockName);
    try {
      if (fs.lstatSync(p).isSymbolicLink() || fs.existsSync(p)) {
        fs.unlinkSync(p);
      }
    } catch (_) {}
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Memastikan seluruh layanan Virtual Desktop (Xvfb, Fluxbox, Chromium GUI, x11vnc, websockify) aktif.
 */
async function ensureDesktopServices({ startBrowser = true } = {}) {
  touchDesktopActivity();
  if (desktopInitPromise) {
    return desktopInitPromise;
  }

  desktopInitPromise = (async () => {
    try {
      // 1. Xvfb :99
      if (!isDisplayActive()) {
        try {
          if (fs.existsSync("/tmp/.X99-lock")) fs.unlinkSync("/tmp/.X99-lock");
        } catch (_) {}
        console.log(`[Desktop] Menyalakan Xvfb ${DISPLAY_NUM} (${SCREEN_WIDTH}x${SCREEN_HEIGHT}x24)...`);
        const xvfb = spawn(
          "Xvfb",
          [
            DISPLAY_NUM,
            "-screen",
            "0",
            `${SCREEN_WIDTH}x${SCREEN_HEIGHT}x24`,
            "-ac",
            "+extension",
            "GLX",
            "+render",
            "-noreset"
          ],
          { stdio: "ignore", detached: true }
        );
        xvfb.unref();
        childProcesses.xvfb = xvfb;

        for (let i = 0; i < 20; i++) {
          if (isDisplayActive()) break;
          await sleep(150);
        }
      }

      // 2. Fluxbox Window Manager
      ensureFluxboxConfig();
      let fluxboxRunning = false;
      try {
        const pgrep = execSync("pgrep -f 'fluxbox'", { encoding: "utf8" }).trim();
        fluxboxRunning = Boolean(pgrep);
      } catch (_) {}
      if (!fluxboxRunning) {
        const fb = spawn("fluxbox", ["-display", DISPLAY_NUM], {
          env: { ...process.env, DISPLAY: DISPLAY_NUM },
          stdio: "ignore",
          detached: true
        });
        fb.unref();
        childProcesses.fluxbox = fb;
        await sleep(300);
      }

      // 3. x11vnc di 127.0.0.1:5999
      if (!(await checkPortOpen("127.0.0.1", VNC_PORT))) {
        const passwd = getVncPassword();
        console.log(`[Desktop] Menyalakan x11vnc di 127.0.0.1:${VNC_PORT}...`);
        const vnc = spawn(
          "x11vnc",
          [
            "-display",
            DISPLAY_NUM,
            "-forever",
            "-shared",
            "-rfbport",
            String(VNC_PORT),
            "-localhost",
            "-passwd",
            passwd,
            "-noxdamage",
            "-quiet"
          ],
          { stdio: "ignore", detached: true }
        );
        vnc.unref();
        childProcesses.x11vnc = vnc;
        for (let i = 0; i < 15; i++) {
          if (await checkPortOpen("127.0.0.1", VNC_PORT)) break;
          await sleep(150);
        }
      }

      // 4. Websockify + noVNC di 127.0.0.1:6080
      if (!(await checkPortOpen("127.0.0.1", NOVNC_PORT))) {
        console.log(`[Desktop] Menyalakan noVNC websockify di 127.0.0.1:${NOVNC_PORT}...`);
        const ws = spawn(
          "websockify",
          ["--web", "/usr/share/novnc/", `127.0.0.1:${NOVNC_PORT}`, `127.0.0.1:${VNC_PORT}`],
          { stdio: "ignore", detached: true }
        );
        ws.unref();
        childProcesses.websockify = ws;
        for (let i = 0; i < 15; i++) {
          if (await checkPortOpen("127.0.0.1", NOVNC_PORT)) break;
          await sleep(150);
        }
      }

      // 5. Chromium GUI dengan Persistent Profile & CDP Port 9222
      if (startBrowser && !(await checkPortOpen("127.0.0.1", CDP_PORT))) {
        const chromeBin = findChromiumBinary();
        if (chromeBin) {
          cleanStaleChromiumLocks();
          console.log(`[Desktop] Menyalakan Chromium GUI di ${DISPLAY_NUM} (CDP 127.0.0.1:${CDP_PORT})...`);
          const chrome = spawn(
            chromeBin,
            [
              "--no-sandbox",
              "--disable-setuid-sandbox",
              "--disable-dev-shm-usage",
              "--disable-gpu",
              "--no-first-run",
              "--no-default-browser-check",
              "--disable-infobars",
              "--disable-blink-features=AutomationControlled",
              "--password-store=basic",
              "--renderer-process-limit=4",
              "--js-flags=--max-old-space-size=512",
              "--restore-last-session",
              `--user-data-dir=${PROFILE_DIR}`,
              `--remote-debugging-port=${CDP_PORT}`,
              "--remote-debugging-address=127.0.0.1",
              "--window-position=0,0",
              `--window-size=${SCREEN_WIDTH},${SCREEN_HEIGHT}`,
              "--start-maximized",
              "about:blank"
            ],
            {
              env: { ...process.env, DISPLAY: DISPLAY_NUM },
              stdio: "ignore",
              detached: true
            }
          );
          chrome.unref();
          childProcesses.chromium = chrome;

          for (let i = 0; i < 25; i++) {
            if (await checkPortOpen("127.0.0.1", CDP_PORT)) break;
            await sleep(200);
          }
        }
      }

      return {
        ok: true,
        display: DISPLAY_NUM,
        resolution: `${SCREEN_WIDTH}x${SCREEN_HEIGHT}`,
        vncPort: VNC_PORT,
        novncPort: NOVNC_PORT,
        cdpPort: CDP_PORT
      };
    } finally {
      desktopInitPromise = null;
    }
  })();

  return desktopInitPromise;
}

/**
 * Mengembalikan URL Cloudflare Tunnel untuk Live Desktop jika sedang aktif, atau null.
 */
function getActiveDesktopTunnelUrl() {
  const tunnels = listActivePreviews();
  const hit = tunnels.find((t) => Number(t.port) === NOVNC_PORT && t.targetHost === "127.0.0.1");
  if (!hit || !hit.url) return null;
  const passwd = getVncPassword();
  return `${hit.url}/vnc.html?autoconnect=true&resize=scale&password=${encodeURIComponent(passwd)}`;
}

/**
 * Menyalakan layanan desktop + membuka Cloudflare Tunnel ke noVNC.
 */
async function startDesktopTunnel(durationMinutes = 120) {
  await ensureDesktopServices({ startBrowser: true });
  const baseUrl = await startWebPreview(NOVNC_PORT, durationMinutes, {
    allowHost: true,
    sessionId: "desktop"
  });
  const passwd = getVncPassword();
  const fullUrl = `${baseUrl}/vnc.html?autoconnect=true&resize=scale&password=${encodeURIComponent(passwd)}`;
  return {
    url: fullUrl,
    baseUrl,
    password: passwd,
    resolution: `${SCREEN_WIDTH}x${SCREEN_HEIGHT}`,
    durationMinutes
  };
}

/**
 * Menutup tunnel publik Live Desktop (layar & browser tetap hidup di background).
 */
function stopDesktopTunnel() {
  return stopWebPreview(NOVNC_PORT, "127.0.0.1");
}

/**
 * Membaca koordinat kursor mouse saat ini di DISPLAY=:99.
 */
function getMouseLocation() {
  try {
    const out = execSync(`DISPLAY=${DISPLAY_NUM} xdotool getmouselocation --shell`, {
      encoding: "utf8",
      timeout: 2000
    });
    const xMatch = out.match(/^X=(\d+)/m);
    const yMatch = out.match(/^Y=(\d+)/m);
    return {
      x: xMatch ? Number(xMatch[1]) : Math.round(SCREEN_WIDTH / 2),
      y: yMatch ? Number(yMatch[1]) : Math.round(SCREEN_HEIGHT / 2)
    };
  } catch (_) {
    return { x: Math.round(SCREEN_WIDTH / 2), y: Math.round(SCREEN_HEIGHT / 2) };
  }
}

/**
 * Mengambil screenshot layar desktop (1280x720) beserta versi ber-grid koordinat untuk analisis Vision AI.
 */
async function captureDesktopScreenshot({ withGrid = true, saveToPath = null } = {}) {
  await ensureDesktopServices({ startBrowser: true });
  const rawPath = "/tmp/nroz_desktop_raw.png";
  const gridPath = "/tmp/nroz_desktop_grid.png";

  try {
    execSync(`DISPLAY=${DISPLAY_NUM} scrot -o "${rawPath}"`, { timeout: 5000 });
  } catch (_) {
    execSync(`DISPLAY=${DISPLAY_NUM} import -window root "${rawPath}"`, { timeout: 5000 });
  }

  if (saveToPath) {
    try {
      const dir = path.dirname(saveToPath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.copyFileSync(rawPath, saveToPath);
    } catch (_) {}
  }

  const mouse = getMouseLocation();

  if (withGrid) {
    const pyScript = `
import sys
from PIL import Image, ImageDraw

raw_path, grid_path, mx, my = sys.argv[1], sys.argv[2], int(sys.argv[3]), int(sys.argv[4])
img = Image.open(raw_path).convert("RGBA")
w, h = img.size
overlay = Image.new("RGBA", (w, h), (0, 0, 0, 0))
draw = ImageDraw.Draw(overlay)

# Garis grid tiap 100px
for x in range(100, w, 100):
    draw.line([(x, 0), (x, h)], fill=(0, 180, 255, 65), width=1)
    draw.rectangle([(x - 18, 2), (x + 18, 16)], fill=(0, 0, 0, 175))
    draw.text((x - 14, 3), str(x), fill=(255, 255, 0, 255))

for y in range(100, h, 100):
    draw.line([(0, y), (w, y)], fill=(0, 180, 255, 65), width=1)
    draw.rectangle([(2, y - 7), (32, y + 7)], fill=(0, 0, 0, 175))
    draw.text((4, y - 6), str(y), fill=(255, 255, 0, 255))

# Titik silang kecil tiap 100x100
for x in range(100, w, 100):
    for y in range(100, h, 100):
        draw.ellipse([(x - 2, y - 2), (x + 2, y + 2)], fill=(255, 80, 80, 160))

# Gambar posisi kursor aktif (lingkaran merah terang)
draw.ellipse([(mx - 8, my - 8), (mx + 8, my + 8)], outline=(255, 30, 30, 240), width=2)
draw.ellipse([(mx - 2, my - 2), (mx + 2, my + 2)], fill=(255, 30, 30, 255))

out = Image.alpha_composite(img, overlay).convert("RGB")
out.save(grid_path, "PNG")
`;
    try {
      execFileSync("python3", ["-c", pyScript, rawPath, gridPath, String(mouse.x), String(mouse.y)], {
        timeout: 5000
      });
    } catch (_) {
      fs.copyFileSync(rawPath, gridPath);
    }
  } else {
    fs.copyFileSync(rawPath, gridPath);
  }

  const rawBuf = fs.readFileSync(rawPath);
  const gridBuf = fs.readFileSync(gridPath);

  return {
    rawPath: saveToPath || rawPath,
    gridPath,
    rawBuffer: rawBuf,
    gridBuffer: gridBuf,
    rawBase64: rawBuf.toString("base64"),
    gridBase64: gridBuf.toString("base64"),
    mouseX: mouse.x,
    mouseY: mouse.y,
    width: SCREEN_WIDTH,
    height: SCREEN_HEIGHT
  };
}

/**
 * Mengambil daftar tab Chromium yang terbuka lewat CDP (127.0.0.1:9222).
 */
async function listBrowserTabs() {
  try {
    const res = await axios.get(`http://127.0.0.1:${CDP_PORT}/json/list`, { timeout: 2500 });
    if (!Array.isArray(res.data)) return [];
    return res.data
      .filter((t) => t.type === "page" && !String(t.url || "").startsWith("devtools://"))
      .map((t, idx) => ({
        index: idx + 1,
        id: t.id,
        title: t.title || "(Tanpa Judul)",
        url: t.url || "",
        webSocketDebuggerUrl: t.webSocketDebuggerUrl
      }));
  } catch (_) {
    return [];
  }
}

/**
 * Membuka URL di Chromium GUI (bisa di tab aktif atau tab baru).
 */
async function openBrowserUrl(targetUrl, { newTab = false } = {}) {
  await ensureDesktopServices({ startBrowser: true });
  let url = String(targetUrl || "").trim();
  if (!/^https?:\/\//i.test(url) && !url.startsWith("about:") && !url.startsWith("file://")) {
    url = `https://${url}`;
  }

  const tabs = await listBrowserTabs();

  // Jika diminta buka tab baru atau belum ada tab sama sekali, gunakan PUT /json/new
  if (newTab || tabs.length === 0) {
    try {
      const res = await axios.put(`http://127.0.0.1:${CDP_PORT}/json/new?${encodeURIComponent(url)}`, null, {
        timeout: 4000
      });
      if (res.data && res.data.id) {
        await axios.get(`http://127.0.0.1:${CDP_PORT}/json/activate/${res.data.id}`, { timeout: 2000 }).catch(() => {});
      }
      // Jika tab pertama sebelumnya cuma about:blank, tutup supaya rapi
      if (tabs.length === 1 && tabs[0].url === "about:blank") {
        await axios.get(`http://127.0.0.1:${CDP_PORT}/json/close/${tabs[0].id}`, { timeout: 2000 }).catch(() => {});
      }
      return { ok: true, url, tabCount: (await listBrowserTabs()).length };
    } catch (_) {}
  }

  // Navigasi di tab pertama/aktif via PUT /json/new lalu tutup tab lama jika about:blank, atau lewat xdotool Ctrl+L
  try {
    const res = await axios.put(`http://127.0.0.1:${CDP_PORT}/json/new?${encodeURIComponent(url)}`, null, {
      timeout: 4000
    });
    if (res.data && res.data.id) {
      await axios.get(`http://127.0.0.1:${CDP_PORT}/json/activate/${res.data.id}`, { timeout: 2000 }).catch(() => {});
      if (!newTab && tabs.length > 0) {
        await axios.get(`http://127.0.0.1:${CDP_PORT}/json/close/${tabs[0].id}`, { timeout: 2000 }).catch(() => {});
      }
      return { ok: true, url, tabCount: (await listBrowserTabs()).length };
    }
  } catch (_) {}

  // Fallback via keyboard shortcut Ctrl+L
  execFileSync("xdotool", ["key", "--clearmodifiers", "ctrl+l"], {
    env: { ...process.env, DISPLAY: DISPLAY_NUM },
    timeout: 3000
  });
  await sleep(150);
  execFileSync("xdotool", ["type", "--clearmodifiers", "--delay", "15", "--", url], {
    env: { ...process.env, DISPLAY: DISPLAY_NUM },
    timeout: 5000
  });
  execFileSync("xdotool", ["key", "--clearmodifiers", "Return"], {
    env: { ...process.env, DISPLAY: DISPLAY_NUM },
    timeout: 3000
  });
  return { ok: true, url, tabCount: (await listBrowserTabs()).length };
}

/**
 * Mengaktifkan tab berdasarkan nomor urut (1-based) atau ID tab.
 */
async function activateBrowserTab(target) {
  const tabs = await listBrowserTabs();
  if (tabs.length === 0) return { ok: false, error: "Tidak ada tab browser yang terbuka." };
  const idx = Number(target);
  const found =
    Number.isInteger(idx) && idx >= 1 && idx <= tabs.length
      ? tabs[idx - 1]
      : tabs.find((t) => t.id === String(target) || t.url.includes(String(target)) || t.title.includes(String(target)));
  if (!found) {
    return { ok: false, error: `Tab '${target}' tidak ditemukan (total ${tabs.length} tab).` };
  }
  await axios.get(`http://127.0.0.1:${CDP_PORT}/json/activate/${found.id}`, { timeout: 2500 });
  return { ok: true, tab: found, tabs };
}

/**
 * Menutup tab berdasarkan nomor urut (1-based) atau ID tab.
 */
async function closeBrowserTab(target) {
  const tabs = await listBrowserTabs();
  if (tabs.length === 0) return { ok: false, error: "Tidak ada tab browser yang terbuka." };
  const idx = Number(target);
  const found =
    Number.isInteger(idx) && idx >= 1 && idx <= tabs.length
      ? tabs[idx - 1]
      : tabs.find((t) => t.id === String(target)) || tabs[0];
  await axios.get(`http://127.0.0.1:${CDP_PORT}/json/close/${found.id}`, { timeout: 2500 });
  return { ok: true, closed: found, remaining: (await listBrowserTabs()).length };
}

/**
 * Mencari koordinat layar (X, Y) dari elemen web (tombol, link, input) berdasarkan teks/labelnya via CDP WebSocket.
 */
async function findElementByTextViaCDP(searchText) {
  touchDesktopActivity();
  const query = String(searchText || "").trim();
  if (!query) return { found: false, error: "Teks pencarian kosong." };

  const tabs = await listBrowserTabs();
  if (tabs.length === 0 || !tabs[0].webSocketDebuggerUrl) {
    return { found: false, error: "Tidak ada tab browser aktif yang bisa diperiksa." };
  }

  const wsUrl = tabs[0].webSocketDebuggerUrl;
  const expression = `(() => {
    const q = ${JSON.stringify(query.toLowerCase())};
    const isVisible = (el) => {
      if (!el || !el.getBoundingClientRect) return false;
      const style = window.getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) return false;
      const r = el.getBoundingClientRect();
      return r.width > 2 && r.height > 2;
    };
    const getText = (el) => {
      return [
        el.innerText,
        el.value,
        el.getAttribute && el.getAttribute('placeholder'),
        el.getAttribute && el.getAttribute('aria-label'),
        el.getAttribute && el.getAttribute('title'),
        el.getAttribute && el.getAttribute('name'),
        el.id
      ].filter(Boolean).map((s) => String(s).trim()).join(' | ');
    };
    const selectors = 'button, a, input, textarea, select, [role="button"], [role="link"], [role="tab"], [role="menuitem"], label, summary, h1, h2, h3, span, div';
    const all = Array.from(document.querySelectorAll(selectors)).filter(isVisible);
    let best = null;
    let bestScore = -1;
    for (const el of all) {
      const raw = (el.innerText || el.value || el.getAttribute('placeholder') || el.getAttribute('aria-label') || el.getAttribute('title') || '').trim();
      const low = raw.toLowerCase();
      if (!low) continue;
      let score = -1;
      if (low === q) score = 100;
      else if (low.startsWith(q)) score = 80 - Math.min(30, low.length - q.length);
      else if (low.includes(q)) score = 60 - Math.min(40, low.length - q.length);
      if (score > 0) {
        const tag = el.tagName.toLowerCase();
        if (['button', 'a', 'input', 'textarea', 'select', 'label'].includes(tag) || el.getAttribute('role') === 'button') {
          score += 15;
        }
        if (score > bestScore) {
          bestScore = score;
          best = el;
        }
      }
    }
    if (!best) return { found: false };
    best.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
    const rect = best.getBoundingClientRect();
    const chromeTopOffset = Math.max(0, window.outerHeight - window.innerHeight);
    const chromeLeftOffset = Math.max(0, window.outerWidth - window.innerWidth);
    const screenX = Math.round((window.screenX || 0) + chromeLeftOffset + rect.left + rect.width / 2);
    const screenY = Math.round((window.screenY || 0) + chromeTopOffset + rect.top + rect.height / 2);
    return {
      found: true,
      x: screenX,
      y: screenY,
      tag: best.tagName.toLowerCase(),
      matchedText: getText(best).slice(0, 100)
    };
  })()`;

  return new Promise((resolve) => {
    let settled = false;
    const finish = (val) => {
      if (!settled) {
        settled = true;
        resolve(val);
      }
    };
    const timer = setTimeout(() => finish({ found: false, error: "Timeout menghubungi CDP tab." }), 4000);
    try {
      const ws = new WebSocket(wsUrl);
      ws.onopen = () => {
        ws.send(
          JSON.stringify({
            id: 1,
            method: "Runtime.evaluate",
            params: { expression, returnByValue: true, awaitPromise: true }
          })
        );
      };
      ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(String(event.data));
          if (msg.id === 1) {
            clearTimeout(timer);
            try { ws.close(); } catch (_) {}
            const val = msg.result?.result?.value;
            finish(val && typeof val === "object" ? val : { found: false, error: "Elemen tidak ditemukan." });
          }
        } catch (err) {
          clearTimeout(timer);
          try { ws.close(); } catch (_) {}
          finish({ found: false, error: err.message });
        }
      };
      ws.onerror = (err) => {
        clearTimeout(timer);
        finish({ found: false, error: err?.message || "WebSocket error" });
      };
    } catch (err) {
      clearTimeout(timer);
      finish({ found: false, error: err.message });
    }
  });
}

/**
 * Smart Sleep (Opsi 5C):
 * Memeriksa tiap 10 menit. Jika idle > 60 menit DAN tidak ada tunnel /desktop aktif:
 * - Jika ada minimal 1 website terbuka di tab (bukan about:blank) -> DILARANG TIDUR (tetap nyala 24 jam).
 * - Hanya jika semua tab kosong (about:blank) -> istirahatkan proses Chromium untuk hemat RAM.
 */
async function checkSmartSleep() {
  try {
    if (Date.now() - lastDesktopActivityAt < IDLE_SLEEP_MS) return;
    if (getActiveDesktopTunnelUrl()) return;
    if (!(await checkPortOpen("127.0.0.1", CDP_PORT))) return;

    const tabs = await listBrowserTabs();
    const hasActiveWeb = tabs.some((t) => !isBlankTabUrl(t.url));
    if (hasActiveWeb) {
      // Ada website terbuka -> jangan pernah matikan browser
      return;
    }

    console.log("[Desktop Smart-Sleep] Browser hanya membuka tab kosong (about:blank) & idle >60m; mengistirahatkan Chromium untuk hemat RAM...");
    try {
      execSync("pkill -TERM -f 'remote-debugging-port=9222' 2>/dev/null || true");
    } catch (_) {}
  } catch (_) {}
}

setInterval(checkSmartSleep, 10 * 60 * 1000).unref();

/**
 * Status ringkas layanan Virtual Desktop.
 */
async function getDesktopStatus() {
  const displayUp = isDisplayActive();
  const vncUp = await checkPortOpen("127.0.0.1", VNC_PORT);
  const novncUp = await checkPortOpen("127.0.0.1", NOVNC_PORT);
  const browserUp = await checkPortOpen("127.0.0.1", CDP_PORT);
  const tunnelUrl = getActiveDesktopTunnelUrl();
  const tabs = browserUp ? await listBrowserTabs() : [];
  return {
    displayUp,
    vncUp,
    novncUp,
    browserUp,
    tunnelUrl,
    resolution: `${SCREEN_WIDTH}x${SCREEN_HEIGHT}`,
    tabs
  };
}

module.exports = {
  DISPLAY_NUM,
  SCREEN_WIDTH,
  SCREEN_HEIGHT,
  VNC_PORT,
  NOVNC_PORT,
  CDP_PORT,
  PROFILE_DIR,
  ensureDesktopServices,
  startDesktopTunnel,
  stopDesktopTunnel,
  getActiveDesktopTunnelUrl,
  captureDesktopScreenshot,
  getMouseLocation,
  listBrowserTabs,
  openBrowserUrl,
  activateBrowserTab,
  closeBrowserTab,
  findElementByTextViaCDP,
  touchDesktopActivity,
  checkSmartSleep,
  getDesktopStatus
};
