/**
 * tools/videoRef.js — Tool analyze_video_reference: "lihat" video referensi lalu
 * menghasilkan spec gaya visual untuk render_remotion_video.
 *
 * Model tidak bisa menonton video, jadi tool ini menjembatani:
 *   1. ffprobe  -> metadata (durasi, resolusi setelah rotasi, fps, codec)
 *   2. ffmpeg   -> deteksi scene cut (ritme potongan)
 *   3. ffmpeg   -> contact sheet (grid frame berurutan waktu, tanpa sel kosong)
 *   4. vision   -> analisis gaya dari contact sheet (palet, layout, tipografi, motion)
 *
 * Catatan eksekusi proses (pernah jadi sumber bug fatal):
 * - Semua pemanggilan memakai array argv (tanpa shell) dan stdin DITUTUP. ffmpeg yang
 *   menemukan file output sudah ada akan bertanya "Overwrite? [y/N]" lalu menunggu stdin
 *   selamanya; karena ffmpeg menangkap SIGTERM untuk shutdown rapi tapi terblokir di
 *   pembacaan stdin, opsi `timeout` execFile TIDAK bisa membunuhnya. Penangkalnya
 *   berlapis: `-y`, `-nostdin`, stdin `ignore`, dan killSignal SIGKILL.
 * - Input dibatasi protokol `file` saja, jadi file "video" yang sebenarnya playlist
 *   (HLS/concat) tidak bisa memaksa host mengambil URL internal.
 * - Input video divalidasi pathGuard (harus di workspace sesi), frame olahan di /tmp.
 */

const { execFile } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { resolveFilePath, truncate } = require("./common");
const { getSessionWorkspace } = require("../sandboxManager.js");
const { getClient, getConfig } = require("../bot/config");

const ANALYZE_MAX_SECONDS = Number(process.env.VIDEO_REF_MAX_SECONDS) || 120;
const VISION_TIMEOUT_MS = Number(process.env.VIDEO_REF_VISION_TIMEOUT_MS) || 120_000;
const MAX_REPORT_CHARS = Number(process.env.VIDEO_REF_MAX_REPORT_CHARS) || 8000;
const FRAMES_PER_SHEET = 9;
const MIN_SECONDS_PER_FRAME = 0.4;
const MAX_INPUT_BYTES = 200 * 1024 * 1024;
const VIDEO_EXTS = new Set([
  ".mp4", ".mov", ".mkv", ".webm", ".m4v", ".avi", ".mpg", ".mpeg", ".ts", ".m2ts",
  ".3gp", ".flv", ".wmv", ".ogv", ".gif"
]);

/** Input ffmpeg/ffprobe dibatasi file lokal: playlist tidak boleh menarik URL. */
const INPUT_GUARD = ["-protocol_whitelist", "file,crypto,data"];

// ============================================================
// FUNGSI MURNI (diuji di test/videoRef.test.js)
// ============================================================

const round2 = (n) => Math.round(n * 100) / 100;

/**
 * Derajat rotasi tampilan sebuah stream video (0/90/180/270).
 * ffprobe menaruhnya di side_data_list[].rotation (bisa negatif) atau tags.rotate.
 */
function rotationOf(stream = {}) {
  let rot = NaN;
  const list = Array.isArray(stream.side_data_list) ? stream.side_data_list : [];
  const sd = list.find((s) => s && s.rotation !== undefined && s.rotation !== null);
  if (sd) rot = Number(sd.rotation);
  if (!Number.isFinite(rot) && stream.tags) {
    rot = Number(stream.tags.rotate ?? stream.tags.ROTATE);
  }
  if (!Number.isFinite(rot)) return 0;
  return ((Math.round(rot) % 360) + 360) % 360;
}

/** "vertikal 9:16" / "horizontal 16:9" / "persegi 1:1" dari dimensi tampilan. */
function orientationLabel(width, height) {
  if (!width || !height) return "tidak diketahui";
  const ratio = width / height;
  if (ratio > 1.05) return `horizontal (${round2(ratio)}:1, mis. 16:9)`;
  if (ratio < 0.95) return `vertikal (1:${round2(height / width)}, mis. 9:16)`;
  return "persegi (1:1)";
}

/**
 * Parse output `ffprobe -print_format json`. Null jika tidak valid atau tidak ada stream video.
 * Dimensi yang dikembalikan adalah dimensi TAMPILAN: untuk video HP yang tersimpan
 * landscape + rotasi 90 derajat, width/height ditukar supaya cocok dengan frame yang
 * benar-benar dihasilkan ffmpeg (ffmpeg autorotate saat decode).
 */
function parseFfprobe(jsonStr) {
  let data;
  try {
    data = JSON.parse(String(jsonStr));
  } catch {
    return null;
  }
  const v = (data.streams || []).find((s) => s && s.codec_type === "video");
  if (!v) return null; // file audio-only / bukan video
  const durationSec = Number(data.format?.duration ?? v.duration);
  if (!Number.isFinite(durationSec) || durationSec <= 0) return null;

  let fps = NaN;
  const rate = String(v.avg_frame_rate || v.r_frame_rate || "");
  const m = rate.match(/^(\d+(?:\.\d+)?)\/(\d+(?:\.\d+)?)$/);
  if (m) fps = Number(m[1]) / Number(m[2]);
  if (!Number.isFinite(fps) || fps <= 0) fps = null;

  let width = Number(v.width) || null;
  let height = Number(v.height) || null;
  const rotation = rotationOf(v);
  const swapped = (rotation === 90 || rotation === 270) && width && height;
  if (swapped) [width, height] = [height, width];

  return {
    durationSec,
    width,
    height,
    fps: fps ? round2(fps) : null,
    codec: v.codec_name || null,
    rotation,
    rotated: Boolean(swapped)
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
    avgShotSec: windowSec > 0 ? round2(windowSec / (count + 1)) : 0
  };
}

/**
 * Jumlah frame yang layak diambil: video sangat pendek tidak perlu 9 frame yang
 * isinya gambar sama (0,4 s dulu menghasilkan 9 frame identik).
 */
function frameCountFor(windowSec, max = FRAMES_PER_SHEET) {
  const n = Math.floor((Number(windowSec) || 0) / MIN_SECONDS_PER_FRAME);
  return Math.max(1, Math.min(max, n));
}

/** `count` waktu frame merata di dalam window (tidak menyentuh 0 dan akhir persis). */
function planFrameTimes(durationSec, count, maxAnalyzeSec) {
  const window = Math.max(0.2, Math.min(Number(durationSec) || 0, Number(maxAnalyzeSec) || durationSec));
  const n = Math.max(1, Number(count) || 1);
  const times = [];
  for (let i = 1; i <= n; i++) {
    let t = (window * i) / (n + 1);
    t = Math.min(Math.max(t, 0), Math.max(0, window - 0.05));
    times.push(round2(t));
  }
  return times;
}

/** Pilih sampel waktu yang merata dari sebuah daftar (semua kalau sudah cukup sedikit). */
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

/**
 * Waktu TENGAH setiap shot, bukan titik cut-nya.
 *
 * Dulu frame diambil persis di timestamp cut, sehingga (a) shot pembuka tidak pernah
 * terwakili — cut adalah titik PERUBAHAN, jadi shot pertama tidak punya cut — dan
 * (b) frame sering kena blur transisi. Batas shot = [0, ...cuts, akhir window].
 */
function planShotFrames(cuts, windowSec, count = FRAMES_PER_SHEET) {
  const w = Math.max(0, Number(windowSec) || 0);
  const inside = (Array.isArray(cuts) ? cuts : [])
    .filter((t) => Number.isFinite(t) && t > 0 && t < w)
    .sort((a, b) => a - b);
  const bounds = [0, ...inside, w];
  const mids = [];
  for (let i = 0; i < bounds.length - 1; i++) {
    const len = bounds[i + 1] - bounds[i];
    if (len <= 0.12) continue; // shot terlalu pendek untuk diambil frame bersih
    mids.push(round2(bounds[i] + len / 2));
  }
  return pickSceneFrames(mids, count);
}

/** Grid contact sheet yang pas untuk n frame, supaya tidak ada sel hitam kosong. */
function tileLayout(n) {
  const count = Math.max(1, Math.floor(Number(n) || 1));
  const cols = count <= 1 ? 1 : count <= 4 ? 2 : 3;
  return { cols, rows: Math.ceil(count / cols) };
}

// ============================================================
// EKSEKUSI HOST
// ============================================================

function run(cmd, args, timeoutMs, maxBuffer = 8 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    execFile(
      cmd,
      args,
      {
        timeout: timeoutMs,
        maxBuffer,
        encoding: "utf8",
        // stdin ditutup: ffmpeg tidak boleh menunggu jawaban prompt apa pun.
        stdio: ["ignore", "pipe", "pipe"],
        // ffmpeg menangkap SIGTERM; kalau sampai macet, SIGKILL yang menyelesaikan.
        killSignal: "SIGKILL"
      },
      (err, stdout, stderr) => {
        if (err) {
          err.stderr = String(stderr || "");
          return reject(err);
        }
        resolve({ stdout: String(stdout || ""), stderr: String(stderr || "") });
      }
    );
  });
}

async function extractFrame(hostPath, t, outPath) {
  await run(
    "ffmpeg",
    [
      "-hide_banner", "-nostdin", "-y", "-loglevel", "error",
      "-ss", String(t),
      ...INPUT_GUARD, "-i", hostPath,
      "-frames:v", "1", "-q:v", "3",
      outPath
    ],
    20_000
  );
}

/** n frame di dir -> contact sheet dengan grid yang pas (tanpa sel kosong). */
async function buildSheet(frameDir, sheetPath, frameCount) {
  const { cols, rows } = tileLayout(frameCount);
  await run(
    "ffmpeg",
    [
      "-hide_banner", "-nostdin", "-y", "-loglevel", "error",
      "-framerate", "1", "-start_number", "1",
      ...INPUT_GUARD, "-i", path.join(frameDir, "f%02d.jpg"),
      "-vf", `scale=480:-2,tile=${cols}x${rows}`,
      "-frames:v", "1",
      sheetPath
    ],
    30_000
  );
  return { cols, rows };
}

async function extractSheet(hostPath, times, sheetPath) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nrozvid_"));
  try {
    let written = 0;
    for (let i = 0; i < times.length; i++) {
      const out = path.join(dir, `f${String(written + 1).padStart(2, "0")}.jpg`);
      try {
        await extractFrame(hostPath, times[i], out);
      } catch (err) {
        continue; // frame gagal (mis. seek di ujung video) — lanjutkan dengan sisanya
      }
      // image2 butuh nomor berurutan tanpa bolong, jadi hanya hitung yang benar-benar ada.
      if (fs.existsSync(out) && fs.statSync(out).size > 0) written++;
    }
    if (written === 0) throw new Error("tidak ada frame yang berhasil diekstrak");
    const grid = await buildSheet(dir, sheetPath, written);
    return { frames: written, ...grid };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// ============================================================
// VISION
// ============================================================

function visionPrompt(meta, pacing, focus, sheetInfo) {
  const sheetDesc = sheetInfo
    .map(
      (s, i) =>
        `Sheet ${i + 1}: grid ${s.cols}x${s.rows}, ${s.frames} frame, urut kiri-kanan atas-bawah, ` +
        `waktu ${s.times.slice(0, s.frames).map(fmtTime).join(", ")}${s.kind === "shot" ? " (tengah tiap shot)" : " (merata sepanjang video)"}`
    )
    .join("\n");

  return (
    "Kamu adalah creative director sekaligus creative technologist Remotion. Analisis GAYA VISUAL " +
    "video dari contact sheet berikut. Konten/objek boleh disebut sekilas, tapi FOKUS pada gaya " +
    "yang bisa ditiru kode.\n\n" +
    `Data objektif: durasi ${fmtTime(meta.durationSec)}, ${meta.width || "?"}x${meta.height || "?"} ` +
    `@${meta.fps || "?"}fps, orientasi ${orientationLabel(meta.width, meta.height)}` +
    (meta.rotated ? ` (metadata rotasi ${meta.rotation}°, dimensi sudah dikoreksi)` : "") +
    `, ${pacing.cuts} scene cut (≈${pacing.per10s} per 10 detik, rata-rata shot ${pacing.avgShotSec}s).\n` +
    `${sheetDesc}\n` +
    "Orientasi di atas sudah terverifikasi dari frame nyata — pakai itu, jangan menebak dari bentuk grid.\n" +
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
    "Ringkas namun konkret; setiap poin maksimal 3 kalimat. Jangan mengarang detail yang tidak terlihat."
  );
}

/** Error dari API yang berarti "request ini memang ditolak", bukan gangguan sementara. */
function isClientError(err) {
  const status = Number(err?.status);
  return Number.isFinite(status) && status >= 400 && status < 500;
}

async function analyzeWithVision(sheets, meta, pacing, focus, sheetInfo) {
  const client = getClient();
  if (!client) throw new Error("Client LLM tidak tersedia.");

  const buildContent = (sheetList, infoList) => {
    const parts = [{ type: "text", text: visionPrompt(meta, pacing, focus, infoList) }];
    for (const sheet of sheetList) {
      parts.push({
        type: "image_url",
        image_url: { url: `data:image/jpeg;base64,${fs.readFileSync(sheet).toString("base64")}` }
      });
    }
    return [{ role: "user", content: parts }];
  };

  // maxRetries 0: default SDK adalah 2 (3 percobaan), jadi satu timeout 120 s bisa
  // jadi 6 menit dan menahan antrean sesi. Di sini lebih baik gagal cepat.
  const ask = (sheetList, infoList) =>
    client.chat.completions.create(
      { model: getConfig().model, messages: buildContent(sheetList, infoList), stream: false },
      { timeout: VISION_TIMEOUT_MS, maxRetries: 0 }
    );

  // Coba semua sheet sekali panggil.
  try {
    const res = await ask(sheets, sheetInfo);
    return { spec: res.choices[0]?.message?.content?.trim() || "", mode: "multi" };
  } catch (multiErr) {
    // Fallback per sheet hanya berguna kalau API MENOLAK requestnya (mis. multi-gambar
    // tidak didukung). Untuk timeout/5xx, mengulang 2x lagi cuma memperpanjang blokade.
    if (sheets.length < 2 || !isClientError(multiErr)) throw multiErr;
  }

  const parts = [];
  for (let i = 0; i < sheets.length; i++) {
    const res = await ask([sheets[i]], [sheetInfo[i]]);
    parts.push(res.choices[0]?.message?.content?.trim() || "");
  }
  return {
    spec: parts.filter(Boolean).join("\n\n--- (lanjutan sheet berikutnya) ---\n\n"),
    mode: "single"
  };
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

  const ext = path.extname(hostPath).toLowerCase();
  if (!VIDEO_EXTS.has(ext)) {
    return (
      `❌ '${path.basename(hostPath)}' bukan berkas video yang dikenali (ekstensi '${ext || "tanpa ekstensi"}').\n` +
      `Didukung: ${[...VIDEO_EXTS].join(", ")}. Kalau ini memang video, ganti namanya dengan ekstensi yang benar.`
    );
  }

  try {
    const st = fs.lstatSync(hostPath);
    if (st.isSymbolicLink()) return `⛔ '${video_path}' adalah symlink — tidak diproses.`;
    if (!st.isFile()) return `❌ '${video_path}' bukan file video.`;
    if (st.size > MAX_INPUT_BYTES) {
      return `❌ Video terlalu besar (${(st.size / 1024 / 1024).toFixed(0)} MB). Maksimal 200 MB.`;
    }
  } catch {
    return `❌ File tidak ditemukan: ${video_path}`;
  }

  // 1. Metadata
  let meta;
  try {
    const probe = await run(
      "ffprobe",
      ["-v", "error", "-print_format", "json", "-show_format", "-show_streams", ...INPUT_GUARD, hostPath],
      20_000
    );
    meta = parseFfprobe(probe.stdout);
  } catch (err) {
    if (err.code === "ENOENT") return "❌ ffprobe tidak ditemukan di server (apt-get install -y ffmpeg di host).";
    return `❌ Gagal membaca metadata video: ${err.message}`;
  }
  if (!meta) {
    return (
      `❌ File '${video_path}' tidak punya stream video yang bisa dibaca ffprobe ` +
      `(mungkin file audio saja, rusak, atau sebenarnya bukan video).`
    );
  }

  const windowSec = Math.min(meta.durationSec, ANALYZE_MAX_SECONDS);

  // 2. Scene cut (ritme)
  let cuts = [];
  let pacingNote = "";
  try {
    const scene = await run(
      "ffmpeg",
      [
        "-hide_banner", "-nostdin", "-nostats",
        "-t", String(windowSec),
        ...INPUT_GUARD, "-i", hostPath,
        "-vf", "select='gt(scene,0.3)',showinfo", "-an", "-f", "null", "-"
      ],
      90_000
    );
    cuts = parseSceneCuts(scene.stderr);
  } catch (err) {
    pacingNote = " (deteksi cut gagal/timeout — angka ritme tidak dapat dipercaya)";
  }
  const pacing = pacingStats(cuts, windowSec);

  // 3. Contact sheet. Disimpan di artifacts/refsheets/ supaya tidak ikut terkirim
  //    otomatis oleh findRecentImage() di bot/fileDelivery.js sebagai "hasil akhir".
  const safeBase =
    path.basename(hostPath).replace(/\.[^.]+$/, "").replace(/[^a-zA-Z0-9_\-]/g, "_").slice(0, 40) || "referensi";
  const sheetsDir = path.join(getSessionWorkspace(sessionId), "artifacts", "refsheets");
  fs.mkdirSync(sheetsDir, { recursive: true });

  const sheets = [];
  const sheetInfo = [];
  try {
    const evenCount = frameCountFor(windowSec);
    const evenTimes = planFrameTimes(meta.durationSec, evenCount, windowSec);
    const s1 = path.join(sheetsDir, `ref_${safeBase}_s1.jpg`);
    const r1 = await extractSheet(hostPath, evenTimes, s1);
    sheets.push(s1);
    sheetInfo.push({ times: evenTimes, kind: "even", ...r1 });

    // Sheet kedua hanya kalau ada cut: frame diambil di TENGAH tiap shot (termasuk shot
    // pembuka). Tanpa cut, sheet kedua dulu cuma mengulang paruh akhir video.
    const shotTimes = planShotFrames(cuts, windowSec);
    if (cuts.length >= 1 && shotTimes.length >= 2) {
      const s2 = path.join(sheetsDir, `ref_${safeBase}_s2.jpg`);
      const r2 = await extractSheet(hostPath, shotTimes, s2);
      sheets.push(s2);
      sheetInfo.push({ times: shotTimes, kind: "shot", ...r2 });
    }
  } catch (err) {
    return truncate(
      `⚠️ Metadata berhasil dibaca tapi ekstraksi frame gagal: ${err.message}\n` +
        `• Durasi ${fmtTime(meta.durationSec)}, ${meta.width || "?"}x${meta.height || "?"} @${meta.fps || "?"}fps (${meta.codec || "?"})\n` +
        `• Orientasi: ${orientationLabel(meta.width, meta.height)}\n` +
        `• Ritme cut: ${pacing.cuts} cut dalam ${fmtTime(windowSec)} (≈${pacing.per10s} per 10 detik, rata-rata shot ${pacing.avgShotSec}s)${pacingNote}\n` +
        `Analisis visual tidak tersedia — minta user mendeskripsikan gaya yang diinginkan, atau coba lagi.`,
      MAX_REPORT_CHARS
    );
  }

  const sheetLines = sheets
    .map((s, i) => {
      const info = sheetInfo[i];
      const label = info.kind === "shot" ? "tengah tiap shot" : "merata";
      return (
        `• Sheet ${i + 1} (/workspace/artifacts/refsheets/${path.basename(s)}): ` +
        `grid ${info.cols}x${info.rows}, ${info.frames} frame ${label} pada ` +
        `${info.times.slice(0, info.frames).map(fmtTime).join(", ")}`
      );
    })
    .join("\n");

  const header =
    `🎬 Analisis Video Referensi: ${path.basename(hostPath)}\n` +
    `• Durasi ${fmtTime(meta.durationSec)} (dianalisis ${fmtTime(windowSec)} pertama), ` +
    `${meta.width || "?"}x${meta.height || "?"} @${meta.fps || "?"}fps (${meta.codec || "?"})\n` +
    `• Orientasi: ${orientationLabel(meta.width, meta.height)}` +
    (meta.rotated ? ` — metadata menyimpannya terotasi ${meta.rotation}°, dimensi sudah dikoreksi\n` : "\n") +
    `• Ritme cut: ${pacing.cuts} cut (≈${pacing.per10s} per 10 detik, rata-rata shot ${pacing.avgShotSec}s)${pacingNote}\n` +
    sheetLines;

  // 4. Vision
  let specText = "";
  let visionNote = "";
  try {
    const { spec, mode } = await analyzeWithVision(sheets, meta, pacing, focus, sheetInfo);
    specText = spec;
    if (mode === "single") visionNote = "(API tidak menerima multi-gambar — analisis dilakukan per sheet lalu digabung)";
  } catch (err) {
    visionNote = `(vision gagal: ${err.message})`;
  }

  if (!specText) {
    return truncate(
      `${header}\n\n⚠️ Analisis visual (vision) tidak tersedia ${visionNote}.\n` +
        `Lanjutkan dengan data ritme/orientasi di atas dan minta user mendeskripsikan gaya yang diinginkan.`,
      MAX_REPORT_CHARS
    );
  }

  return truncate(
    `${header}\n${visionNote ? `\n${visionNote}\n` : ""}\n` +
      `=== SPEC GAYA VISUAL ===\n${specText}\n\n` +
      `Instruksi: gunakan spec ini untuk menulis kode render_remotion_video. Orientasi/rasio ikuti ` +
      `baris "Orientasi" di atas (sudah diverifikasi dari frame nyata), tempo ikuti ritme cut, ` +
      `kecuali user minta lain. Kirim sheet-nya ke user dengan send_photo bila membantu. ` +
      `Konfirmasi durasi/konten ke user dengan ask_user bila masih ambigu sebelum render.`,
    MAX_REPORT_CHARS
  );
}

module.exports = {
  toolAnalyzeVideoReference,
  // dipakai test regresi dengan ffmpeg nyata
  extractSheet,
  // fungsi murni untuk unit test
  parseFfprobe,
  rotationOf,
  orientationLabel,
  fmtTime,
  parseSceneCuts,
  pacingStats,
  frameCountFor,
  planFrameTimes,
  pickSceneFrames,
  planShotFrames,
  tileLayout,
  isClientError,
  ANALYZE_MAX_SECONDS,
  FRAMES_PER_SHEET
};
