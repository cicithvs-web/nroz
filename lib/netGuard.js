/**
 * lib/netGuard.js — Pencegah SSRF untuk request HTTP yang dijalankan dari HOST.
 *
 * http_request, read_url, dan watchdog berjalan di proses bot, jadi tanpa penjaga ini
 * mereka bisa memanggil layanan lokal VPS (misalnya port DevTools Chrome di 127.0.0.1),
 * jaringan Docker, atau endpoint metadata cloud (169.254.169.254).
 *
 * Catatan: pemeriksaan DNS dilakukan sebelum fetch, jadi DNS rebinding dengan TTL sangat
 * pendek secara teori masih bisa lolos. Redirect diikuti manual dan tiap hop diperiksa ulang.
 */

const dns = require("dns").promises;
const net = require("net");

function ipv4ToInt(ip) {
  return ip.split(".").reduce((acc, oct) => (acc << 8) + Number(oct), 0) >>> 0;
}

const BLOCKED_V4 = [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4]
].map(([base, bits]) => ({
  base: ipv4ToInt(base),
  mask: bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0
}));

function isPrivateIPv4(ip) {
  const n = ipv4ToInt(ip);
  return BLOCKED_V4.some(({ base, mask }) => ((n & mask) >>> 0) === ((base & mask) >>> 0));
}

/** Mengurai IPv6 menjadi 8 angka 16-bit (mendukung :: dan ekor IPv4). */
function parseIPv6(ip) {
  let s = ip.toLowerCase().split("%")[0];
  let tailV4 = null;
  const v4Match = s.match(/(\d+\.\d+\.\d+\.\d+)$/);
  if (v4Match) {
    tailV4 = v4Match[1];
    s = s.slice(0, -tailV4.length) + "0:0";
  }
  const [head, tail] = s.split("::");
  const headParts = head ? head.split(":") : [];
  const tailParts = tail !== undefined && tail !== "" ? tail.split(":") : [];
  const missing = 8 - headParts.length - tailParts.length;
  const parts = s.includes("::")
    ? [...headParts, ...Array(Math.max(0, missing)).fill("0"), ...tailParts]
    : headParts;
  const words = parts.map((h) => parseInt(h || "0", 16));
  if (tailV4) {
    const n = ipv4ToInt(tailV4);
    words[6] = n >>> 16;
    words[7] = n & 0xffff;
  }
  return words;
}

function isPrivateIPv6(ip) {
  const w = parseIPv6(ip);
  if (w.length !== 8 || w.some((x) => Number.isNaN(x))) return true;
  const allZeroUntil = (i) => w.slice(0, i).every((x) => x === 0);

  if (allZeroUntil(8)) return true; // ::
  if (allZeroUntil(7) && w[7] === 1) return true; // ::1
  // ::ffff:a.b.c.d (IPv4-mapped) dan ::a.b.c.d (IPv4-compatible)
  if (allZeroUntil(5) && (w[5] === 0xffff || w[5] === 0)) {
    const v4 = `${w[6] >>> 8}.${w[6] & 255}.${w[7] >>> 8}.${w[7] & 255}`;
    return isPrivateIPv4(v4);
  }
  // 64:ff9b::/96 (NAT64) -> periksa IPv4 di dalamnya
  if (w[0] === 0x64 && w[1] === 0xff9b && w.slice(2, 6).every((x) => x === 0)) {
    const v4 = `${w[6] >>> 8}.${w[6] & 255}.${w[7] >>> 8}.${w[7] & 255}`;
    return isPrivateIPv4(v4);
  }
  if ((w[0] & 0xfe00) === 0xfc00) return true; // fc00::/7 unique local
  if ((w[0] & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  if ((w[0] & 0xff00) === 0xff00) return true; // ff00::/8 multicast
  if (w[0] === 0x2001 && w[1] === 0x0db8) return true; // dokumentasi
  return false;
}

/** true kalau IP termasuk loopback, privat, link-local, metadata, multicast, atau reserved. */
function isPrivateAddress(ip) {
  const family = net.isIP(ip);
  if (family === 4) return isPrivateIPv4(ip);
  if (family === 6) return isPrivateIPv6(ip);
  return true;
}

class BlockedUrlError extends Error {}

/**
 * Melempar BlockedUrlError kalau URL bukan http(s) atau host-nya mengarah ke alamat internal.
 * @returns {Promise<URL>}
 */
async function assertPublicUrl(rawUrl, { lookup = dns.lookup } = {}) {
  let url;
  try {
    url = new URL(String(rawUrl));
  } catch {
    throw new BlockedUrlError(`URL tidak valid: ${rawUrl}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new BlockedUrlError("URL harus dimulai dengan http:// atau https://");
  }

  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (!host) throw new BlockedUrlError("URL tidak punya host.");
  if (/^localhost$|\.localhost$/i.test(host)) {
    throw new BlockedUrlError(`Akses ditolak: ${host} adalah alamat lokal server.`);
  }

  let addresses;
  if (net.isIP(host)) {
    addresses = [host];
  } else {
    try {
      addresses = (await lookup(host, { all: true, verbatim: true })).map((a) => a.address);
    } catch (err) {
      throw new BlockedUrlError(`Host ${host} tidak bisa di-resolve: ${err.code || err.message}`);
    }
  }

  const blocked = addresses.find(isPrivateAddress);
  if (blocked) {
    throw new BlockedUrlError(
      `Akses ditolak: ${host} mengarah ke alamat internal (${blocked}). ` +
      `Request dari server bot hanya boleh ke alamat internet publik. ` +
      `Untuk menguji server di sandbox, pakai curl lewat run_command.`
    );
  }
  return url;
}

/**
 * fetch yang memeriksa setiap URL (termasuk tujuan redirect) dengan assertPublicUrl.
 */
async function safeFetch(rawUrl, options = {}, { maxRedirects = 5, lookup } = {}) {
  let current = String(rawUrl);
  let opts = { ...options };
  for (let hop = 0; hop <= maxRedirects; hop++) {
    await assertPublicUrl(current, { lookup });
    const res = await fetch(current, { ...opts, redirect: "manual" });
    const location = res.headers.get("location");
    if (res.status >= 300 && res.status < 400 && location) {
      current = new URL(location, current).href;
      const method = String(opts.method || "GET").toUpperCase();
      if (res.status === 303 || ((res.status === 301 || res.status === 302) && method === "POST")) {
        opts = { ...opts, method: "GET" };
        delete opts.body;
      }
      continue;
    }
    return res;
  }
  throw new BlockedUrlError(`Terlalu banyak redirect (lebih dari ${maxRedirects}).`);
}

module.exports = { isPrivateAddress, assertPublicUrl, safeFetch, BlockedUrlError };
