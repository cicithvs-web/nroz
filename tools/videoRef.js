/**
 * tools/videoRef.js — Tool analyze_video_reference: "lihat" video referensi lalu
 * menghasilkan spec gaya visual untuk render_remotion_video.
 *
 * Model tidak bisa menonton video, jadi tool ini menjembatani:
 *   1. ffprobe  -> metadata (durasi, resolusi, fps, codec)
 *   2. ffmpeg   -> deteksi scene cut (ritme potongan) + ekstrak frame
 *   3. ffmpeg   -> contact sheet 3x3 (grid frame berurutan waktu)
 *   4. vision   -> analisis gaya dari contact sheet (palet, layout, tipografi, motion)
 *
 * Semua pemanggilan proses memakai array argv (tanpa shell), input video divalidasi
 * pathGuard (harus di workspace sesi), dan frame olahan di /tmp sementara.
 */

const { execFile } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { resolveFilePath, truncate } = require("./common");
const { getSessionWorkspace } = require("../sandboxManager.js");
const { getClient, getConfig } = require("../bot/config");

const ANALYZE_MAX_SECONDS = Number(process.env.VIDEO_REF_MAX_SECONDS) || 120;
const FRAMES_PER_SHEET = 9;
const MAX_SHEETS = 2;
const MAX_INPUT_BYTES = 200 * 1024 * 1024;
const VIDEO_EXTS = new Set([".mp4", ".mov", ".mkv", ".webm", ".m4v", ".avi", ".mpg", ".mpeg", ".ts"]);

// ============================================================
// FUNGSI MURNI (diuji di test/videoRef.test.js)
// ============================================================

/** Parse output `ffprobe -print_format json`. Null jika tidak valid. */
function parseFfprobe(jsonStr) {
  let data;
  try {
    data = JSON.parse(String(jsonStr));
  } catch {
    return null;
  }
  const v = (data.streams || []).find((s) => s.codec_type === "video") || {};
  const durationSec = Number(data.format?.duration ?? v.duration);
  if (!Number.isFinite(durationSec) || durationSec <= 0) return null;
  let fps = NaN;
  const rate = String(v.avg_frame_rate || v.r_frame_rate || "");
  const m = rate.match(/^(\d+(?:\.\d+)?)\/(\d+(?:\.\d+)?)$/);
  if (m) fps = Number(m[1]) / Number(m[2]);
  if (!Number.isFinite(fps) || fps <= 0) fps = null;
  return {
    durationSec,
    width: Number(v.width) || null,
    height: Number(v.height) || null,
    fps: fps ? Math.round(fps * 100) / 100 : null,
    codec: v.codec_name || null
  };
}

/** Detik -> "m:ss" (menit tanpa batas). */
function fmtTime(sec) {
  const s = Math.max(0, Math.floor(Number(sec) || 0));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/** Ambil timestamp cut dari stderr `showinfo` (pts_time:...), terurut & unik (toleransi 0,05 s). */
function parseSceneCuts(stderr) {
  const cuts = [];
  const re = /pts_time:(\d+(?:\.\d+)?)/g;
  let m;
  while ((m = re.exec(String(stderr))) !== null) {
    const t = Number(m[1]);
    if (Number.isFinite(t) && t >= 0) cuts.push(t);
  }
  cuts.sort((a, b) => a - b);
  const unique = [];
  for (const t of cuts) {
    if (unique.length === 0 || t - unique[unique.length - 1] > 0.05) unique.push(t);
  }
  return unique;
}

/** Statistik ritme dari daftar cut dalam window analisis. */
function pacingStats(cuts, windowSec) {
  const inWindow = cuts.filter((t) => t >= 0 && t <= windowSec);
  const count = inWindow.length;
  return {
    cuts: count,
    per10s: windowSec > 0 ? Math.round((count / windowSec) * 100) / 10 : 0,
    avgShotSec: windowSec > 0 ? Math.round((windowSec / (count + 1)) * 100) / 100 : 0
  };
}

/** `count` waktu frame merata di dalam window (tidak menyentuh 0 dan akhir persis). */
function planFrameTimes(durationSec, count, maxAnalyzeSec) {
  const window = Math.max(0.2, Math.min(Number(durationSec) || 0, Number(maxAnalyzeSec) || durationSec));
  const n = Math.max(1, Number(count) || 1);
  const times = [];
  for (let i = 1; i <= n; i++) {
    let t = (window * i) / (n + 1);
    t = Math.min(Math.max(t, 0), Math.max(0, window - 0.05));
    times.push(Math.round(t * 100) / 100);
  }
  return times;
}

/** Pilih sampel waktu cut yang merata (semua kalau jumlahnya sudah cukup sedikit). */
function pickSceneFrames(cuts, count) {
  const n = Math.max(1, Number(count) || 1);
  if (!Array.isArray(cuts) || cuts.length === 0) return [];
  if (cuts.length <= n) return cuts.slice();
  const out = [];
  for (let i = 0; i < n; i++) {
    const idx = n === 1 ? 0 : Math.round((i * (cuts.length - 1)) / (n - 1));
    out.push(cuts[idx]);
  }
  return out;
}

// ============================================================
// EKSEKUSI HOST
// ============================================================

function run(cmd, args, timeoutMs, maxBuffer = 8 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: timeoutMs, maxBuffer, encoding: "utf8" }, (err, stdout, stderr) => {
      if (err) {
        err.stderr = String(stderr || "");
        return reject(err);
      }
      resolve({ stdout: String(stdout || ""), stderr: String(stderr || "") });
    });
  });
}

async function extractFrame(hostPath, t, outPath) {
  await run("ffmpeg", ["-hide_banner", "-loglevel", "error", "-ss", String(t), "-i", hostPath, "-frames:v", "1", "-q:v", "3", outPath], 20_000);
}

/** 9 frame di dir -> contact sheet 3x3. */
async function buildSheet(frameDir, sheetPath) {
  await run(
    "ffmpeg",
    [
      "-hide_banner", "-loglevel", "error",
      "-framerate", "1", "-start_number", "1",
      "-i", path.join(frameDir, "f%02d.jpg"),
      "-vf", "scale=480:-2,tile=3x3",
      "-frames:v", "1",
      sheetPath
    ],
    30_000
  );
}

async function extractSheet(hostPath, times, sheetPath) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nrozvid_"));
  try {
    for (let i = 0; i < times.length; i++) {
      await extractFrame(hostPath, times[i], path.join(dir, `f${String(i + 1).padStart(2, "0")}.jpg`));
    }
    await buildSheet(dir, sheetPath);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// ============================================================
// VISION
// ============================================================

function visionPrompt(meta, pacing, focus) {
  return (
    "Kamu adalah creative director sekaligus creative technologist Remotion. Analisis GAYA VISUAL " +
    "video dari contact sheet berikut (setiap sheet = 9 frame berurutan waktu, urutan kiri-kanan " +
    "atas-bawah). Konten/objek boleh disebut sekilas, tapi FOKUS pada gaya yang bisa ditiru kode.\n\n" +
    `Data objektif: durasi ${fmtTime(meta.durationSec)}, ${meta.width || "?"}x${meta.height || "?"} @${meta.fps || "?"}fps, ` +
    `${pacing.cuts} scene cut (≈${pacing.per10s} per 10 detik, rata-rata shot ${pacing.avgShotSec}s).\n` +
    (focus ? `Perhatian khusus dari user: ${focus}\n` : "") +
    "\nHasilkan analisis terstruktur dalam Bahasa Indonesia:\n" +
    "1. Format & orientasi (vertikal 9:16 / horizontal 16:9 / persegi)\n" +
    "2. Palet warna: 3-5 warna dominan dalam hex + perannya (latar/aksen/teks)\n" +
    "3. Layout & komposisi per frame (posisi judul, subjek, elemen dekoratif, grid)\n" +
    "4. Tipografi: gaya huruf, ketebalan, kapitalisasi, jenis teks overlay yang muncul\n" +
    "5. Motion & transisi yang tersirat dari perubahan antar-frame (cut keras, zoom, slide, fade, kinetic text)\n" +
    "6. Tempo & struktur: kaitkan dengan angka scene cut di atas (opening-hook-body-outro bila terlihat)\n" +
    "7. Mood & referensi estetika (mis. Y2K, korporat bersih, poster film, meme)\n" +
    "8. Rekomendasi implementasi Remotion: hook yang cocok (interpolate, spring, Sequence, Audio), " +
    "struktur scene, dan durasi ideal per scene — cukup arahan, bukan kode lengkap.\n\n" +
    "Ringkas namun konkret; setiap poin maksimal 3 kalimat."
  );
}

async function analyzeWithVision(sheets, meta, pacing, focus) {
  const client = getClient();
  if (!client) throw new Error("Client LLM tidak tersedia.");

  const buildContent = (sheetList) => {
    const parts = [{ type: "text", text: visionPrompt(meta, pacing, focus) }];
    for (const sheet of sheetList) {
      parts.push({ type: "image_url", image_url: { url: `data:image/jpeg;base64,${fs.readFileSync(sheet).toString("base64")}` } });
    }
    return [{ role: "user", content: parts }];
  };

  // Coba semua sheet sekali panggil; kalau API menolak multi-gambar, analisis satu per satu.
  try {
    const res = await client.chat.completions.create(
      { model: getConfig().model, messages: buildContent(sheets), stream: false },
      { timeout: 120_000 }
    );
    return { spec: res.choices[0]?.message?.content?.trim() || "", mode: "multi" };
  } catch (multiErr) {
    if (sheets.length < 2) throw multiErr;
  }

  const parts = [];
  for (const sheet of sheets) {
    try {
      const res = await client.chat.completions.create(
        { model: getConfig().model, messages: buildContent([sheet]), stream: false },
        { timeout: 120_000 }
      );
      parts.push(res.choices[0]?.message?.content?.trim() || "");
    } catch (err) {
      throw err; // model benar-benar tidak bisa melihat — laporkan apa adanya
    }
  }
  return { spec: parts.filter(Boolean).join("\n\n--- (lanjutan sheet berikutnya) ---\n\n"), mode: "single" };
}

// ============================================================
// TOOL
// ============================================================

/**
 * Tool: analyze_video_reference
 * @returns {Promise<string>} laporan analisis untuk model
 */
async function toolAnalyzeVideoReference({ video_path, focus, sessionId }) {
  if (!video_path || typeof video_path !== "string") {
    return "❌ Parameter 'video_path' wajib diisi (path video di workspace, mis. /workspace/uploads/ref.mp4).";
  }

  const guard = resolveFilePath(video_path, sessionId);
  if (!guard.ok) return `⛔ ${guard.error}`;
  const hostPath = guard.path;

  try {
    const st = fs.statSync(hostPath);
    if (!st.isFile()) return `❌ '${video_path}' bukan file video.`;
    if (st.size > MAX_INPUT_BYTES) return `❌ Video terlalu besar (${(st.size / 1024 / 1024).toFixed(0)} MB). Maksimal 200 MB.`;
  } catch {
    return `❌ File tidak ditemukan: ${video_path}`;
  }

  // 1. Metadata
  let meta;
  try {
    const probe = await run("ffprobe", ["-v", "error", "-print_format", "json", "-show_format", "-show_streams", hostPath], 20_000);
    meta = parseFfprobe(probe.stdout);
  } catch (err) {
    if (err.code === "ENOENT") return "❌ ffprobe tidak ditemukan di server (apt-get install -y ffmpeg di host).";
    return `❌ Gagal membaca metadata video: ${err.message}`;
  }
  if (!meta) return `❌ File '${video_path}' tidak bisa dibaca sebagai video oleh ffprobe.`;

  const windowSec = Math.min(meta.durationSec, ANALYZE_MAX_SECONDS);

  // 2. Scene cut (ritme)
  let cuts = [];
  try {
    const scene = await run(
      "ffmpeg",
      ["-hide_banner", "-nostats", "-t", String(windowSec), "-i", hostPath, "-vf", "select='gt(scene,0.3)',showinfo", "-an", "-f", "null", "-"],
      90_000
    );
    cuts = parseSceneCuts(scene.stderr);
  } catch (_) { /* ritme opsional — lanjut tanpa itu */ }
  const pacing = pacingStats(cuts, windowSec);

  // 3. Contact sheet (frame merata + frame momen scene change)
  const safeBase = path.basename(hostPath).replace(/\.[^.]+$/, "").replace(/[^a-zA-Z0-9_\-]/g, "_").slice(0, 40) || "referensi";
  const artifactsDir = path.join(getSessionWorkspace(sessionId), "artifacts");
  fs.mkdirSync(artifactsDir, { recursive: true });

  const sheets = [];
  const sheetTimes = [];
  try {
    const evenTimes = planFrameTimes(meta.durationSec, FRAMES_PER_SHEET, windowSec);
    const s1 = path.join(artifactsDir, `ref_${safeBase}_s1.jpg`);
    await extractSheet(hostPath, evenTimes, s1);
    sheets.push(s1);
    sheetTimes.push(evenTimes);

    if (cuts.length >= 3) {
      const sceneTimes = pickSceneFrames(cuts, FRAMES_PER_SHEET);
      const s2 = path.join(artifactsDir, `ref_${safeBase}_s2.jpg`);
      await extractSheet(hostPath, sceneTimes, s2);
      sheets.push(s2);
      sheetTimes.push(sceneTimes);
    } else {
      const restTimes = planFrameTimes(meta.durationSec, FRAMES_PER_SHEET * 2, windowSec).slice(FRAMES_PER_SHEET);
      const s2 = path.join(artifactsDir, `ref_${safeBase}_s2.jpg`);
      await extractSheet(hostPath, restTimes, s2);
      sheets.push(s2);
      sheetTimes.push(restTimes);
    }
  } catch (err) {
    return truncate(
      `⚠️ Metadata berhasil dibaca tapi ekstraksi frame gagal: ${err.message}\n` +
      `• Durasi ${fmtTime(meta.durationSec)}, ${meta.width || "?"}x${meta.height || "?"} @${meta.fps || "?"}fps (${meta.codec || "?"})\n` +
      `• Ritme cut: ${pacing.cuts} cut dalam ${fmtTime(windowSec)} (≈${pacing.per10s} per 10 detik, rata-rata shot ${pacing.avgShotSec}s)\n` +
      `Analisis visual tidak tersedia — minta user mendeskripsikan gaya yang diinginkan, atau coba lagi.`
    );
  }

  const sheetLines = sheets
    .map((s, i) => `• Sheet ${i + 1} (/workspace/artifacts/${path.basename(s)}): frame pada ${sheetTimes[i].map(fmtTime).join(", ")}`)
    .join("\n");

  // 4. Vision
  let specText = "";
  let visionNote = "";
  try {
    const { spec, mode } = await analyzeWithVision(sheets, meta, pacing, focus);
    specText = spec;
    if (mode === "single") visionNote = "(API tidak menerima multi-gambar — analisis dilakukan per sheet lalu digabung)";
  } catch (err) {
    visionNote = `(vision gagal: ${err.message})`;
  }

  if (!specText) {
    return truncate(
      `🎬 Analisis Video Referensi: ${path.basename(hostPath)}\n` +
      `• Durasi ${fmtTime(meta.durationSec)} (dianalisis ${fmtTime(windowSec)} pertama), ${meta.width || "?"}x${meta.height || "?"} @${meta.fps || "?"}fps (${meta.codec || "?"})\n` +
      `• Ritme cut: ${pacing.cuts} cut (≈${pacing.per10s} per 10 detik, rata-rata shot ${pacing.avgShotSec}s)\n` +
      sheetLines + `\n\n⚠️ Analisis visual (vision) tidak tersedia ${visionNote}.\n` +
      `Lanjutkan dengan data ritme di atas dan minta user mendeskripsikan gaya yang diinginkan.`
    );
  }

  return truncate(
    `🎬 Analisis Video Referensi: ${path.basename(hostPath)}\n` +
    `• Durasi ${fmtTime(meta.durationSec)} (dianalisis ${fmtTime(windowSec)} pertama), ${meta.width || "?"}x${meta.height || "?"} @${meta.fps || "?"}fps (${meta.codec || "?"})\n` +
    `• Ritme cut: ${pacing.cuts} cut (≈${pacing.per10s} per 10 detik, rata-rata shot ${pacing.avgShotSec}s)\n` +
    sheetLines + `\n${visionNote ? `\n${visionNote}\n` : ""}\n` +
    `=== SPEC GAYA VISUAL ===\n${specText}\n\n` +
    `Instruksi: gunakan spec ini untuk menulis kode render_remotion_video (durasi/rasio mengikuti analisis, ` +
    `kecuali user minta lain). Kirim sheet-nya ke user dengan send_photo bila membantu. ` +
    `Konfirmasi durasi/konten ke user dengan ask_user bila masih ambigu sebelum render.`
  );
}

module.exports = {
  toolAnalyzeVideoReference,
  // fungsi murni untuk unit test
  parseFfprobe,
  fmtTime,
  parseSceneCuts,
  pacingStats,
  planFrameTimes,
  pickSceneFrames,
  ANALYZE_MAX_SECONDS,
  FRAMES_PER_SHEET
};
