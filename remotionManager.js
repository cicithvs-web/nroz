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

const { exec, execFile } = require("child_process");
const fs = require("fs");
const path = require("path");
const { generateSpeech, generateNarration } = require("./ttsManager.js");

const REMOTION_DIR = path.join(__dirname, "remotion-engine");
const REMOTION_PUBLIC = path.join(REMOTION_DIR, "public");
const WORKSPACE_BASE = path.join(__dirname, "workspace");

// Batas durasi render. Dulu dipatok 60 detik sehingga video panjang dipotong diam-diam;
// sekarang 15 menit karena render berjalan di antrean latar belakang.
const MAX_RENDER_SECONDS = Number(process.env.REMOTION_MAX_RENDER_SECONDS) || 900;

function clampDurationFps(durationSeconds, fps) {
  const durSec = Math.max(1, Math.min(Number(durationSeconds) || 5, MAX_RENDER_SECONDS));
  const safeFps = Math.max(15, Math.min(Number(fps) || 30, 60));
  return { durSec, safeFps, frames: Math.round(durSec * safeFps) };
}

if (!fs.existsSync(REMOTION_PUBLIC)) {
  fs.mkdirSync(REMOTION_PUBLIC, { recursive: true });
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
  audio_path
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
  let calculatedDuration = Number(durationSeconds) || 5;

  try {
    // 1. Tangani Audio / Voiceover TTS jika diminta
    if (Array.isArray(tts_lines) && tts_lines.length) {
      attachedAudioName = `audio_${timestamp}.mp3`;
      audioPublicPath = path.join(REMOTION_PUBLIC, attachedAudioName);
      console.log(`[Remotion TTS] Merangkai ${tts_lines.length} baris naskah menjadi satu voiceover...`);
      const narrRes = await generateNarration(tts_lines, { outputPath: audioPublicPath, voice: tts_voice });
      narrationSegments = narrRes.segments;
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
    } else if (audio_path && fs.existsSync(audio_path)) {
      attachedAudioName = `audio_${timestamp}${path.extname(audio_path) || ".mp3"}`;
      audioPublicPath = path.join(REMOTION_PUBLIC, attachedAudioName);
      fs.copyFileSync(audio_path, audioPublicPath);
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

    // 2. Simpan dan format kode React komponen
    let cleanCode = (code || "").trim();
    cleanCode = cleanCode.replace(/^```(?:tsx|jsx|typescript|javascript|react)?\s*/i, "");
    cleanCode = cleanCode.replace(/```\s*$/i, "");

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

export const VideoWrapper: React.FC = () => {
  return (
    <>
      <Audio src={staticFile("${attachedAudioName}")} />
      <${compName} />
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
    const cmd = `npx remotion render "${rootFile}" "${compId}" "${outputFilePath}" --gl=angle`;

    console.log(`[Remotion] Starting render for session ${safeSession} (comp: ${compId}): ${durSec}s (${totalFrames} frames)...`);
    const startTime = Date.now();

    // Render berjalan di latar belakang, jadi batasnya longgar: video 5 menit
    // (9000 frame) butuh ±17 menit di 2 vCPU. Override via REMOTION_RENDER_TIMEOUT_MS.
    const RENDER_TIMEOUT_MS = Number(process.env.REMOTION_RENDER_TIMEOUT_MS) || 45 * 60_000;

    await new Promise((resolve, reject) => {
      exec(
        cmd,
        {
          cwd: REMOTION_DIR,
          timeout: RENDER_TIMEOUT_MS,
          maxBuffer: 5 * 1024 * 1024
        },
        (error, stdout, stderr) => {
          if (error) {
            // Baris "npm warn"/"npm notice" selalu muncul di stderr dan bukan penyebab kegagalan,
            // jadi dibuang agar pesan error tidak tertutup noise (mis. timeout yang sebenarnya).
            const realStderr = (stderr || "")
              .split("\n")
              .filter(line => !/^npm (warn|notice)/.test(line.trim()))
              .join("\n")
              .trim();

            const parts = [];
            if (error.killed || error.signal) {
              parts.push(
                `Waktu render melebihi batas ${RENDER_TIMEOUT_MS / 1000} detik lalu proses dihentikan. ` +
                `Video panjang butuh waktu lebih lama dari batas ini.`
              );
            }
            if (realStderr) parts.push(realStderr);
            if (!parts.length && stdout.trim()) parts.push(stdout.trim());
            if (!parts.includes(error.message)) parts.push(error.message);
            return reject(new Error(parts.join("\n")));
          }
          resolve(stdout);
        }
      );
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
      segments: narrationSegments
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

const FRAME_SECONDS = 0.15; // terukur di VPS 2 vCPU, 1080x1920@30fps (bench: 0,148 s/frame) // terukur di 2 vCPU, 1080x1920, tanpa concurrency
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
  console.log(`[Remotion Queue] Job #${job.id} mulai: ${job.duration}s, ${job.frames} frame, estimasi ${Math.max(1, Math.round(job.estimateSec / 60))} menit.`);

  job.result = await runRender(job.options);
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

function getRenderJob(id) {
  return renderJobs.get(Number(id));
}

function listActiveJobs() {
  return [...renderJobs.values()].filter(j => j.status === "queued" || j.status === "rendering");
}

module.exports = {
  queueRender,
  onRenderComplete,
  getRenderJob,
  listActiveJobs
};
