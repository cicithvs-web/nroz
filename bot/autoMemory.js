/**
 * bot/autoMemory.js — Ekstraksi otomatis keputusan/preferensi user saat peringkasan berjalan.
 *
 * Model utama sering lupa memanggil record_decision. Karena itu panggilan peringkas (yang sudah
 * berjalan setelah giliran) sekaligus diminta menyebut keputusan baru, lalu hasilnya ditulis ke
 * .memory/decisions.md dengan kategori berawalan "Otomatis" supaya mudah dikenali dan bisa dicabut
 * lewat forget_decision.
 */

const { recordDecision, listActiveDecisions } = require("../workspaceMemoryManager.js");

const DECISIONS_MARKER = "===KEPUTUSAN===";
const AUTO_CATEGORY_PREFIX = "Otomatis";
const MAX_AUTO_DECISIONS = 5;
const MIN_DECISION_CHARS = 8;
const MAX_DECISION_CHARS = 300;

/** Teks instruksi + daftar keputusan aktif untuk ditempel ke prompt peringkas. */
function buildDecisionExtractionPrompt(activeDecisions) {
  const existing = activeDecisions.length
    ? activeDecisions.map((d) => `#${d.id} [${d.category}] ${d.text}`).join("\n")
    : "(belum ada)";

  return `
[Keputusan yang Sudah Tercatat]:
${existing}

Setelah ringkasan, tulis satu baris persis "${DECISIONS_MARKER}", lalu daftar keputusan atau preferensi BARU dari User (maksimal ${MAX_AUTO_DECISIONS}), satu per baris, format:
- [Kategori] isi keputusan singkat
Jika keputusan baru menggantikan salah satu yang sudah tercatat, pakai format:
- GANTI #nomor [Kategori] isi keputusan baru
Aturan ketat:
- Hanya dari pesan USER: pilihan eksplisit (mis. "pakai opsi B", "jangan pakai X"), persetujuan atas usulan Assistant, aturan atau preferensi yang berlaku seterusnya (bahasa, gaya jawaban, teknologi yang dipakai).
- JANGAN catat: usulan Assistant yang belum disetujui, permintaan sekali jalan, detail tugas sementara, atau hal yang sudah ada di daftar tercatat.
- Lebih baik tidak mencatat daripada salah mencatat. Jika tidak ada, tulis persis: - tidak ada`;
}

/**
 * Memisahkan keluaran peringkas menjadi ringkasan dan daftar keputusan.
 * Jika penanda tidak ada, seluruh teks dianggap ringkasan.
 * @returns {{ summary: string, decisions: Array<{supersedes:number|null, category:string, text:string}> }}
 */
function parseCompactionOutput(output) {
  const raw = String(output || "");
  const markerRe = /^[ \t]*={3}[ \t]*KEPUTUSAN[ \t]*={3}[ \t]*$/im;
  const m = markerRe.exec(raw);
  if (!m) return { summary: raw.trim(), decisions: [] };

  const summary = raw.slice(0, m.index).trim();
  const decisions = [];

  for (const line of raw.slice(m.index + m[0].length).split("\n")) {
    if (decisions.length >= MAX_AUTO_DECISIONS) break;
    const lm = line.trim().match(/^[-*]\s*(?:GANTI\s*#(\d+)\s*)?(?:\[([^\]]{1,40})\]\s*)?(.+)$/i);
    if (!lm) continue;
    const text = lm[3].replace(/\s+/g, " ").trim().slice(0, MAX_DECISION_CHARS);
    if (text.length < MIN_DECISION_CHARS || /^tidak ada\.?$/i.test(text)) continue;
    decisions.push({
      supersedes: lm[1] ? Number(lm[1]) : null,
      category: (lm[2] || "Umum").trim(),
      text
    });
  }
  return { summary, decisions };
}

function normalize(text) {
  return String(text || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

/** True jika teks sudah (hampir) sama dengan salah satu keputusan aktif. */
function isDuplicate(text, active) {
  const n = normalize(text);
  if (!n) return true;
  return active.some((d) => {
    const o = normalize(d.text);
    return o === n || (Math.min(o.length, n.length) >= 20 && (o.includes(n) || n.includes(o)));
  });
}

/**
 * Menulis keputusan hasil ekstraksi ke decisions.md. Tidak pernah melempar error.
 * @returns {number} jumlah keputusan yang ditulis
 */
function applyAutoDecisions(sessionId, decisions) {
  let written = 0;
  for (const d of decisions || []) {
    try {
      const active = listActiveDecisions(sessionId);
      if (isDuplicate(d.text, active)) continue;
      const supersedes = d.supersedes && active.some((a) => a.id === d.supersedes) ? d.supersedes : null;
      recordDecision(sessionId, d.text, `${AUTO_CATEGORY_PREFIX} · ${d.category}`, supersedes);
      written++;
    } catch (err) {
      console.warn(`[Auto Memory] Gagal mencatat keputusan otomatis sesi ${sessionId}:`, err.message);
    }
  }
  return written;
}

module.exports = {
  DECISIONS_MARKER,
  AUTO_CATEGORY_PREFIX,
  buildDecisionExtractionPrompt,
  parseCompactionOutput,
  applyAutoDecisions
};
