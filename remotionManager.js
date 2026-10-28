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
 * - Menyimpan video di folder workspace user dan mengembalikan path-nya.
 */

const { exec, execFile } = require("child_process");
const fs = require("fs");
const path = require("path");
const { generateSpeech } = require("./ttsManager.js");

const REMOTION_DIR = path.join(__dirname, "remotion-engine");
const REMOTION_PUBLIC = path.join(REMOTION_DIR, "public");
const WORKSPACE_BASE = path.join(__dirname, "workspace");

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
 * @param {string} [options.tts_voice="id-ID-ArdiNeural"] - Pilihan suara AI ("id-male", "id-female", "en-male", "en-female")
 * @param {string} [options.audio_path] - Path file audio MP3/WAV kustom yang ingin dimasukkan ke video
 * @returns {Promise<{ success: boolean, videoPath?: string, error?: string, duration?: number, sizeMb?: string, elapsedSec?: string }>}
 */
async function renderRemotionVideo({
  code,
  durationSeconds = 5,
  fps = 30,
  width = 1080,
  height = 1920,
  title,
  sessionId = "default",
  tts_text,
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
  let calculatedDuration = Number(durationSeconds) || 5;

  try {
    // 1. Tangani Audio / Voiceover TTS jika diminta
    if (tts_text && tts_text.trim()) {
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

    const durSec = Math.max(1, Math.min(calculatedDuration, 60)); // batas 1 - 60 detik
    const safeFps = Math.max(15, Math.min(Number(fps) || 30, 60));
    const totalFrames = Math.round(durSec * safeFps);
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

    await new Promise((resolve, reject) => {
      exec(
        cmd,
        {
          cwd: REMOTION_DIR,
          timeout: 180_000,
          maxBuffer: 5 * 1024 * 1024
        },
        (error, stdout, stderr) => {
          if (error) {
            const errDetails = stderr || stdout || error.message;
            return reject(new Error(errDetails));
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
      elapsedSec
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

module.exports = {
  renderRemotionVideo
};
