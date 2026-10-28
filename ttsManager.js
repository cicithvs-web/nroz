/**
 * ttsManager.js — Text-to-Speech (TTS) Suara Manusia Alami
 * Menggunakan Microsoft Edge Neural TTS (Gratis, Kualitas Studio)
 */

const { execFile, execFileSync } = require("child_process");
const path = require("path");
const fs = require("fs");

const VOICE_ENV_DIR = "/opt/voice-env";
const EDGE_TTS_BIN = path.join(VOICE_ENV_DIR, "bin", "edge-tts");
const VOICE_PY = path.join(VOICE_ENV_DIR, "bin", "python");
const NARRATION_SCRIPT = path.join(__dirname, "ttsNarration.py");

/** Jalankan biner dengan argv array (tanpa shell, jadi tidak ada injeksi). */
function runTool(cmd, args, { timeout = 120_000 } = {}) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        const detail = (stderr || "").toString().trim() || err.message;
        reject(new Error(`${path.basename(cmd)} gagal: ${detail.slice(-600)}`));
        return;
      }
      resolve(stdout);
    });
  });
}

/** Durasi file audio/video dalam detik memakai ffprobe. */
async function probeDuration(file) {
  try {
    const out = await runTool("ffprobe", [
      "-v", "error",
      "-show_entries", "format=duration",
      "-of", "default=noprint_wrappers=1:nokey=1",
      file
    ], { timeout: 30_000 });
    return parseFloat(out.trim()) || 0;
  } catch (_) {
    return 0;
  }
}

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
 * Generate satu track audio dari banyak baris naskah (multi-suara / dialog) beserta
 * timing per kata, dipakai untuk subtitle yang sinkron.
 *
 * @param {Array<string|{text: string, voice?: string}>} lines - Baris naskah
 * @param {Object} [options]
 * @param {string} [options.outputPath] - File MP3 hasil gabung
 * @param {string} [options.voice="id-ID-ArdiNeural"] - Suara default untuk baris tanpa voice
 * @returns {Promise<{ filePath: string, durationSec: number, segments: number, timings: Array }>}
 */
async function generateNarration(lines, { outputPath, voice = "id-ID-ArdiNeural" } = {}) {
  if (!Array.isArray(lines) || lines.length === 0) {
    throw new Error("Daftar naskah (tts_lines) kosong");
  }
  await ensureVoiceEnv();

  const targetFile = outputPath || path.join("/tmp", `narration_${Date.now()}.mp3`);
  const workDir = path.join("/tmp", `narr_${Date.now()}_segs`);
  fs.mkdirSync(workDir, { recursive: true });

  try {
    const specPath = path.join(workDir, "spec.json");
    const resultPath = path.join(workDir, "result.json");
    const specLines = lines.map((line) => {
      const raw = typeof line === "string" ? { text: line } : line || {};
      return { text: String(raw.text || ""), voice: raw.voice ? AVAILABLE_VOICES[raw.voice] || raw.voice : undefined };
    });
    fs.writeFileSync(
      specPath,
      JSON.stringify({ lines: specLines, voice: AVAILABLE_VOICES[voice] || voice, seg_dir: workDir }),
      "utf-8"
    );

    await runTool(VOICE_PY, [NARRATION_SCRIPT, specPath, resultPath], { timeout: 600_000 });
    const segments = JSON.parse(fs.readFileSync(resultPath, "utf-8")).segments || [];
    if (segments.length === 0) {
      throw new Error("Tidak ada baris naskah yang punya teks");
    }

    const listFile = path.join(workDir, "concat.txt");
    fs.writeFileSync(listFile, segments.map((s) => `file '${s.file.replace(/'/g, "'\\''")}'`).join("\n"), "utf-8");

    await runTool(
      "ffmpeg",
      ["-y", "-f", "concat", "-safe", "0", "-i", listFile, "-ar", "44100", "-ac", "2", "-b:a", "128k", targetFile],
      { timeout: 300_000 }
    );

    // Edge-tts memberi waktu per kata relatif ke awal tiap segmen, jadi offset kumulatif
    // berdasarkan durasi nyata tiap segmen yang ditambahkan.
    let cursor = 0;
    const timings = [];
    for (const seg of segments) {
      const segDur = await probeDuration(seg.file);
      timings.push({
        text: seg.text,
        voice: seg.voice,
        start: Number(cursor.toFixed(3)),
        end: Number((cursor + segDur).toFixed(3)),
        words: (seg.words || []).map((w) => ({
          text: w.text,
          start: Number((cursor + w.start).toFixed(3)),
          end: Number((cursor + w.end).toFixed(3))
        }))
      });
      cursor += segDur;
    }

    return {
      filePath: targetFile,
      durationSec: Math.ceil(cursor),
      segments: segments.length,
      timings
    };
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
}

module.exports = {
  generateSpeech,
  generateNarration,
  ensureVoiceEnv,
  AVAILABLE_VOICES
};
