/**
 * ttsManager.js — Text-to-Speech (TTS) Suara Manusia Alami
 * Menggunakan Microsoft Edge Neural TTS (Gratis, Kualitas Studio)
 */

const { execFile } = require("child_process");
const path = require("path");
const fs = require("fs");

const EDGE_TTS_BIN = "/opt/voice-env/bin/edge-tts";

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
function generateSpeech(text, { voice = "id-ID-ArdiNeural", outputPath } = {}) {
  return new Promise((resolve, reject) => {
    if (!text || !text.trim()) {
      return reject(new Error("Teks tidak boleh kosong"));
    }

    const selectedVoice = AVAILABLE_VOICES[voice] || voice || "id-ID-ArdiNeural";
    const targetFile = outputPath || path.join("/tmp", `tts_${Date.now()}.mp3`);

    execFile(
      EDGE_TTS_BIN,
      ["--voice", selectedVoice, "--text", text.trim(), "--write-media", targetFile],
      { timeout: 30_000 },
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

module.exports = {
  generateSpeech,
  AVAILABLE_VOICES
};
