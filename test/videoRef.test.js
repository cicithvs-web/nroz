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
