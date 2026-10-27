/**
 * voiceManager.js — Transkripsi Voice Note Telegram ke Teks
 * Menggunakan Faster-Whisper lokal di VPS
 */

const { execFile } = require("child_process");
const path = require("path");

function transcribeAudio(audioPath) {
  return new Promise((resolve, reject) => {
    execFile(
      "/opt/voice-env/bin/python3",
      [path.join(__dirname, "voiceTranscriber.py"), audioPath],
      { timeout: 30_000 },
      (error, stdout, stderr) => {
        if (error) {
          return reject(new Error(stderr || error.message));
        }
        try {
          const res = JSON.parse(stdout.trim());
          if (res.error) return reject(new Error(res.error));
          resolve(res.text || "");
        } catch (e) {
          reject(new Error(`Gagal membaca hasil transkripsi: ${stdout}`));
        }
      }
    );
  });
}

module.exports = { transcribeAudio };
