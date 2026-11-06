/**
 * bot/knowledge.js — Memori semantik (RAG) di atas PostgreSQL + pgvector.
 *
 * Dokumen yang di-upload user (PDF, DOCX, teks/kode) dan percakapan penting dipecah jadi
 * chunk, di-embed lewat API OpenAI-compatible (BASE_URL + API_KEY yang sudah dipakai bot),
 * lalu disimpan sebagai vektor. Tool search_knowledge mencari dengan cosine similarity.
 *
 * Butuh ekstensi pgvector di PostgreSQL — docker-compose.yml repo ini memakai image
 * pgvector/pgvector:pg16. Semua kegagalan ditangkap rapi: kalau infrastruktur belum siap,
 * fitur dilaporkan tidak tersedia dan bot tetap jalan normal.
 */

const crypto = require("crypto");
const { query } = require("../dbHelper.js");
const { getClient } = require("./config");

const EMBED_MODEL = (process.env.EMBED_MODEL || "text-embedding-3-small").trim();
const EMBED_DIM = Number(process.env.EMBED_DIM) || 1536;
const CHUNK_SIZE = 1200;
const CHUNK_OVERLAP = 150;
const MIN_CHUNK_CHARS = 40;
const MAX_CHUNKS_PER_INGEST = 300;
const EMBED_BATCH = 16;
const INGEST_CHAT = (process.env.KNOWLEDGE_INGEST_CHAT || "on").toLowerCase() !== "off";

let schemaPromise = null;
let disabledReason = null;

// ============================================================
// CHUNKING (fungsi murni, diuji di test/chunking.test.js)
// ============================================================

/**
 * Memecah teks panjang jadi chunk ≤ `size` karakter dengan tumpang tindih `overlap`.
 * Memecah di batas paragraf dulu, lalu kalimat, baru potongan keras — supaya konteks
 * kalimat tidak terpotong sembarangan.
 */
function chunkText(text, size = CHUNK_SIZE, overlap = CHUNK_OVERLAP) {
  const src = String(text || "").replace(/\r\n/g, "\n").trim();
  if (!src) return [];
  if (src.length <= size) return [src];

  const paragraphs = src.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
  const chunks = [];
  let current = "";

  const pushCurrent = () => {
    const c = current.trim();
    if (c) chunks.push(c);
    current = "";
  };

  // Sisa chunk terakhir dilepas ke chunk berikutnya (overlap antar-chunk).
  const carryOver = () => {
    if (chunks.length && overlap > 0) {
      const last = chunks[chunks.length - 1];
      return last.slice(Math.max(0, last.length - overlap));
    }
    return "";
  };

  for (const para of paragraphs) {
    if (para.length > size) {
      // Paragraf raksasa: pecah per kalimat.
      const sentences = para.split(/(?<=[.!?])\s+|\n/).map((s) => s.trim()).filter(Boolean);
      for (const sentence of sentences) {
        if (sentence.length > size) {
          // Bahkan kalimatnya raksasa: potong keras dengan overlap.
          pushCurrent();
          let head = carryOver();
          for (let i = 0; i < sentence.length; i += size - overlap) {
            const piece = (head + sentence.slice(i, i + size - overlap)).slice(0, size);
            chunks.push(piece);
            head = piece.slice(Math.max(0, piece.length - overlap));
          }
          continue;
        }
        if ((current + "\n" + sentence).trim().length > size) {
          pushCurrent();
          current = carryOver();
        }
        current = (current ? current + "\n" : "") + sentence;
      }
      continue;
    }

    if ((current + "\n\n" + para).trim().length > size) {
      pushCurrent();
      current = carryOver();
    }
    current = (current ? current + "\n\n" : "") + para;
  }
  pushCurrent();

  return chunks.filter((c) => c.length >= MIN_CHUNK_CHARS || chunks.length === 1);
}

const sha1 = (s) => crypto.createHash("sha1").update(String(s)).digest("hex");

// ============================================================
// SKEMA
// ============================================================

async function ensureSchema() {
  if (schemaPromise) return schemaPromise;
  schemaPromise = (async () => {
    try {
      await query("CREATE EXTENSION IF NOT EXISTS vector");
    } catch (err) {
      throw new Error(
        "Ekstensi pgvector tidak tersedia di PostgreSQL. " +
          "Ganti image di docker-compose.yml ke pgvector/pgvector:pg16 lalu jalankan ulang container. " +
          `Detail: ${err.message}`
      );
    }

    await query(
      `CREATE TABLE IF NOT EXISTS knowledge_meta (k TEXT PRIMARY KEY, v TEXT)`
    );

    const meta = await query(`SELECT k, v FROM knowledge_meta WHERE k IN ('embed_model', 'embed_dim')`);
    const stored = Object.fromEntries(meta.rows.map((r) => [r.k, r.v]));
    if (stored.embed_dim && Number(stored.embed_dim) !== EMBED_DIM) {
      throw new Error(
        `Tabel knowledge_chunks sudah ada dengan dimensi ${stored.embed_dim}, sedangkan EMBED_DIM sekarang ${EMBED_DIM}. ` +
          `Kembalikan EMBED_DIM ke ${stored.embed_dim}, atau hapus tabel knowledge_chunks untuk memulai ulang.`
      );
    }
    if (stored.embed_model && stored.embed_model !== EMBED_MODEL) {
      console.warn(`[Knowledge] Model embedding berubah (${stored.embed_model} -> ${EMBED_MODEL}). ` +
        `Hasil pencarian lama mungkin kurang akurat; disarankan hapus tabel knowledge_chunks lalu biarkan bot meng-ingest ulang.`);
    }

    await query(
      `CREATE TABLE IF NOT EXISTS knowledge_chunks (
         id BIGSERIAL PRIMARY KEY,
         session_id TEXT NOT NULL,
         source TEXT NOT NULL,
         chunk_index INTEGER NOT NULL DEFAULT 0,
         content TEXT NOT NULL,
         content_hash TEXT NOT NULL,
         embedding vector(${EMBED_DIM}),
         created_at BIGINT NOT NULL
       )`
    );
    await query(
      `CREATE UNIQUE INDEX IF NOT EXISTS knowledge_chunks_dedupe ON knowledge_chunks (session_id, content_hash)`
    );
    await query(`CREATE INDEX IF NOT EXISTS knowledge_chunks_session ON knowledge_chunks (session_id)`);

    await query(
      `INSERT INTO knowledge_meta (k, v) VALUES ('embed_model', $1), ('embed_dim', $2)
       ON CONFLICT (k) DO UPDATE SET v = EXCLUDED.v`,
      [EMBED_MODEL, String(EMBED_DIM)]
    );
    disabledReason = null;
  })();
  schemaPromise.catch((err) => {
    disabledReason = err.message;
    schemaPromise = null; // boleh dicoba lagi nanti (mis. pgvector baru dipasang)
  });
  return schemaPromise;
}

// ============================================================
// EMBEDDING
// ============================================================

async function embedBatch(texts) {
  const client = getClient();
  if (!client || !client.embeddings) {
    throw new Error("Client embeddings tidak tersedia (BASE_URL/API_KEY belum diatur?).");
  }
  const res = await client.embeddings.create({ model: EMBED_MODEL, input: texts });
  return res.data.map((d) => d.embedding);
}

const toVectorLiteral = (arr) => `[${arr.map((n) => Number(n).toFixed(7)).join(",")}]`;

// ============================================================
// INGEST
// ============================================================

/**
 * Simpan teks ke memori semantik. @returns {Promise<{stored: number, skipped?: string}>}
 */
async function ingestText(sessionId, source, text) {
  try {
    await ensureSchema();
  } catch (err) {
    return { stored: 0, skipped: err.message };
  }

  const chunks = chunkText(text).slice(0, MAX_CHUNKS_PER_INGEST);
  if (chunks.length === 0) return { stored: 0, skipped: "tidak ada chunk layak simpan" };

  let stored = 0;
  for (let i = 0; i < chunks.length; i += EMBED_BATCH) {
    const batch = chunks.slice(i, i + EMBED_BATCH);
    let vectors;
    try {
      vectors = await embedBatch(batch);
    } catch (err) {
      return { stored, skipped: `embedding gagal: ${err.message}` };
    }
    for (let j = 0; j < batch.length; j++) {
      try {
        await query(
          `INSERT INTO knowledge_chunks (session_id, source, chunk_index, content, content_hash, embedding, created_at)
           VALUES ($1, $2, $3, $4, $5, $6::vector, $7)
           ON CONFLICT (session_id, content_hash) DO NOTHING`,
          [String(sessionId), source, i + j, batch[j], sha1(batch[j]), toVectorLiteral(vectors[j]), Date.now()]
        );
        stored++;
      } catch (err) {
        return { stored, skipped: `insert gagal: ${err.message}` };
      }
    }
  }
  return { stored };
}

/** Ekstrak teks dari buffer file upload, lalu ingest. Dipanggil fire-and-forget dari handlers. */
async function ingestFileBuffer(sessionId, fileName, buffer) {
  const ext = String(fileName || "").toLowerCase().split(".").pop();
  let text = null;
  try {
    if (ext === "pdf") {
      const pdf = require("pdf-parse");
      const data = await pdf(buffer);
      text = data.text || "";
    } else if (ext === "docx") {
      const mammoth = require("mammoth");
      const data = await mammoth.extractRawText({ buffer });
      text = data.value || "";
    } else if (
      ["txt", "md", "csv", "json", "html", "htm", "xml", "yaml", "yml", "sql",
       "js", "ts", "jsx", "tsx", "py", "sh", "css", "log"].includes(ext)
    ) {
      text = buffer.toString("utf-8");
    }
  } catch (err) {
    return { stored: 0, skipped: `gagal membaca ${fileName}: ${err.message}` };
  }
  if (!text || text.trim().length < MIN_CHUNK_CHARS) return { stored: 0, skipped: "teks kosong/terlalu pendek" };
  return ingestText(sessionId, `upload:${fileName}`, text);
}

/** Ingest pesan chat (dipakai handlers.js & agentLoop.js, fire-and-forget). */
async function ingestChatMessage(sessionId, role, content) {
  if (!INGEST_CHAT) return { stored: 0, skipped: "ingest chat dimatikan" };
  const text = String(content || "").trim();
  if (text.length < 200) return { stored: 0, skipped: "pesan pendek" };
  return ingestText(sessionId, `chat:${role}`, text);
}

// ============================================================
// PENCARIAN
// ============================================================

/**
 * Pencarian semantik top-k.
 * @param {string} sessionId
 * @param {string} queryText
 * @param {{ limit?: number, source?: string }} [opts]  source: "chat", "upload", atau awalan sumber
 * @returns {Promise<{ results: Array<{source, score, content}>, error?: string }>}
 */
async function searchKnowledge(sessionId, queryText, opts = {}) {
  try {
    await ensureSchema();
  } catch (err) {
    return { results: [], error: err.message };
  }

  const limit = Math.min(Math.max(Number(opts.limit) || 6, 1), 20);
  let sourcePattern = "";
  if (opts.source) {
    const s = String(opts.source).trim().toLowerCase();
    sourcePattern = s === "chat" ? "chat:%" : s === "upload" ? "upload:%" : `${s}%`;
  }

  try {
    const [vec] = await embedBatch([String(queryText).trim()]);
    const params = [String(sessionId), toVectorLiteral(vec)];
    let sql =
      `SELECT source, content, 1 - (embedding <=> $2::vector) AS score
       FROM knowledge_chunks WHERE session_id = $1`;
    if (sourcePattern) {
      params.push(sourcePattern);
      sql += ` AND source LIKE $3`;
    }
    params.push(limit);
    sql += ` ORDER BY embedding <=> $2::vector LIMIT $${params.length}`;

    const res = await query(sql, params);
    return {
      results: res.rows.map((r) => ({ source: r.source, score: Number(r.score), content: r.content }))
    };
  } catch (err) {
    return { results: [], error: err.message };
  }
}

function formatResults(results) {
  return results
    .map(
      (r, i) =>
        `[${i + 1}] (sumber: ${r.source} · kemiripan ${(r.score * 100).toFixed(0)}%)\n` +
        String(r.content).slice(0, 700) + (r.content.length > 700 ? "…" : "")
    )
    .join("\n\n---\n\n");
}

module.exports = {
  chunkText,
  ingestText,
  ingestFileBuffer,
  ingestChatMessage,
  searchKnowledge,
  formatResults,
  EMBED_MODEL,
  EMBED_DIM,
  _resetForTests: () => {
    schemaPromise = null;
    disabledReason = null;
  }
};
