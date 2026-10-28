/**
 * remotionManager.js — Pengelola Pembuatan Video Dinamis dengan Remotion (React Video)
 *
 * Fitur:
 * - Menerima kode React/Remotion dari AI Agent.
 * - Mendukung Voiceover Suara Manusia Alami (TTS via Edge Neural Voices).
 * - Mendukung audio kustom (BGM atau rekaman suara user).
 * - Parser cerdas: mendukung export const, export function, export default, atau function murni.
 * - Ekstraksi otomatis ID Komposisi (anti-error 'No composition found').
 * - Melakukan bundling & rendering ke video MP4 menggunakan Chrome Headless Shell & FFmpeg.
 * - Render berjalan di antrean latar belakang (satu job aktif), video disimpan di workspace user.
 */

const { execFile, spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const { generateSpeech, generateNarration } = require("./ttsManager.js");

const REMOTION_DIR = path.join(__dirname, "remotion-engine");
const REMOTION_PUBLIC = path.join(REMOTION_DIR, "public");
const WORKSPACE_BASE = path.join(__dirname, "workspace");

// Batas durasi render. Dulu dipatok 60 detik sehingga video panjang dipotong diam-diam;
// sekarang 15 menit karena render berjalan di antrean latar belakang.
const MAX_RENDER_SECONDS = Number(process.env.REMOTION_MAX_RENDER_SECONDS) || 900;

// Label tahap render untuk pesan ke user dan laporan error; sumber tunggal agar konsisten.
const STAGE_LABEL = {
  preparing: "persiapan",
  bundling: "menyusun bundel",
  rendering: "merender frame",
  stitching: "menggabungkan video",
  done: "selesai"
};

function clampDurationFps(durationSeconds, fps) {
  const durSec = Math.max(1, Math.min(Number(durationSeconds) || 5, MAX_RENDER_SECONDS));
  const safeFps = Math.max(15, Math.min(Number(fps) || 30, 60));
  return { durSec, safeFps, frames: Math.round(durSec * safeFps) };
}

/** Durasi file video lewat ffprobe; 0 kalau file tidak ada, rusak, atau belum selesai ditulis. */
function probeVideoDuration(filePath) {
  return new Promise((resolve) => {
    if (!filePath || !fs.existsSync(filePath)) return resolve(0);
    execFile(
      "ffprobe",
      ["-v", "error", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", filePath],
      (err, out) => resolve(err ? 0 : parseFloat(String(out).trim()) || 0)
    );
  });
}

/** /workspace/<file> = file di workspace sesi; tool lain sudah memetakan ini, render tidak boleh kalah. */
function resolveWorkspacePath(p, userWs) {
  const clean = String(p).trim();
  if (clean === "/workspace" || clean.startsWith("/workspace/")) {
    return path.join(userWs, clean.slice("/workspace".length));
  }
  return clean;
}

/**
 * Server Remotion hanya melayani remotion-engine/public, jadi aset yang dibuat model
 * di /workspace akan 404 di tengah render. Disalin ke public sebelum render dimulai.
 * @returns {{copied: string[], missing: string[]}}
 */
function stageStaticAssets(code, userWs) {
  const copied = [];
  const missing = [];
  const names = new Set();
  const re = /staticFile\(\s*["'`]([^"'`]+)["'`]\s*\)/g;
  let match;
  while ((match = re.exec(code))) names.add(match[1]);

  for (const rawName of names) {
    const name = rawName.replace(/^\/+/, "");
    if (!name || name.includes("..") || path.isAbsolute(name)) {
      missing.push(rawName);
      continue;
    }
    const dest = path.join(REMOTION_PUBLIC, name);
    if (fs.existsSync(dest)) continue;
    const src = path.join(userWs, name);
    if (fs.existsSync(src) && fs.statSync(src).isFile()) {
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.copyFileSync(src, dest);
      copied.push(dest);
    } else {
      missing.push(rawName);
    }
  }
  return { copied, missing };
}

if (!fs.existsSync(REMOTION_PUBLIC)) {
  fs.mkdirSync(REMOTION_PUBLIC, { recursive: true });
}

/**
 * Sanitasi interpolate() ranges dalam kode AI-generated.
 * Remotion mengharuskan inputRange strictly monotonically increasing.
 * AI sering menghasilkan [1, 0] — kita balik otomatis dan reverse outputRange.
 */
function sanitizeInterpolateRanges(src) {
  const re = /interpolate\s*\(\s*([^,]+),\s*\[\s*([\d.]+)\s*,\s*([\d.]+)\s*\]\s*,\s*\[\s*([^\]]+)\]/g;
  return src.replace(re, (match, frame, a, b, outputInner) => {
    const numA = parseFloat(a);
    const numB = parseFloat(b);
    if (numA > numB) {
      const outputs = outputInner.split(",").map((s) => s.trim());
      const reversed = outputs.reverse().join(", ");
      console.log("[Remotion Sanitize] Fixed interpolate inputRange [" + a + ", " + b + "] -> [" + b + ", " + a + "]");
      return "interpolate(" + frame + ", [" + b + ", " + a + "], [" + reversed + "]";
    }
    return match;
  });
}

/**
 * Strip referensi ke audio/media asset yang tidak ada dari kode.
 * AI sering membuat staticFile("something.mp3") tapi file tidak ada.
 */
function stripMissingAssetRefs(src, missingNames) {
  let result = src;
  for (const name of missingNames) {
    // Simple string-based replacement: remove lines containing staticFile("missingName")
    const lines = result.split("\n");
    const filtered = lines.filter((line) => {
      if (line.includes("staticFile") && line.includes(name)) {
        console.log("[Remotion Sanitize] Stripped missing asset ref: " + name);
        return false;
      }
      return true;
    });
    result = filtered.join("\n");
  }
  return result;
}


/**
 * Render video dari kode React/Remotion
 * @param {Object} options
 * @param {string} options.code - Kode sumber React Component / Composition
 * @param {number} [options.durationSeconds=5] - Durasi dalam detik
 * @param {number} [options.fps=30] - Frame per second (default: 30)
 * @param {number} [options.width=1080] - Lebar video (default: 1080)
 * @param {number} [options.height=1920] - Tinggi video (default: 1920)
 * @param {string} [options.title] - Judul / nama file video
 * @param {string} [options.sessionId="default"] - ID sesi user
 * @param {string} [options.tts_text] - Teks naskah suara manusia yang ingin diucapkan di video
 * @param {Array<{text: string, voice?: string}>} [options.tts_lines] - Naskah multi-suara; tiap baris dirender lalu digabung jadi satu voiceover
 * @param {string} [options.tts_voice="id-ID-ArdiNeural"] - Pilihan suara AI ("id-male", "id-female", "en-male", "en-female")
 * @param {string} [options.audio_path] - Path file audio MP3/WAV kustom yang ingin dimasukkan ke video
 * @param {Function} [options.onProgress] - Dipakai internal antrean: dipanggil dengan { stage, percent, rendered, total, remainingText }
 * @returns {Promise<{ success: boolean, videoPath?: string, error?: string, duration?: number, sizeMb?: string, elapsedSec?: string }>}
 */
async function runRender({
  code,
  durationSeconds = 5,
  fps = 30,
  width = 1080,
  height = 1920,
  title,
  sessionId = "default",
  tts_text,
  tts_lines,
  tts_voice = "id-ID-ArdiNeural",
  audio_path,
  onProgress,
  onMeta
}) {
  const safeSession = String(sessionId).replace(/[^a-zA-Z0-9_\-]/g, "_");
  const userWs = path.join(WORKSPACE_BASE, safeSession);
  if (!fs.existsSync(userWs)) fs.mkdirSync(userWs, { recursive: true });

  const timestamp = Date.now();
  const safeTitle = (title || "video")
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, "_")
    .slice(0, 30);
  const outputFileName = `${safeTitle}_${timestamp}.mp4`;
  const outputFilePath = path.join(userWs, outputFileName);

  // Buat direktori sementara untuk build komponen
  const renderTempDir = path.join(REMOTION_DIR, "renders", `render_${timestamp}`);
  if (!fs.existsSync(renderTempDir)) fs.mkdirSync(renderTempDir, { recursive: true });

  const rootFile = path.join(renderTempDir, "Root.tsx");
  const compFile = path.join(renderTempDir, "Component.tsx");

  let attachedAudioName = null;
  let audioPublicPath = null;
  let narrationSegments = 0;
  let narrationTimings = null;
  let stagedAssets = [];
  let rescuedNote = null;
  let calculatedDuration = Number(durationSeconds) || 5;

  try {
    // 1. Tangani Audio / Voiceover TTS jika diminta
    if (Array.isArray(tts_lines) && tts_lines.length) {
      attachedAudioName = `audio_${timestamp}.mp3`;
      audioPublicPath = path.join(REMOTION_PUBLIC, attachedAudioName);
      console.log(`[Remotion TTS] Merangkai ${tts_lines.length} baris naskah menjadi satu voiceover...`);
      const narrRes = await generateNarration(tts_lines, { outputPath: audioPublicPath, voice: tts_voice });
      narrationSegments = narrRes.segments;
      narrationTimings = narrRes.timings || [];
      console.log(`[Remotion TTS] Voiceover ${narrRes.segments} segmen, ${narrRes.durationSec}s, ${narrationTimings.reduce((n, t) => n + t.words.length, 0)} word cue.`);
      if (narrRes.durationSec) {
        calculatedDuration = Math.max(calculatedDuration, narrRes.durationSec + 1);
      }
    } else if (tts_text && tts_text.trim()) {
      attachedAudioName = `audio_${timestamp}.mp3`;
      audioPublicPath = path.join(REMOTION_PUBLIC, attachedAudioName);
      console.log(`[Remotion TTS] Menghasilkan suara untuk teks: "${tts_text.slice(0, 50)}..."`);
      const speechRes = await generateSpeech(tts_text, { voice: tts_voice, outputPath: audioPublicPath });
      if (speechRes && speechRes.durationSec) {
        // Sesuaikan durasi video minimal sama dengan panjang audio
        calculatedDuration = Math.max(calculatedDuration, speechRes.durationSec + 1);
      }
    } else if (audio_path) {
      const srcAudio = resolveWorkspacePath(audio_path, userWs);
      if (!fs.existsSync(srcAudio) || !fs.statSync(srcAudio).isFile()) {
        throw new Error(
          `audio_path "${audio_path}" tidak ditemukan. Simpan filenya ke /workspace/${path.basename(srcAudio)} ` +
          `lewat run_command/file_write dengan nama persis, atau biarkan sistem membuat suaranya lewat tts_text.`
        );
      }
      attachedAudioName = `audio_${timestamp}${path.extname(srcAudio) || ".mp3"}`;
      audioPublicPath = path.join(REMOTION_PUBLIC, attachedAudioName);
      fs.copyFileSync(srcAudio, audioPublicPath);
      // Ukur durasi audio menggunakan ffprobe
      try {
        const dur = await new Promise((res) => {
          execFile("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", audioPublicPath], (err, out) => {
            res(err ? 0 : parseFloat(out.trim()) || 0);
          });
        });
        if (dur > 0) calculatedDuration = Math.max(calculatedDuration, Math.ceil(dur));
      } catch (_) {}
    }

    const { durSec, safeFps, frames: totalFrames } = clampDurationFps(calculatedDuration, fps);
    const w = Number(width) || 1080;
    const h = Number(height) || 1920;

    // Voiceover bisa memanjangkan video jauh di atas durationSeconds yang diminta.
    // Antrean harus tahu angka sebenarnya supaya estimasi dan progres tidak bohong.
    try { onMeta?.({ durationSeconds: durSec, frames: totalFrames, fps: safeFps }); } catch (_) {}

    // 2. Simpan dan format kode React komponen
    let cleanCode = (code || "").trim();
    cleanCode = cleanCode.replace(/^```(?:tsx|jsx|typescript|javascript|react)?\s*/i, "");
    cleanCode = cleanCode.replace(/```\s*$/i, "");

    // 2a. Sanitasi interpolate() ranges — AI sering menghasilkan range terbalik
    // seperti [1, 0] yang menyebabkan crash. Perbaiki otomatis.
    cleanCode = sanitizeInterpolateRanges(cleanCode);

    // 2b. Siapkan aset staticFile(...) dari workspace sesi + gagal cepat kalau ada yang hilang,
    // supaya tidak berakhir sebagai 404 di tengah render.
    const staged = stageStaticAssets(cleanCode, userWs);
    stagedAssets = staged.copied;
    if (staged.copied.length) {
      console.log(`[Remotion Assets] ${staged.copied.length} file disalin dari workspace sesi ke public/.`);
    }
    if (staged.missing.length) {
      console.warn("[Remotion Assets] ⚠️ Asset tidak ditemukan: " + staged.missing.join(", ") + " — referensi dihapus dari kode.");
      // Strip missing asset references instead of crashing the render
      cleanCode = stripMissingAssetRefs(cleanCode, staged.missing);
    }

    const hasRegisterRoot = /registerRoot\s*\(/i.test(cleanCode) && /<Composition/i.test(cleanCode);
    let compId = "DynamicVideo";

    if (hasRegisterRoot) {
      // Ekstrak ID komposisi dari kode pengguna jika ada
      const matchId = cleanCode.match(/<Composition\s+[^>]*id=["']([^"']+)["']/i);
      if (matchId && matchId[1]) {
        compId = matchId[1];
      } else {
        compId = "MyVideo";
      }
      fs.writeFileSync(rootFile, cleanCode, "utf-8");
    } else {
      let compName = "VideoComponent";
      let wrappedComponentCode = cleanCode;
      const codeTail = cleanCode.trim();

      if (/export\s+(?:const|function|var|let)\s+([a-zA-Z0-9_]+)/.test(cleanCode)) {
        const match = cleanCode.match(/export\s+(?:const|function|var|let)\s+([a-zA-Z0-9_]+)/);
        compName = match[1];
      } else if (/export\s+default\s+function\s+([a-zA-Z0-9_]+)/.test(cleanCode)) {
        const match = cleanCode.match(/export\s+default\s+function\s+([a-zA-Z0-9_]+)/);
        compName = match[1];
        wrappedComponentCode = cleanCode.replace(/export\s+default\s+function/, "export function");
      } else if (/export\s+default\s+([a-zA-Z_][a-zA-Z0-9_]*)\s*;?\s*$/.test(codeTail)) {
        compName = codeTail.match(/export\s+default\s+([a-zA-Z_][a-zA-Z0-9_]*)\s*;?\s*$/)[1];
        wrappedComponentCode = `${cleanCode}\nexport { ${compName} };`;
      } else if (/export\s+default/.test(cleanCode)) {
        wrappedComponentCode = cleanCode.replace(/export\s+default/, `export const ${compName} =`);
      } else if (/function\s+([A-Z][a-zA-Z0-9_]*)/.test(cleanCode)) {
        const match = cleanCode.match(/function\s+([A-Z][a-zA-Z0-9_]*)/);
        compName = match[1];
        wrappedComponentCode = `${cleanCode}\nexport { ${compName} };`;
      } else if (/const\s+([A-Z][a-zA-Z0-9_]*)\s*=/.test(cleanCode)) {
        const match = cleanCode.match(/const\s+([A-Z][a-zA-Z0-9_]*)\s*=/);
        compName = match[1];
        wrappedComponentCode = `${cleanCode}\nexport { ${compName} };`;
      } else {
        wrappedComponentCode = `${cleanCode}\nexport const ${compName} = typeof Main !== "undefined" ? Main : (typeof Video !== "undefined" ? Video : () => null);`;
      }

      fs.writeFileSync(compFile, wrappedComponentCode, "utf-8");

      // Cek apakah kode komponen sudah menggunakan <Audio
      const codeHasAudio = /<Audio\b/.test(cleanCode);

      // Buat file Root.tsx yang mendaftarkan Composition
      let rootContent = "";
      if (attachedAudioName && !codeHasAudio) {
        // Otomatis pasangkan audio ke dalam composition
        rootContent = `
import { registerRoot, Composition, Audio, staticFile } from "remotion";
import React from "react";
import { ${compName} } from "./Component";

export const VideoWrapper: React.FC<any> = (props) => {
  return (
    <>
      <Audio src={staticFile("${attachedAudioName}")} />
      <${compName} {...props} />
    </>
  );
};

export const RemotionRoot: React.FC = () => {
  return (
    <Composition
      id="DynamicVideo"
      component={VideoWrapper}
      durationInFrames={${totalFrames}}
      fps={${safeFps}}
      width={${w}}
      height={${h}}
    />
  );
};

registerRoot(RemotionRoot);
`;
      } else {
        rootContent = `
import { registerRoot, Composition } from "remotion";
import React from "react";
import { ${compName} } from "./Component";

export const RemotionRoot: React.FC = () => {
  return (
    <Composition
      id="DynamicVideo"
      component={${compName}}
      durationInFrames={${totalFrames}}
      fps={${safeFps}}
      width={${w}}
      height={${h}}
    />
  );
};

registerRoot(RemotionRoot);
`;
      }

      fs.writeFileSync(rootFile, rootContent, "utf-8");
    }

    // 3. Eksekusi rendering menggunakan Remotion CLI di dalam REMOTION_DIR
    // Timing voiceover dikirim sebagai --props (bukan inputProps di Composition; di Remotion 4
    // inputProps pada Composition tidak diteruskan ke komponen saat render lewat CLI).
    const cliArgs = ["remotion", "render", rootFile, compId, outputFilePath, "--gl=angle"];
    if (narrationTimings) {
      const propsFile = path.join(renderTempDir, "nroz-props.json");
      fs.writeFileSync(propsFile, JSON.stringify({ nrozTimings: narrationTimings }), "utf-8");
      cliArgs.push(`--props=${propsFile}`);
    }

    console.log(`[Remotion] Starting render for session ${safeSession} (comp: ${compId}): ${durSec}s (${totalFrames} frames)...`);
    const startTime = Date.now();

    // Render berjalan di latar belakang, jadi batasnya longgar dan ikut panjang video.
    // Faktornya 6x estimasi frame (bukan 3x): komposisi 1080x1920 dengan voiceover terukur
    // butuh ±1,3 detik/frame di VPS 2 vCPU, sementara FRAME_SECONDS hanya 0,35 — batas 3x
    // sempat membunuh render yang tinggal 260 detik lagi selesai. Override REMOTION_RENDER_TIMEOUT_MS.
    const RENDER_TIMEOUT_MS =
      Number(process.env.REMOTION_RENDER_TIMEOUT_MS) ||
      Math.min(4 * 3600_000, Math.max(15 * 60_000, Math.round(totalFrames * FRAME_SECONDS * 6 * 1000)));

    await new Promise((resolve, reject) => {
      const child = spawn("npx", cliArgs, { cwd: REMOTION_DIR });
      let stderrAll = "";
      let stdoutAll = "";
      let pending = "";
      let timedOut = false;
      let lastProgress = null;
      let emittedStage = null;
      let emittedPercent = -1;

      const emit = (progress) => {
        lastProgress = progress;
        // Remotion mencetak progress per frame; jangan bangunkan handler 9000 kali.
        if (progress.stage === emittedStage && Math.abs(progress.percent - emittedPercent) < 1) return;
        emittedStage = progress.stage;
        emittedPercent = progress.percent;
        try { onProgress?.(progress); } catch (_) {}
      };

      // Progress Remotion dicetak memakai \r, dan datang tidak selalu pas di akhir baris.
      const handleLine = (line) => {
        const text = line.trim();
        if (!text) return;
        const bundling = /^Bundling (\d+)%$/.exec(text);
        if (bundling) {
          emit({ stage: "bundling", percent: Math.min(5, Number(bundling[1]) * 0.05), rendered: 0, total: totalFrames });
          return;
        }
        const rendered = /^Rendered (\d+)\/(\d+)(?:, time remaining: (.+))?$/.exec(text);
        if (rendered) {
          const done = Number(rendered[1]);
          const all = Number(rendered[2]) || totalFrames;
          emit({
            stage: "rendering",
            percent: 5 + (done / all) * 87,
            rendered: done,
            total: all,
            remainingText: rendered[3] || null
          });
          return;
        }
        const stitched = /^Stitched (\d+)\/(\d+)$/.exec(text);
        if (stitched) {
          emit({ stage: "stitching", percent: 92 + (Number(stitched[1]) / (Number(stitched[2]) || 1)) * 7, rendered: totalFrames, total: totalFrames });
        }
      };

      const onData = (chunk, target) => {
        const asString = chunk.toString();
        if (target === "stderr") stderrAll = (stderrAll + asString).slice(-200_000);
        else stdoutAll = (stdoutAll + asString).slice(-50_000);

        pending += asString.replace(/\r/g, "\n");
        const lines = pending.split("\n");
        pending = lines.pop();
        for (const line of lines) handleLine(line);
      };

      child.stdout.on("data", (c) => onData(c, "stdout"));
      child.stderr.on("data", (c) => onData(c, "stderr"));

      const timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGKILL");
      }, RENDER_TIMEOUT_MS);

      child.on("error", (err) => {
        clearTimeout(timer);
        reject(err);
      });

      child.on("close", async (code, signal) => {
        clearTimeout(timer);
        if (pending.trim()) handleLine(pending);

        if (code === 0 && !timedOut) return resolve();

        // Jangan buang video yang sebenarnya sudah jadi: SIGKILL bisa mendarat saat CLI
        // masih membersihkan diri setelah encode selesai. Kalau file utuh, pakai hasilnya.
        if (fs.existsSync(outputFilePath)) {
          const probedSec = await probeVideoDuration(outputFilePath);
          if (probedSec >= durSec * 0.9) {
            rescuedNote =
              `Proses CLI dihentikan (${timedOut ? `melewati batas ${Math.round(RENDER_TIMEOUT_MS / 1000)} detik` : `code ${code}`}), ` +
              `tapi videonya sudah lengkap (${probedSec.toFixed(1)}s dari ${durSec}s) — hasil tetap dipakai.`;
            console.warn(`[Remotion] Job output diselamatkan: ${rescuedNote}`);
            return resolve();
          }
        }

        // Baris "npm warn"/"npm notice" selalu muncul di stderr dan bukan penyebab kegagalan,
        // jadi dibuang agar pesan error tidak tertutup noise.
        const realStderr = stderrAll
          .split("\n")
          .filter((line) => !/^npm (warn|notice)/.test(line.trim()))
          .join("\n")
          .trim();

        const parts = [];
        if (timedOut) {
          parts.push(
            `Waktu render melebihi batas ${Math.round(RENDER_TIMEOUT_MS / 1000)} detik lalu proses dihentikan ` +
            `(berhenti di tahap ${STAGE_LABEL[lastProgress?.stage] || "persiapan"}, ${lastProgress?.rendered ?? 0}/${totalFrames} frame). ` +
            `Video sepanjang ini butuh lebih lama dari batasnya.`
          );
        } else if (signal) {
          parts.push(`Proses render dihentikan oleh sistem (signal ${signal}).`);
        }
        if (realStderr) parts.push(realStderr.slice(-4000));
        if (!parts.length && stdoutAll.trim()) parts.push(stdoutAll.trim().slice(-2000));
        if (code !== null && !timedOut && !signal) parts.push(`Remotion CLI keluar dengan code ${code}.`);
        reject(new Error(parts.join("\n") || "Render gagal tanpa keterangan."));
      });
    });

    const elapsedSec = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`[Remotion] Render completed in ${elapsedSec}s: ${outputFilePath}`);

    if (!fs.existsSync(outputFilePath)) {
      throw new Error("File video tidak ditemukan setelah proses rendering selesai.");
    }

    const stat = fs.statSync(outputFilePath);
    const sizeMb = (stat.size / (1024 * 1024)).toFixed(2);

    return {
      success: true,
      videoPath: outputFilePath,
      duration: durSec,
      sizeMb,
      elapsedSec,
      segments: narrationSegments,
      note: rescuedNote
    };
  } catch (err) {
    console.error("[Remotion Error]:", err.message);
    return {
      success: false,
      error: err.message
    };
  } finally {
    // Bersihkan file sementara
    try {
      if (fs.existsSync(renderTempDir)) {
        fs.rmSync(renderTempDir, { recursive: true, force: true });
      }
      if (audioPublicPath && fs.existsSync(audioPublicPath)) {
        fs.unlinkSync(audioPublicPath);
      }
      for (const stagedFile of stagedAssets) {
        try { fs.unlinkSync(stagedFile); } catch (_) {}
      }
    } catch (_) {}
  }
}

/**
 * ANTREAN RENDER LATAR BELAKANG
 *
 * Render video tidak lagi memblokir percakapan: job masuk antrean, tool langsung
 * balas "sedang merender", dan video dikirim saat selesai lewat onRenderComplete.
 * Antreannya serial (satu render di satu waktu) karena CPU sharing membuat setiap
 * render justru lebih lama dan berujung timeout.
 */

// Rata-rata jujur untuk menjangankan estimasi. Bench bersih pernah 0,12-0,15 s/frame, tapi
// pengukuran nyata (28 Okt): 1080x1920 = 0,56 s/frame, 1920x1080 = 0,24-0,28 s/frame.
// Lebih baik janji ke user terlalu lama daripada terlalu cepat.
const FRAME_SECONDS = Number(process.env.REMOTION_FRAME_SECONDS) || 0.35;
const MAX_TRACKED_JOBS = 50;

const renderJobs = new Map();
let jobCounter = 0;
let queueTail = Promise.resolve();
let completeHandler = null;

function queueRender(options, meta = {}) {
  const { durSec, frames } = clampDurationFps(options.durationSeconds, options.fps);

  const job = {
    id: ++jobCounter,
    options,
    chatId: meta.chatId ?? null,
    threadId: meta.threadId ?? null,
    duration: durSec,
    frames,
    waitSec: 0,
    estimateSec: Math.round(frames * FRAME_SECONDS),
    status: "queued",
    queuedAt: Date.now(),
    startedAt: null,
    finishedAt: null,
    progress: null,
    result: null
  };

  renderJobs.set(job.id, job);
  for (const oldId of renderJobs.keys()) {
    if (renderJobs.size <= MAX_TRACKED_JOBS) break;
    if (renderJobs.get(oldId).status !== "queued" && renderJobs.get(oldId).status !== "rendering") {
      renderJobs.delete(oldId);
    }
  }

  const activeEarlier = [...renderJobs.values()].filter(
    (j) => j.id !== job.id && (j.status === "queued" || j.status === "rendering")
  );
  const position = activeEarlier.length + 1;
  job.waitSec = activeEarlier.reduce((sum, j) => sum + j.estimateSec, 0);

  queueTail = queueTail.then(() => runJob(job)).catch((err) => {
    console.error(`[Remotion Queue] Job #${job.id} runtuh:`, err.message);
  });

  return { job, position };
}

async function runJob(job) {
  job.status = "rendering";
  job.startedAt = Date.now();
  job.progress = { stage: "preparing", percent: 0, rendered: 0, total: job.frames };
  console.log(`[Remotion Queue] Job #${job.id} mulai: ${job.duration}s, ${job.frames} frame, estimasi ${Math.max(1, Math.round(job.estimateSec / 60))} menit.`);
  notifyProgress(job, job.progress);

  // onProgress/onMeta menempel di options (bukan kode user), jadi aman dibuang sebelum hasil disimpan.
  const { onProgress: _ignored, onMeta: _ignoredMeta, ...renderOptions } = job.options;
  job.result = await runRender({
    ...renderOptions,
    onMeta: (meta) => {
      // Voiceover sering memanjangkan video; sinkronkan angka yang dilihat user di chat dan log.
      if (meta.frames && meta.frames !== job.frames) {
        console.log(`[Remotion Queue] Job #${job.id} durasi mengikuti voiceover: ${job.duration}s → ${meta.durationSeconds}s (${meta.frames} frame).`);
        job.duration = meta.durationSeconds;
        job.frames = meta.frames;
        job.estimateSec = Math.round(meta.frames * FRAME_SECONDS);
      }
      if (job.progress) {
        job.progress = { ...job.progress, total: meta.frames };
        notifyProgress(job, job.progress);
      }
    },
    onProgress: (progress) => {
      job.progress = { ...progress, elapsedSec: Math.round((Date.now() - job.startedAt) / 1000) };
      notifyProgress(job, job.progress);
    }
  });
  if (job.result.success) {
    job.progress = {
      stage: "done",
      percent: 100,
      rendered: job.frames,
      total: job.frames,
      elapsedSec: Math.round((Date.now() - job.startedAt) / 1000)
    };
    notifyProgress(job, job.progress);
  }
  job.status = job.result.success ? "done" : "failed";
  job.finishedAt = Date.now();

  const elapsedSec = ((job.finishedAt - job.startedAt) / 1000).toFixed(1);
  const perFrame = job.frames > 0 ? (elapsedSec / job.frames).toFixed(3) : "-";
  console.log(`[Remotion Queue] Job #${job.id} ${job.status} dalam ${elapsedSec}s (${perFrame} s/frame).`);

  if (completeHandler) {
    try {
      await completeHandler(job);
    } catch (err) {
      console.error(`[Remotion Queue] Callback job #${job.id} gagal:`, err.message);
    }
  }
}

function onRenderComplete(handler) {
  completeHandler = handler;
}

let progressHandler = null;

function onRenderProgress(handler) {
  progressHandler = handler;
}

function notifyProgress(job, progress) {
  if (!progressHandler) return;
  try {
    progressHandler(job, progress);
  } catch (err) {
    console.error(`[Remotion Queue] Progress handler job #${job.id} gagal:`, err.message);
  }
}

function getRenderJob(id) {
  return renderJobs.get(Number(id));
}

function listActiveJobs() {
  return [...renderJobs.values()].filter(j => j.status === "queued" || j.status === "rendering");
}

/**
 * Status antrean render — dipakai agentTools untuk memberi prioritas CPU rendah
 * pada perintah berat di sandbox selama video sedang dirender.
 */
function getRenderQueueStatus() {
  const active = listActiveJobs();
  const rendering = active.find((j) => j.status === "rendering");
  if (!rendering) return { busy: false, queued: active.length };
  const elapsedSec = (Date.now() - rendering.startedAt) / 1000;
  return {
    busy: true,
    jobId: rendering.id,
    title: rendering.options?.title || "video",
    duration: rendering.duration,
    frames: rendering.frames,
    elapsedSec: Math.round(elapsedSec),
    remainingSec: Math.max(0, Math.round(rendering.estimateSec - elapsedSec)),
    progress: rendering.progress,
    queued: active.length - 1
  };
}

module.exports = {
  queueRender,
  onRenderComplete,
  onRenderProgress,
  getRenderJob,
  listActiveJobs,
  getRenderQueueStatus,
  STAGE_LABEL
};
