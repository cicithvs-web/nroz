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

  return { args: out, fixes };
}

/**
 * @param {string} toolName nama asli tool di server MCP (bukan alias di bot)
 * @param {object} args argumen dari model
 * @returns {{ args: object, fixes: string[] }}
 */
function fixMcpArgs(toolName, args) {
  if (!args || typeof args !== "object") return { args: args ?? {}, fixes: [] };
  if (toolName === "sequentialthinking") return fixSequentialThinking(args);
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
