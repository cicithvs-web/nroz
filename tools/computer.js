/**
 * tools/computer.js — Tool computer_use: Kontrol Komputer Virtual GUI (1280x720)
 *
 * Memberikan kemampuan "Computer Use" (ala Claude Computer Use / OpenAI Operator):
 *   - Menyalakan & membagikan link Live Web Desktop (noVNC via Cloudflare Tunnel)
 *   - Melihat layar penuh 1280x720 dengan penggaris koordinat (Vision Grid)
 *   - Menggerakkan mouse, klik kiri/kanan/ganda, drag & drop, scroll di koordinat (x, y)
 *   - Mengetik teks dan menekan shortcut keyboard (Ctrl+T, Ctrl+W, Tab, Return, dll)
 *   - Membuka URL & berpindah antar-tab di Browser Chromium GUI (profil permanen)
 */

const { execFileSync } = require("child_process");
const ctx = require("../bot/context");
const {
  DISPLAY_NUM,
  SCREEN_WIDTH,
  SCREEN_HEIGHT,
  ensureDesktopServices,
  startDesktopTunnel,
  stopDesktopTunnel,
  getActiveDesktopTunnelUrl,
  captureDesktopScreenshot,
  listBrowserTabs,
  openBrowserUrl,
  activateBrowserTab,
  closeBrowserTab,
  findElementByTextViaCDP,
  getDesktopStatus
} = require("../desktopManager.js");
const { analyzeScreenshotWithVision } = require("../mcpManager.js");

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function clampCoord(val, max) {
  const n = Math.round(Number(val));
  if (!Number.isFinite(n)) return null;
  return Math.max(0, Math.min(max, n));
}

function runXdotool(args, timeout = 5000) {
  return execFileSync("xdotool", args, {
    env: { ...process.env, DISPLAY: DISPLAY_NUM },
    timeout,
    encoding: "utf8"
  });
}

/**
 * Mengetik teks dengan aman & cepat:
 * Jika teks panjang (>12 karakter) atau mengandung simbol khusus/non-ASCII (seperti password, URL, email),
 * salin ke clipboard X11 (xclip) lalu paste dengan Ctrl+V agar 100% akurat & instan (fallback ke xdotool type).
 */
function typeTextSafe(text) {
  const str = String(text ?? "");
  if (!str) return;
  const needsClipboard = str.length > 12 || /[^a-zA-Z0-9 .,_-]/.test(str);
  if (needsClipboard) {
    try {
      execFileSync("xclip", ["-selection", "clipboard"], {
        env: { ...process.env, DISPLAY: DISPLAY_NUM },
        input: str,
        timeout: 3000
      });
      runXdotool(["key", "--clearmodifiers", "ctrl+v"]);
      return;
    } catch (_) {
      // Fallback ke xdotool type jika xclip gagal
    }
  }
  runXdotool(["type", "--clearmodifiers", "--delay", "20", "--", str], 15000);
}

/**
 * Mengambil screenshot layar komputer, mengirim ke Telegram (opsional), dan menjalankan analisis Vision ber-grid.
 */
async function captureAndInspect({
  caption,
  sendToChat = false,
  analyzeVisual = true,
  visualFocus = "",
  context = {}
}) {
  const shot = await captureDesktopScreenshot({ withGrid: true });
  const tabs = await listBrowserTabs();
  const activeTabInfo =
    tabs.length > 0
      ? `\n🌐 Tab Browser Terbuka (${tabs.length}):\n` +
        tabs
          .slice(0, 8)
          .map((t) => `  ${t.index}. ${t.title} — ${t.url}`)
          .join("\n")
      : "";

  if (sendToChat && context.chatId && ctx.bot) {
    try {
      const sendOpts = { caption: (caption || "🖥️ Tampilan Layar Komputer Virtual (1280x720)").slice(0, 1000) };
      if (context.threadId) sendOpts.message_thread_id = context.threadId;
      await ctx.bot.sendPhoto(context.chatId, shot.rawBuffer, sendOpts, {
        filename: "virtual_desktop.png",
        contentType: "image/png"
      });
      if (typeof context.onMediaSent === "function") context.onMediaSent("photo");
    } catch (err) {
      console.warn("[ComputerUse] Gagal kirim foto layar ke Telegram:", err.message);
    }
  }

  let visionNote = "";
  if (analyzeVisual) {
    const focusPrompt =
      (visualFocus ? `${visualFocus}. ` : "") +
      "Perhatikan angka penggaris koordinat (X di atas: 100..1200, Y di kiri: 100..700) dan sebutkan koordinat (x, y) tombol/input penting yang terlihat di layar.";
    const report = await analyzeScreenshotWithVision(shot.gridBase64, "image/png", context, {
      analyze_visual: true,
      visual_focus: focusPrompt
    });
    if (report) {
      visionNote = `\n\n👁️ [Analisis Visual Layar & Koordinat (1280x720)]:\n${report}`;
    }
  }

  return (
    `📍 Posisi kursor saat ini: (${shot.mouseX}, ${shot.mouseY}) pada layar ${SCREEN_WIDTH}x${SCREEN_HEIGHT}.` +
    activeTabInfo +
    visionNote
  );
}

/**
 * Tool: computer_use
 */
async function toolComputerUse(args = {}) {
  const action = String(args.action || "").trim().toLowerCase();
  if (!action) {
    return "❌ Parameter 'action' wajib diisi (start_desktop, screenshot, open_url, click, double_click, right_click, move, drag, scroll, type, key, list_tabs, switch_tab, close_tab, wait, stop_desktop).";
  }

  const context = {
    sessionId: args.sessionId,
    chatId: args.chatId,
    threadId: args.threadId,
    client: args.client,
    model: args.model,
    onMediaSent: args.onMediaSent
  };

  try {
    await ensureDesktopServices({ startBrowser: true });

    // 1. start_desktop / get_desktop_link / status
    if (action === "start_desktop" || action === "get_desktop_link" || action === "status") {
      const duration = Math.min(Math.max(Number(args.duration_minutes) || 120, 5), 1440);
      const tunnel = await startDesktopTunnel(duration);
      const status = await getDesktopStatus();
      const tabLines =
        status.tabs.length > 0
          ? status.tabs.map((t) => `  ${t.index}. ${t.title} (${t.url})`).join("\n")
          : "  (Belum ada halaman dibuka)";

      return (
        `🖥️ **Komputer Virtual GUI Aktif!**\n` +
        `• Resolusi Layar: \`${status.resolution}\` (Display \`${DISPLAY_NUM}\`)\n` +
        `• 🔗 **Link Live Desktop (Buka di HP/Laptop)**:\n${tunnel.url}\n` +
        `• Durasi Link: ${duration} menit (otomatis login tanpa ketik password)\n` +
        `• Tab Browser Aktif (${status.tabs.length}):\n${tabLines}\n\n` +
        `💡 User bisa membuka link di atas untuk menonton secara live atau ikut mengklik/mengetik langsung di layar komputer bersama AI.`
      );
    }

    // 2. stop_desktop
    if (action === "stop_desktop") {
      const stopped = stopDesktopTunnel();
      return stopped
        ? "🛑 Link publik Cloudflare Tunnel untuk Live Desktop telah ditutup (komputer & browser tetap hidup di latar belakang)."
        : "ℹ️ Tidak ada link tunnel Live Desktop yang sedang terbuka.";
    }

    // 3. screenshot
    if (action === "screenshot") {
      const sendToChat = args.send_to_chat !== false;
      const info = await captureAndInspect({
        caption: args.caption || "🖥️ Tampilan Layar Komputer Virtual",
        sendToChat,
        analyzeVisual: args.analyze_visual !== false,
        visualFocus: args.visual_focus || "",
        context
      });
      const tunnelUrl = getActiveDesktopTunnelUrl();
      return (
        `📸 Screenshot layar komputer berhasil diambil${sendToChat ? " dan dikirim ke Telegram" : ""}.\n` +
        (tunnelUrl ? `🔗 Link Live Desktop: ${tunnelUrl}\n` : "") +
        info
      );
    }

    // 4. open_url
    if (action === "open_url") {
      if (!args.url) return "❌ Parameter 'url' wajib diisi untuk action='open_url'.";
      const res = await openBrowserUrl(args.url, { newTab: Boolean(args.new_tab) });
      await sleep(1800);
      const info = await captureAndInspect({
        caption: `🌐 Membuka ${res.url}`,
        sendToChat: Boolean(args.send_to_chat),
        analyzeVisual: args.analyze_visual !== false,
        visualFocus: args.visual_focus || `Halaman ${res.url} baru dibuka`,
        context
      });
      return `✅ Berhasil membuka URL di Chromium GUI: ${res.url} (total ${res.tabCount} tab).\n${info}`;
    }

    // 5. list_tabs
    if (action === "list_tabs") {
      const tabs = await listBrowserTabs();
      if (tabs.length === 0) return "ℹ️ Belum ada tab browser yang terbuka.";
      return (
        `🌐 Daftar Tab Browser Terbuka (${tabs.length}):\n` +
        tabs.map((t) => `${t.index}. **${t.title}**\n   URL: ${t.url} (id: ${t.id})`).join("\n")
      );
    }

    // 6. switch_tab
    if (action === "switch_tab") {
      const target = args.tab ?? args.index ?? args.url;
      if (target === undefined || target === null) {
        return "❌ Parameter 'tab' (nomor urut tab 1, 2, ... atau kata kunci judul/URL) wajib diisi untuk switch_tab.";
      }
      const res = await activateBrowserTab(target);
      if (!res.ok) return `❌ ${res.error}`;
      await sleep(500);
      const info = await captureAndInspect({
        sendToChat: Boolean(args.send_to_chat),
        analyzeVisual: args.analyze_visual !== false,
        context
      });
      return `✅ Berpindah ke tab #${res.tab.index}: "${res.tab.title}" (${res.tab.url}).\n${info}`;
    }

    // 7. close_tab
    if (action === "close_tab") {
      const target = args.tab ?? args.index ?? 1;
      const res = await closeBrowserTab(target);
      if (!res.ok) return `❌ ${res.error}`;
      await sleep(400);
      return `✅ Tab "${res.closed.title}" (${res.closed.url}) ditutup. Sisa ${res.remaining} tab.`;
    }

    // 7b. click_text (klik otomatis elemen berdasarkan teks tombol/link/placeholder via CDP)
    if (action === "click_text") {
      const targetText = String(args.target_text || args.label || args.text || "").trim();
      if (!targetText) {
        return "❌ Parameter 'target_text' (atau 'text') wajib diisi untuk action='click_text' (contoh: 'Sign in', 'Kirim Kode', 'Email').";
      }
      const found = await findElementByTextViaCDP(targetText);
      if (!found || !found.found) {
        return `❌ Elemen dengan teks/label "${targetText}" tidak ditemukan di tab aktif (${found?.error || "coba gunakan screenshot + click koordinat (x,y)"}).`;
      }
      const x = clampCoord(found.x, SCREEN_WIDTH);
      const y = clampCoord(found.y, SCREEN_HEIGHT);
      runXdotool(["mousemove", String(x), String(y), "click", "1"]);

      let extraDesc = "";
      const inputToType = args.input_text !== undefined ? String(args.input_text) : "";
      if (inputToType.length > 0) {
        await sleep(180);
        if (args.clear_first) {
          runXdotool(["key", "--clearmodifiers", "ctrl+a", "BackSpace"]);
          await sleep(80);
        }
        typeTextSafe(inputToType);
        extraDesc += `, lalu mengetik "${inputToType.slice(0, 40)}"`;
      }
      if (args.press_enter) {
        await sleep(120);
        runXdotool(["key", "--clearmodifiers", "Return"]);
        extraDesc += ", lalu menekan Enter";
      }

      await sleep(700);
      const info = await captureAndInspect({
        sendToChat: Boolean(args.send_to_chat),
        analyzeVisual: args.analyze_visual !== false,
        visualFocus: args.visual_focus || `Hasil setelah click_text "${targetText}" di (${x}, ${y})`,
        context
      });
      return `✅ Berhasil menemukan & mengklik elemen <${found.tag}> "${found.matchedText}" di koordinat (${x}, ${y})${extraDesc}.\n${info}`;
    }

    // 8. click / double_click / right_click / move
    if (["click", "double_click", "right_click", "move"].includes(action)) {
      const x = clampCoord(args.x, SCREEN_WIDTH);
      const y = clampCoord(args.y, SCREEN_HEIGHT);
      if (x === null || y === null) {
        return `❌ Parameter koordinat 'x' (0..${SCREEN_WIDTH}) dan 'y' (0..${SCREEN_HEIGHT}) wajib berupa angka untuk action='${action}'.`;
      }

      if (action === "move") {
        runXdotool(["mousemove", String(x), String(y)]);
        return `✅ Kursor mouse dipindahkan ke (${x}, ${y}).`;
      }

      if (action === "click") {
        runXdotool(["mousemove", String(x), String(y), "click", "1"]);
      } else if (action === "double_click") {
        runXdotool(["mousemove", String(x), String(y), "click", "--repeat", "2", "--delay", "80", "1"]);
      } else if (action === "right_click") {
        runXdotool(["mousemove", String(x), String(y), "click", "3"]);
      }

      // Kombo praktis: klik kotak input lalu langsung ketik teks & tekan Enter dalam 1 langkah
      let extraDesc = "";
      if (typeof args.text === "string" && args.text.length > 0) {
        await sleep(180);
        if (args.clear_first) {
          runXdotool(["key", "--clearmodifiers", "ctrl+a", "BackSpace"]);
          await sleep(80);
        }
        typeTextSafe(args.text);
        extraDesc += `, mengetik "${args.text.slice(0, 40)}"`;
      }
      if (args.press_enter) {
        await sleep(120);
        runXdotool(["key", "--clearmodifiers", "Return"]);
        extraDesc += ", lalu menekan Enter";
      }

      if (args.auto_screenshot === false) {
        return `✅ Berhasil ${action} di koordinat (${x}, ${y})${extraDesc}.`;
      }

      await sleep(700);
      const info = await captureAndInspect({
        sendToChat: Boolean(args.send_to_chat),
        analyzeVisual: args.analyze_visual !== false,
        visualFocus: args.visual_focus || `Hasil setelah ${action} di (${x}, ${y})${extraDesc}`,
        context
      });
      return `✅ Berhasil ${action} di koordinat (${x}, ${y})${extraDesc}.\n${info}`;
    }

    // 9. drag
    if (action === "drag") {
      const x = clampCoord(args.x, SCREEN_WIDTH);
      const y = clampCoord(args.y, SCREEN_HEIGHT);
      const toX = clampCoord(args.to_x, SCREEN_WIDTH);
      const toY = clampCoord(args.to_y, SCREEN_HEIGHT);
      if (x === null || y === null || toX === null || toY === null) {
        return "❌ Parameter 'x', 'y', 'to_x', dan 'to_y' wajib diisi angka untuk action='drag'.";
      }
      runXdotool([
        "mousemove",
        String(x),
        String(y),
        "mousedown",
        "1",
        "mousemove",
        String(toX),
        String(toY),
        "mouseup",
        "1"
      ]);
      await sleep(500);
      const info = await captureAndInspect({
        sendToChat: Boolean(args.send_to_chat),
        analyzeVisual: args.analyze_visual !== false,
        context
      });
      return `✅ Berhasil drag dari (${x}, ${y}) ke (${toX}, ${toY}).\n${info}`;
    }

    // 10. scroll
    if (action === "scroll") {
      const dir = String(args.direction || "down").toLowerCase();
      const amount = Math.min(Math.max(Number(args.amount) || 4, 1), 25);
      if (args.x !== undefined && args.y !== undefined) {
        const x = clampCoord(args.x, SCREEN_WIDTH);
        const y = clampCoord(args.y, SCREEN_HEIGHT);
        if (x !== null && y !== null) {
          runXdotool(["mousemove", String(x), String(y)]);
        }
      }
      // Button X11: 4=up, 5=down, 6=left, 7=right
      const btn = dir === "up" ? "4" : dir === "left" ? "6" : dir === "right" ? "7" : "5";
      runXdotool(["click", "--repeat", String(amount), "--delay", "40", btn]);
      await sleep(500);
      const info = await captureAndInspect({
        sendToChat: Boolean(args.send_to_chat),
        analyzeVisual: args.analyze_visual !== false,
        context
      });
      return `✅ Berhasil scroll ${dir} (${amount}x).\n${info}`;
    }

    // 11. type
    if (action === "type") {
      const text = String(args.text ?? "");
      if (!text) return "❌ Parameter 'text' wajib diisi untuk action='type'.";
      if (args.clear_first) {
        runXdotool(["key", "--clearmodifiers", "ctrl+a", "BackSpace"]);
        await sleep(80);
      }
      typeTextSafe(text);
      if (args.press_enter) {
        await sleep(100);
        runXdotool(["key", "--clearmodifiers", "Return"]);
      }
      if (args.auto_screenshot === false) {
        return `✅ Berhasil mengetik teks (${text.length} karakter)${args.press_enter ? " + Enter" : ""}.`;
      }
      await sleep(600);
      const info = await captureAndInspect({
        sendToChat: Boolean(args.send_to_chat),
        analyzeVisual: args.analyze_visual !== false,
        context
      });
      return `✅ Berhasil mengetik teks (${text.length} karakter)${args.press_enter ? " + Enter" : ""}.\n${info}`;
    }

    // 12. key
    if (action === "key") {
      const key = String(args.key || args.text || "").trim();
      if (!key) {
        return "❌ Parameter 'key' wajib diisi untuk action='key' (contoh: 'Return', 'Tab', 'Escape', 'ctrl+t', 'ctrl+w', 'ctrl+l', 'BackSpace').";
      }
      runXdotool(["key", "--clearmodifiers", key]);
      if (args.auto_screenshot === false) {
        return `✅ Berhasil menekan tombol '${key}'.`;
      }
      await sleep(600);
      const info = await captureAndInspect({
        sendToChat: Boolean(args.send_to_chat),
        analyzeVisual: args.analyze_visual !== false,
        context
      });
      return `✅ Berhasil menekan tombol '${key}'.\n${info}`;
    }

    // 13. wait
    if (action === "wait") {
      const sec = Math.min(Math.max(Number(args.seconds) || 3, 1), 30);
      await sleep(sec * 1000);
      const info = await captureAndInspect({
        sendToChat: Boolean(args.send_to_chat),
        analyzeVisual: args.analyze_visual !== false,
        context
      });
      return `⏳ Selesai menunggu ${sec} detik.\n${info}`;
    }

    return `❌ Action '${action}' tidak dikenal. Gunakan salah satu: start_desktop, stop_desktop, screenshot, open_url, list_tabs, switch_tab, close_tab, click, double_click, right_click, move, drag, scroll, type, key, wait.`;
  } catch (err) {
    return `❌ Gagal menjalankan computer_use (${action}): ${err.message}`;
  }
}

module.exports = { toolComputerUse };
