/**
 * lib/mcpArgs.js — Membetulkan kesalahan argumen yang sering dibuat model sebelum tool MCP dipanggil.
 *
 * Sengaja sempit: hanya kesalahan yang sudah terbukti di log produksi, dan hanya untuk tool yang
 * dikenal. Menebak-nebak semua parameter dari skema berisiko mengubah maksud model diam-diam.
 *
 * sequentialthinking (server skema: revisesThought/branchFromThought bertipe angka >= 1,
 * nextThoughtNeeded wajib boolean):
 *  - revisesThought / branchFromThought bernilai 0, "", null, atau false artinya "tidak dipakai" -> dihapus.
 *  - parameter opsional lain yang bernilai null -> dihapus (null ditolak validator server).
 *  - nextThoughtNeeded hilang atau null -> true. Ini hanya penanda yang dicatat server, bukan pemicu
 *    loop, jadi salah tebak paling buruk menghasilkan satu langkah pikir tambahan.
 *  - nextThoughtNeeded berupa angka 1/0 -> true/false.
 */

const fs = require("fs");
const path = require("path");
const { resolveInWorkspace } = require("./pathGuard");

const SEQ_OPTIONAL_KEYS = ["isRevision", "revisesThought", "branchFromThought", "branchId", "needsMoreThoughts"];
const SEQ_ZERO_MEANS_UNSET = ["revisesThought", "branchFromThought"];

function isEmptyValue(v) {
  return v === 0 || v === "" || v === "0" || v === null || v === false || v === undefined;
}

function fixSequentialThinking(args) {
  const out = { ...args };
  const fixes = [];

  for (const key of SEQ_ZERO_MEANS_UNSET) {
    if (key in out && isEmptyValue(out[key])) {
      fixes.push(`${key}=${JSON.stringify(out[key])} dihapus`);
      delete out[key];
    }
  }
  for (const key of SEQ_OPTIONAL_KEYS) {
    if (key in out && out[key] === null) {
      fixes.push(`${key}=null dihapus`);
      delete out[key];
    }
  }

  if (out.nextThoughtNeeded === undefined || out.nextThoughtNeeded === null || out.nextThoughtNeeded === "") {
    fixes.push(`nextThoughtNeeded ${out.nextThoughtNeeded === undefined ? "hilang" : "kosong"} -> true`);
    out.nextThoughtNeeded = true;
  } else if (out.nextThoughtNeeded === 1 || out.nextThoughtNeeded === 0) {
    const asBool = out.nextThoughtNeeded === 1;
    fixes.push(`nextThoughtNeeded=${out.nextThoughtNeeded} -> ${asBool}`);
    out.nextThoughtNeeded = asBool;
  }

  if (fixes.length === 0) return { args, fixes: [] };
  return { args: out, fixes };
}

/**
 * Mengarahkan argumen file pada browser MCP ke dalam workspace sesi aktif (Opsi 2).
 * Mencegah file liar tersimpan di CWD host (/opt/nroz atau /root/nroz).
 */
function fixBrowserArgs(toolName, args, context = {}) {
  const out = { ...args };
  const fixes = [];
  const sessionId = context.sessionId || "default";

  // 0. Jika browser_navigate membuka localhost/127.0.0.1/0.0.0.0:PORT milik sandbox sesi,
  // arahkan otomatis ke IP container Docker sesi agar Playwright dapat menguji web buatan AI.
  if (typeof out.url === "string" && out.url.trim()) {
    const localMatch = out.url.trim().match(/^(https?:\/\/)(?:localhost|127\.0\.0\.1|0\.0\.0\.0)(:\d+(?:\/.*)?)$/i);
    if (localMatch) {
      let sandboxIp = context.sandboxIp || null;
      if (!sandboxIp && context.sessionId) {
        try {
          const { getSandboxIP } = require("../sandboxManager.js");
          sandboxIp = getSandboxIP(context.sessionId);
        } catch (_) {}
      }
      if (sandboxIp) {
        const prev = out.url;
        out.url = `${localMatch[1]}${sandboxIp}${localMatch[2]}`;
        fixes.push(`url='${prev}' diarahkan ke container sandbox='${out.url}'`);
      }
    }
  }

  // 1. Tool yang menerima parameter filename (screenshot, snapshot, evaluate, etc.)
  if ("filename" in out) {
    if (typeof out.filename === "string" && out.filename.trim()) {
      const raw = out.filename.trim();
      const guard = resolveInWorkspace(raw, sessionId);
      if (!guard.ok) {
        throw new Error(guard.error);
      }
      try {
        fs.mkdirSync(path.dirname(guard.path), { recursive: true });
      } catch (_) {}
      out.filename = guard.path;
      fixes.push(`filename='${raw}' diarahkan ke workspace='${guard.path}'`);
    } else if (out.filename === "" || out.filename === null) {
      delete out.filename;
      fixes.push("filename kosong dihapus");
    }
  }

  // 2. Tool yang menerima array paths (file_upload, drop)
  if (Array.isArray(out.paths)) {
    const newPaths = [];
    for (const p of out.paths) {
      if (typeof p === "string" && p.trim()) {
        const raw = p.trim();
        const guard = resolveInWorkspace(raw, sessionId);
        if (!guard.ok) {
          throw new Error(guard.error);
        }
        newPaths.push(guard.path);
        fixes.push(`path='${p}' diarahkan ke workspace='${guard.path}'`);
      } else {
        newPaths.push(p);
      }
    }
    out.paths = newPaths;
  }

  // 3. Normalisasi argumen ref / selector -> target pada Playwright MCP (@playwright/mcp >= 0.0.83)
  // Di log produksi sering muncul: `Unknown engine "ref" while parsing selector ref=f3e106`
  // karena model mengirim `target: "ref=f3e106"` atau `target: "[ref=f3e106]"` atau `{ ref: "f3e106" }`,
  // sedangkan Playwright MCP hanya mengenali ref murni `/^(f\d+)?e\d+$/` di field `target`.
  if (!("target" in out)) {
    if (typeof out.ref === "string" && out.ref.trim()) {
      out.target = out.ref.trim();
      delete out.ref;
      fixes.push(`ref dipindahkan ke target='${out.target}'`);
    } else if (typeof out.selector === "string" && out.selector.trim()) {
      out.target = out.selector.trim();
      delete out.selector;
      fixes.push(`selector dipindahkan ke target='${out.target}'`);
    }
  }

  for (const key of ["target", "startTarget", "endTarget"]) {
    if (typeof out[key] === "string" && out[key].trim()) {
      const rawTarget = out[key].trim();
      const refMatch =
        rawTarget.match(/^\[?\s*(?:aria-)?ref\s*=\s*["']?((?:f\d+)?e\d+)["']?\s*\]?$/i) ||
        rawTarget.match(/^\[\s*((?:f\d+)?e\d+)\s*\]$/i);
      if (refMatch) {
        out[key] = refMatch[1];
        fixes.push(`${key}='${rawTarget}' dinormalisasi menjadi ref='${refMatch[1]}'`);
      }
    }
  }

  if (fixes.length === 0) return { args, fixes: [] };
  return { args: out, fixes };
}

/**
 * @param {string} toolName nama asli tool di server MCP (bukan alias di bot)
 * @param {object} args argumen dari model
 * @param {object} context konteks eksekusi (sessionId, dll)
 * @returns {{ args: object, fixes: string[] }}
 */
function fixMcpArgs(toolName, args, context = {}) {
  if (!args || typeof args !== "object") return { args: args ?? {}, fixes: [] };
  if (toolName === "sequentialthinking") return fixSequentialThinking(args);
  if (typeof toolName === "string" && (toolName.startsWith("browser_") || toolName.startsWith("playwright_"))) {
    return fixBrowserArgs(toolName, args, context);
  }
  return { args, fixes: [] };
}

/**
 * Bentuk argumen untuk log: nama + tipe/panjang, bukan isinya (isi bisa panjang atau sensitif).
 * Contoh: {"thought":"string(412)","nextThoughtNeeded":"undefined","revisesThought":"number(0)"}
 */
function describeArgsShape(args) {
  if (!args || typeof args !== "object") return String(args);
  const shape = {};
  for (const [k, v] of Object.entries(args)) {
    if (typeof v === "string") shape[k] = `string(${v.length})`;
    else if (v === null) shape[k] = "null";
    else if (Array.isArray(v)) shape[k] = `array(${v.length})`;
    else if (typeof v === "object") shape[k] = "object";
    else shape[k] = `${typeof v}(${String(v)})`;
  }
  return JSON.stringify(shape);
}

module.exports = { fixMcpArgs, describeArgsShape };
