/**
 * bot/text.js — Fungsi teks murni (tanpa Telegram) untuk format jawaban dan potongan pesan.
 */

const path = require("path");

/** Batas teks per pesan. Bot API maksimal 4096; sisanya cadangan untuk penutup code block dan penanda. */
const MESSAGE_LIMIT = 4000;

function cleanAnswer(text) {
  return String(text || "")
    .replace(/\*\*/g, "*") // Ubah **bold** (OpenAI) menjadi *bold* (Telegram Markdown)
    .replace(/### /g, ""); // Hapus simbol heading ###
}

function cleanFileTags(text) {
  if (!text) return "";
  return text
    .replace(/<<<ZIP:\s*[^\n>]+\.zip\s*>>>/gi, "")
    .replace(/<<<SENDFILE:\s*[^\n>]+\s*>>>/gi, "")
    .replace(/<<<(?:SENDPHOTO|SENDIMAGE):\s*[^\n>]+\s*>>>/gi, "")
    .replace(/<<<SENDVIDEO:\s*[^\n>]+\s*>>>/gi, "")
    .replace(/<<<FILE:\s*([^\n>]+)>>>\s*\n([\s\S]*?)<<<ENDFILE>>>/gi, (match, fname, code) => {
      const ext = path.extname(fname).replace(".", "") || "";
      return `\`\`\`${ext}\n// File: ${fname}\n${code}\n\`\`\``;
    });
}

function cleanDraftPreview(text) {
  if (!text) return "";
  return cleanAnswer(cleanFileTags(text))
    .replace(/<<<ZIP:[^\n>]*>?/gi, "")
    .replace(/<<<FILE:\s*([^\n>]+)>>>?/gi, "\n[File: $1]\n")
    .replace(/<<<ENDFILE>>>?/gi, "");
}

/** Deteksi tabel Markdown (| Kolom | Kolom |\n|---|---|). */
function hasMarkdownTable(text) {
  if (!text) return false;
  return /\|[^\n\r]+\|\r?\n\|[\s\-:|]+\|\r?\n\|[^\n\r]+\|/.test(text);
}

/** Error Telegram karena Markdown tidak valid (misalnya `_` atau `*` yang tidak berpasangan). */
function isParseError(err) {
  return /can't parse entities|can't find end of|unsupported start tag|entity beginning/i.test(String(err?.message || err));
}

/** Error Telegram karena teks terlalu panjang. */
function isTooLongError(err) {
  return /message is too long|text is too long|MESSAGE_TOO_LONG/i.test(String(err?.message || err));
}

/**
 * Memecah teks panjang menjadi potongan <= limit karakter.
 * - Code block yang terpotong ditutup di potongan ini lalu dibuka lagi (dengan bahasa yang sama)
 *   di potongan berikutnya, supaya format Telegram tidak rusak.
 * - Baris yang sendirinya lebih panjang dari limit dipotong paksa.
 */
function splitMessage(text, limit = MESSAGE_LIMIT) {
  const input = String(text ?? "");
  if (input.length <= limit) return [input];

  const maxPiece = Math.max(100, limit - 200);
  const pieces = [];
  for (const line of input.split("\n")) {
    if (line.length <= maxPiece) {
      pieces.push(line);
    } else {
      for (let i = 0; i < line.length; i += maxPiece) pieces.push(line.slice(i, i + maxPiece));
    }
  }

  const chunks = [];
  let current = "";
  let inCode = false;
  let lang = "";

  const flush = () => {
    let out = current.replace(/\n$/, "");
    if (inCode) out += "\n```";
    if (out.trim()) chunks.push(out);
    current = inCode ? "```" + lang + "\n" : "";
  };

  for (const piece of pieces) {
    const reserve = inCode ? 4 : 0; // "\n```" penutup
    if (current.length + piece.length + 1 > limit - reserve) flush();
    current += piece + "\n";
    if (piece.trim().startsWith("```")) {
      inCode = !inCode;
      lang = inCode ? piece.trim().slice(3).replace(/`/g, "").trim() : "";
    }
  }
  const last = current.replace(/\n$/, "");
  if (last.trim() && last.trim() !== "```" + lang) chunks.push(last);

  return chunks;
}

function sanitizePath(filePath) {
  if (!filePath) return "";
  return filePath
    .trim()
    .replace(/^(\/|\\)+/, "") // Hapus slash di awal
    .replace(/\.\.+[\/\\]/g, "") // Cegah path traversal ../
    .replace(/[<>:"|?*]/g, ""); // Hapus karakter tidak valid pada file sistem
}

function renderProgressBar(percent) {
  const filled = Math.max(0, Math.min(10, Math.round((percent || 0) / 10)));
  return "▓".repeat(filled) + "░".repeat(10 - filled);
}

function humanizeSeconds(sec) {
  const s = Math.max(0, Math.round(sec || 0));
  if (s < 60) return `${s} detik`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} menit`;
  return `${Math.floor(m / 60)} jam ${m % 60} menit`;
}

module.exports = {
  MESSAGE_LIMIT,
  cleanAnswer,
  cleanFileTags,
  cleanDraftPreview,
  hasMarkdownTable,
  isParseError,
  isTooLongError,
  splitMessage,
  sanitizePath,
  renderProgressBar,
  humanizeSeconds
};
