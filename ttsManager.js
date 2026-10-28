/**
 * ttsManager.js — Text-to-Speech (TTS) Suara Manusia Alami
 * Menggunakan Microsoft Edge Neural TTS (Gratis, Kualitas Studio)
 */

const { execFile, execFileSync } = require("child_process");
const path = require("path");
const fs = require("fs");

const VOICE_ENV_DIR = "/opt/voice-env";
const EDGE_TTS_BIN = path.join(VOICE_ENV_DIR, "bin", "edge-tts");

let voiceEnvPromise = null;

function ensureVoiceEnv() {
  if (!voiceEnvPromise) {
    voiceEnvPromise = new Promise((resolve, reject) => {
      if (fs.existsSync(EDGE_TTS_BIN)) return resolve();
      console.log(`[TTS] ${VOICE_ENV_DIR} belum ada, menyiapkan edge-tts secara otomatis...`);
      try {
        execFileSync("python3", ["-m", "venv", VOICE_ENV_DIR], { stdio: ["ignore", "pipe", "pipe"] });
        execFileSync(path.join(VOICE_ENV_DIR, "bin", "pip"), ["install", "--quiet", "--disable-pip-version-check", "edge-tts"], {
          stdio: ["ignore", "pipe", "pipe"],
          timeout: 300_000
        });
        if (!fs.existsSync(EDGE_TTS_BIN)) throw new Error("instalasi selesai tetapi biner edge-tts tidak ditemukan");
        console.log(`[TTS] edge-tts siap di ${EDGE_TTS_BIN}`);
        resolve();
      } catch (err) {
        const detail = (err.stderr && err.stderr.toString().trim()) || err.message;
        reject(new Error(
          `Gagal menyiapkan ${VOICE_ENV_DIR} otomatis: ${detail}\n` +
          `Install manual: apt-get install -y python3-venv && python3 -m venv ${VOICE_ENV_DIR} && ${VOICE_ENV_DIR}/bin/pip install edge-tts`
        ));
      }
    });
    voiceEnvPromise.catch(() => { voiceEnvPromise = null; });
  }
  return voiceEnvPromise;
}

/**
 * Daftar suara yang didukung
 */
const AVAILABLE_VOICES = {
  "id-male": "id-ID-ArdiNeural",
  "id-female": "id-ID-GadisNeural",
  "en-male": "en-US-ChristopherNeural",
  "en-female": "en-US-JennyNeural"
};

/**
 * Generate audio MP3 dari teks
 * @param {string} text - Teks yang akan diucapkan
 * @param {Object} [options]
 * @param {string} [options.voice="id-ID-ArdiNeural"] - ID suara
 * @param {string} [options.outputPath] - Path output file MP3
 * @returns {Promise<{ filePath: string, durationSec: number }>}
 */
async function generateSpeech(text, { voice = "id-ID-ArdiNeural", outputPath } = {}) {
  if (!text || !text.trim()) {
    throw new Error("Teks tidak boleh kosong");
  }
  await ensureVoiceEnv();

  return new Promise((resolve, reject) => {
    const selectedVoice = AVAILABLE_VOICES[voice] || voice || "id-ID-ArdiNeural";
    const targetFile = outputPath || path.join("/tmp", `tts_${Date.now()}.mp3`);

    execFile(
      EDGE_TTS_BIN,
      ["--voice", selectedVoice, "--text", text.trim(), "--write-media", targetFile],
      { timeout: 180_000, maxBuffer: 8 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) {
          return reject(new Error(stderr || error.message));
        }
        if (!fs.existsSync(targetFile)) {
          return reject(new Error("File audio TTS gagal dibuat"));
        }

        // Ambil durasi audio menggunakan ffprobe
        execFile(
          "ffprobe",
          ["-v", "error", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", targetFile],
          (probeErr, probeOut) => {
            const dur = probeErr ? 5 : parseFloat(probeOut.trim()) || 5;
            resolve({
              filePath: targetFile,
              durationSec: Math.ceil(dur)
            });
          }
        );
      }
    );
  });
}

/**
 * Generate satu track audio dari banyak baris naskah (multi-suara / dialog).
 * Setiap baris dibuat terpisah, lalu digabung ffmpeg menjadi satu file sehingga
 * video bernarasi panjang selesai dalam satu panggilan tool.
 *
 * @param {Array<string|{text: string, voice?: string}>} lines - Baris naskah
 * @param {Object} [options]
 * @param {string} [options.outputPath] - File MP3 hasil gabung
 * @param {string} [options.voice="id-ID-ArdiNeural"] - Suara default untuk baris tanpa voice
 * @returns {Promise<{ filePath: string, durationSec: number, segments: number }>}
 */
async function generateNarration(lines, { outputPath, voice = "id-ID-ArdiNeural" } = {}) {
  if (!Array.isArray(lines) || lines.length === 0) {
    throw new Error("Daftar naskah (tts_lines) kosong");
  }
  await ensureVoiceEnv();

  const targetFile = outputPath || path.join("/tmp", `narration_${Date.now()}.mp3`);
  const segDir = path.join("/tmp", `narr_${Date.now()}_segs`);
  fs.mkdirSync(segDir, { recursive: true });

  const segmentFiles = [];
  try {
    for (let i = 0; i < lines.length; i++) {
      const entry = lines[i];
      const text = typeof entry === "string" ? entry : entry && entry.text;
      if (!text || !String(text).trim()) continue;
      const segFile = path.join(segDir, `seg_${String(i).padStart(4, "0")}.mp3`);
      const res = await generateSpeech(String(text), { voice: (entry && entry.voice) || voice, outputPath: segFile });
      segmentFiles.push(segFile);
      console.log(`[TTS Narration] Segmen ${segmentFiles.length}/${lines.length}: ${res.durationSec}s`);
    }

    if (segmentFiles.length === 0) {
      throw new Error("Tidak ada baris naskah yang punya teks");
    }

    const listFile = path.join(segDir, "concat.txt");
    fs.writeFileSync(listFile, segmentFiles.map((f) => `file '${f.replace(/'/g, "'\\''")}'`).join("\n"), "utf-8");

    await new Promise((resolve, reject) => {
      execFile(
        "ffmpeg",
        ["-y", "-f", "concat", "-safe", "0", "-i", listFile, "-ar", "44100", "-ac", "2", "-b:a", "128k", targetFile],
        { timeout: 300_000, maxBuffer: 8 * 1024 * 1024 },
        (err, stdout, stderr) => {
          if (err) reject(new Error(`FFmpeg concat gagal: ${(stderr || err.message).toString().slice(-500)}`));
          else resolve();
        }
      );
    });

    const durationSec = await new Promise((resolve) => {
      execFile(
        "ffprobe",
        ["-v", "error", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", targetFile],
        (probeErr, probeOut) => resolve(probeErr ? 0 : Math.ceil(parseFloat(probeOut.trim()) || 0))
      );
    });

    return { filePath: targetFile, durationSec, segments: segmentFiles.length };
  } finally {
    fs.rmSync(segDir, { recursive: true, force: true });
  }
}

module.exports = {
  generateSpeech,
  generateNarration,
  ensureVoiceEnv,
  AVAILABLE_VOICES
};
