const test = require("node:test");
const assert = require("node:assert/strict");

const {
  parseFfprobe,
  fmtTime,
  parseSceneCuts,
  pacingStats,
  planFrameTimes,
  pickSceneFrames
} = require("../tools/videoRef");

test("parseFfprobe: metadata lengkap dari output ffprobe", () => {
  const json = JSON.stringify({
    streams: [{ codec_type: "video", codec_name: "h264", width: 1080, height: 1920, avg_frame_rate: "30000/1001" }],
    format: { duration: "12.5" }
  });
  const meta = parseFfprobe(json);
  assert.equal(meta.durationSec, 12.5);
  assert.equal(meta.width, 1080);
  assert.equal(meta.height, 1920);
  assert.equal(meta.fps, 29.97);
  assert.equal(meta.codec, "h264");
});

test("parseFfprobe: rasio fps sederhana & duration dari stream", () => {
  const json = JSON.stringify({
    streams: [{ codec_type: "video", codec_name: "vp9", width: 720, height: 1280, r_frame_rate: "30/1", duration: "5" }],
    format: {}
  });
  const meta = parseFfprobe(json);
  assert.equal(meta.fps, 30);
  assert.equal(meta.durationSec, 5);
});

test("parseFfprobe: input rusak / tanpa durasi -> null", () => {
  assert.equal(parseFfprobe("bukan json"), null);
  assert.equal(parseFfprobe(JSON.stringify({ streams: [], format: {} })), null);
});

test("fmtTime: format m:ss", () => {
  assert.equal(fmtTime(0), "0:00");
  assert.equal(fmtTime(7.4), "0:07");
  assert.equal(fmtTime(65), "1:05");
  assert.equal(fmtTime(603), "10:03");
  assert.equal(fmtTime(-5), "0:00");
});

test("parseSceneCuts: pts_time dari showinfo, terurut & unik", () => {
  const stderr = [
    "[Parsed_showinfo_1 @ 0x0] n:0 pts:180 pts_time:3 pos:-1",
    "beberapa baris noise lain",
    "[Parsed_showinfo_1 @ 0x0] n:1 pts:300 pts_time:2.5 pos:-1",
    "[Parsed_showinfo_1 @ 0x0] n:2 pts:900 pts_time:2.52 pos:-1",
    "[Parsed_showinfo_1 @ 0x0] n:3 pts:1200 pts_time:10 pos:-1"
  ].join("\n");
  assert.deepEqual(parseSceneCuts(stderr), [2.5, 3, 10]);
  assert.deepEqual(parseSceneCuts("tidak ada cut di sini"), []);
});

test("pacingStats: jumlah cut, frekuensi per 10 detik, rata-rata shot", () => {
  const s = pacingStats([1, 2, 3], 30);
  assert.equal(s.cuts, 3);
  assert.equal(s.per10s, 1);
  assert.equal(s.avgShotSec, 7.5); // 30 / (3+1)
  assert.equal(pacingStats([], 30).per10s, 0);
});

test("planFrameTimes: merata di dalam window & clamp video panjang", () => {
  // 90 detik, 9 frame -> 9, 18, ..., 81
  assert.deepEqual(planFrameTimes(90, 9, 120), [9, 18, 27, 36, 45, 54, 63, 72, 81]);
  // video 5 menit dianalisis 120 detik pertama
  const long = planFrameTimes(300, 3, 120);
  assert.deepEqual(long, [30, 60, 90]);
  // video sangat pendek tetap menghasilkan waktu valid
  for (const t of planFrameTimes(0.8, 9, 120)) {
    assert.ok(t >= 0 && t <= 0.8, `waktu di luar durasi: ${t}`);
  }
});

test("pickSceneFrames: sampel merata dari daftar cut", () => {
  const cuts = [2, 5, 9, 12, 15, 18, 21, 24, 27, 30, 33];
  // indeks: round(i*(10)/3) untuk i=0..3 -> 0, 3, 7, 10 (termasuk ujung)
  assert.deepEqual(pickSceneFrames(cuts, 4), [2, 12, 24, 33]);
  // lebih sedikit dari permintaan -> semua dipakai
  assert.deepEqual(pickSceneFrames([1, 2, 3], 5), [1, 2, 3]);
  assert.deepEqual(pickSceneFrames([], 5), []);
});

// ============================================================
// Tambahan setelah audit: rotasi, pemilihan frame, grid sheet
// ============================================================

const {
  rotationOf,
  orientationLabel,
  frameCountFor,
  planShotFrames,
  tileLayout,
  isClientError
} = require("../tools/videoRef");

test("rotationOf: side_data_list, tags.rotate, dan normalisasi ke 0-359", () => {
  assert.equal(rotationOf({ side_data_list: [{ side_data_type: "Display Matrix", rotation: -90 }] }), 270);
  assert.equal(rotationOf({ side_data_list: [{ rotation: 90 }] }), 90);
  assert.equal(rotationOf({ tags: { rotate: "180" } }), 180);
  assert.equal(rotationOf({ tags: { ROTATE: "270" } }), 270);
  assert.equal(rotationOf({}), 0);
  assert.equal(rotationOf({ side_data_list: [{ rotation: -450 }] }), 270);
});

test("parseFfprobe: video portrait HP (landscape + rotasi) dilaporkan sebagai portrait", () => {
  // Kasus nyata: HP menyimpan 1920x1080 + display matrix 90 derajat. ffmpeg autorotate
  // saat decode, jadi frame yang keluar portrait — metadata harus ikut dikoreksi.
  const json = JSON.stringify({
    streams: [
      {
        codec_type: "video",
        codec_name: "h264",
        width: 1920,
        height: 1080,
        avg_frame_rate: "30/1",
        side_data_list: [{ side_data_type: "Display Matrix", rotation: -90 }]
      }
    ],
    format: { duration: "12" }
  });
  const meta = parseFfprobe(json);
  assert.equal(meta.width, 1080);
  assert.equal(meta.height, 1920);
  assert.equal(meta.rotation, 270);
  assert.equal(meta.rotated, true);
  assert.match(orientationLabel(meta.width, meta.height), /vertikal/);
});

test("parseFfprobe: rotasi 180 tidak menukar dimensi", () => {
  const json = JSON.stringify({
    streams: [{ codec_type: "video", width: 1920, height: 1080, r_frame_rate: "25/1", tags: { rotate: "180" } }],
    format: { duration: "8" }
  });
  const meta = parseFfprobe(json);
  assert.equal(meta.width, 1920);
  assert.equal(meta.height, 1080);
  assert.equal(meta.rotated, false);
});

test("parseFfprobe: file audio-only ditolak (tidak ada stream video)", () => {
  const json = JSON.stringify({
    streams: [{ codec_type: "audio", codec_name: "aac" }],
    format: { duration: "5" }
  });
  assert.equal(parseFfprobe(json), null);
});

test("orientationLabel: vertikal / horizontal / persegi", () => {
  assert.match(orientationLabel(1080, 1920), /vertikal/);
  assert.match(orientationLabel(1920, 1080), /horizontal/);
  assert.match(orientationLabel(1000, 1000), /persegi/);
  assert.equal(orientationLabel(null, 1920), "tidak diketahui");
});

test("frameCountFor: video pendek tidak dipaksa 9 frame identik", () => {
  assert.equal(frameCountFor(12), 9);
  assert.equal(frameCountFor(0.4), 1);
  assert.equal(frameCountFor(2), 5);
  assert.equal(frameCountFor(0), 1);
});

test("planShotFrames: ambil TENGAH tiap shot, termasuk shot pembuka", () => {
  // cut di 3, 6, 9 pada window 12 detik -> 4 shot: 0-3, 3-6, 6-9, 9-12
  // tengahnya: 1.5, 4.5, 7.5, 10.5 — shot pembuka (0-3) dulu tidak pernah terwakili
  // karena kode lama memakai timestamp cut-nya langsung.
  assert.deepEqual(planShotFrames([3, 6, 9], 12), [1.5, 4.5, 7.5, 10.5]);
  // tanpa cut: satu shot penuh
  assert.deepEqual(planShotFrames([], 10), [5]);
  // cut di luar window diabaikan, shot super pendek dilewati
  assert.deepEqual(planShotFrames([5, 5.05, 50], 10), [2.5, 7.53]);
  // jumlah shot lebih banyak dari kapasitas sheet -> disampel merata, maksimal 9
  const many = planShotFrames([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11], 12);
  assert.equal(many.length, 9);
  assert.ok(many[0] < 1, `frame pertama harus dari shot pembuka, dapat ${many[0]}`);
});

test("tileLayout: grid pas tanpa sel kosong", () => {
  assert.deepEqual(tileLayout(9), { cols: 3, rows: 3 });
  assert.deepEqual(tileLayout(3), { cols: 2, rows: 2 }); // 1 sel sisa, tetap lebih baik dari 6 sel hitam
  assert.deepEqual(tileLayout(1), { cols: 1, rows: 1 });
  assert.deepEqual(tileLayout(6), { cols: 3, rows: 2 });
  assert.deepEqual(tileLayout(4), { cols: 2, rows: 2 });
});

test("isClientError: fallback per-sheet hanya untuk penolakan 4xx", () => {
  assert.equal(isClientError({ status: 400 }), true);
  assert.equal(isClientError({ status: 422 }), true);
  assert.equal(isClientError({ status: 500 }), false);
  assert.equal(isClientError({ status: 503 }), false);
  assert.equal(isClientError(new Error("Request timed out.")), false); // timeout: jangan diulang
});

// ============================================================
// Regresi dengan ffmpeg NYATA: contact sheet boleh dibuat ulang
// ============================================================

const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");
const { extractSheet } = require("../tools/videoRef");

function hasFfmpeg() {
  try {
    execFileSync("ffmpeg", ["-version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

test(
  "extractSheet: pemanggilan kedua ke path sheet yang sama tidak menggantung",
  { timeout: 60_000, skip: hasFfmpeg() ? false : "ffmpeg tidak tersedia di mesin ini" },
  async () => {
    // Bug yang dijaga: ffmpeg tanpa -y menemukan file output sudah ada, bertanya
    // "Overwrite? [y/N]", lalu menunggu stdin selamanya. Opsi `timeout` execFile TIDAK
    // bisa membunuhnya karena ffmpeg menangkap SIGTERM tapi terblokir membaca stdin,
    // jadi satu giliran agent membeku permanen dan /stop pun tidak menolong.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nroz-sheet-"));
    const video = path.join(dir, "ref.mp4");
    const sheet = path.join(dir, "sheet.jpg");
    try {
      execFileSync(
        "ffmpeg",
        ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "testsrc2=s=320x240:r=10:d=2",
         "-c:v", "libx264", "-pix_fmt", "yuv420p", video],
        { stdio: "ignore", timeout: 60_000 }
      );

      const first = await extractSheet(video, [0.5, 1.0, 1.5], sheet);
      assert.ok(first.frames >= 1, "sheet pertama harus punya frame");
      const sizeFirst = fs.statSync(sheet).size;
      assert.ok(sizeFirst > 0);

      // Inilah pemanggilan yang dulu menggantung selamanya.
      const t0 = Date.now();
      const second = await extractSheet(video, [0.5, 1.0, 1.5], sheet);
      const elapsed = Date.now() - t0;

      assert.ok(second.frames >= 1, "sheet kedua harus punya frame");
      assert.ok(fs.statSync(sheet).size > 0, "sheet harus tertulis ulang");
      assert.ok(elapsed < 20_000, `pemanggilan kedua terlalu lama (${elapsed}ms) — kemungkinan menggantung`);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
);

test(
  "extractSheet: grid mengikuti jumlah frame yang benar-benar berhasil",
  { timeout: 60_000, skip: hasFfmpeg() ? false : "ffmpeg tidak tersedia di mesin ini" },
  async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nroz-sheet2-"));
    const video = path.join(dir, "ref.mp4");
    try {
      execFileSync(
        "ffmpeg",
        ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "testsrc2=s=320x240:r=10:d=2",
         "-c:v", "libx264", "-pix_fmt", "yuv420p", video],
        { stdio: "ignore", timeout: 60_000 }
      );
      const r = await extractSheet(video, [0.4, 1.2], path.join(dir, "s.jpg"));
      assert.equal(r.frames, 2);
      assert.deepEqual({ cols: r.cols, rows: r.rows }, { cols: 2, rows: 1 });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
);
