/**
 * tools/web.js — Tool internet: web_search, read_url, http_request.
 *
 * read_url dan http_request memakai safeFetch, jadi tidak bisa menjangkau layanan lokal
 * VPS, jaringan Docker, atau endpoint metadata cloud (lihat lib/netGuard.js).
 */

const { truncate } = require("./common");
const { safeFetch, BlockedUrlError } = require("../lib/netGuard");

/**
 * Tool: web_search
 * Mencari di internet via DuckDuckGo HTML endpoint.
 * Menggunakan fetch bawaan Node.js (v18+).
 */
async function toolWebSearch({ query }) {
  if (!query || typeof query !== "string") {
    return "❌ Parameter 'query' wajib berupa string.";
  }

  try {
    const encodedQuery = encodeURIComponent(query);
    const url = `https://html.duckduckgo.com/html/?q=${encodedQuery}`;

    const response = await fetch(url, {
      method: "GET",
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      },
      signal: AbortSignal.timeout(10_000),
    });

    const html = await response.text();

    const titleMatches = [...html.matchAll(/<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi)];
    const snippetMatches = [...html.matchAll(/<a[^>]*class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/gi)];

    const results = [];
    for (let i = 0; i < Math.min(5, titleMatches.length); i++) {
      const rawTitle = titleMatches[i][2].replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").trim();
      let rawUrl = titleMatches[i][1];
      // Unpack duckduckgo redirect link if present
      const matchUddg = rawUrl.match(/uddg=([^&]+)/);
      if (matchUddg) {
        try {
          rawUrl = decodeURIComponent(matchUddg[1]);
        } catch (_) {}
      } else if (rawUrl.startsWith("//")) {
        rawUrl = "https:" + rawUrl;
      }

      const snippet = snippetMatches[i]
        ? snippetMatches[i][1].replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").trim()
        : "(tidak ada ringkasan)";

      results.push(`${i + 1}. ${rawTitle}\n   ${snippet}\n   🔗 ${rawUrl}`);
    }

    if (results.length === 0) {
      return `🔍 Pencarian "${query}": Tidak ditemukan hasil.`;
    }

    return `🔍 Hasil pencarian "${query}":\n\n${results.join("\n\n")}`;
  } catch (err) {
    if (err.name === "TimeoutError" || err.name === "AbortError") {
      return `⏱️ Pencarian timeout setelah 10 detik.`;
    }
    return `❌ Gagal melakukan pencarian: ${err.message}`;
  }
}

/**
 * Tool: read_url
 * Membaca konten dari URL, menghapus tag HTML, mengembalikan teks bersih.
 */
async function toolReadUrl({ url }) {
  if (!url || typeof url !== "string") {
    return "❌ Parameter 'url' wajib berupa string URL yang valid.";
  }

  // Validasi format URL dasar
  if (!/^https?:\/\//i.test(url)) {
    return "❌ URL harus dimulai dengan http:// atau https://";
  }

  try {
    const response = await safeFetch(url, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (compatible; NrozBot/1.0; +https://github.com/nroz)",
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,text/plain;q=0.8,*/*;q=0.7",
      },
      signal: AbortSignal.timeout(10_000),
    });

    const contentType = response.headers.get("content-type") || "";
    const rawBody = await response.text();

    // Jika konten bukan HTML, kembalikan langsung
    if (!contentType.includes("html")) {
      return truncate(rawBody);
    }

    // Bersihkan HTML: hapus script, style, lalu semua tag
    let text = rawBody
      .replace(/<script[\s\S]*?<\/script>/gi, "")   // hapus <script>
      .replace(/<style[\s\S]*?<\/style>/gi, "")      // hapus <style>
      .replace(/<nav[\s\S]*?<\/nav>/gi, "")           // hapus navigasi
      .replace(/<footer[\s\S]*?<\/footer>/gi, "")     // hapus footer
      .replace(/<header[\s\S]*?<\/header>/gi, "")     // hapus header (nav bar)
      .replace(/<[^>]+>/g, " ")                        // hapus semua tag HTML
      .replace(/&nbsp;/gi, " ")                        // entitas HTML umum
      .replace(/&amp;/gi, "&")
      .replace(/&lt;/gi, "<")
      .replace(/&gt;/gi, ">")
      .replace(/&quot;/gi, '"')
      .replace(/&#\d+;/g, "")                          // entitas HTML numerik
      .replace(/[ \t]+/g, " ")                         // multiple spasi -> satu spasi
      .replace(/\n\s*\n/g, "\n")                       // multiple baris kosong -> satu
      .trim();

    if (!text) {
      return "⚠️ Halaman berhasil diambil tapi tidak mengandung teks yang bisa diekstrak.";
    }

    return truncate(text);
  } catch (err) {
    if (err instanceof BlockedUrlError) return `⛔ ${err.message}`;
    if (err.name === "TimeoutError" || err.name === "AbortError") {
      return `⏱️ Request ke URL timeout setelah 10 detik.`;
    }
    return `❌ Gagal membaca URL: ${err.message}`;
  }
}

/**
 * Tool: http_request
 * Membuat HTTP request ke API eksternal menggunakan fetch bawaan Node.js.
 */
async function toolHttpRequest({ method, url, headers, body }) {
  if (!method || !url) {
    return "❌ Parameter 'method' dan 'url' wajib diisi.";
  }

  // Validasi format URL
  if (!/^https?:\/\//i.test(url)) {
    return "❌ URL harus dimulai dengan http:// atau https://";
  }

  const upperMethod = String(method).trim().toUpperCase();

  try {
    const options = {
      method: upperMethod,
      headers: {
        "User-Agent": "NrozBot/1.0",
        ...(headers || {}),
      },
      signal: AbortSignal.timeout(15_000),
    };

    // Tambahkan body untuk POST/PUT/PATCH/DELETE
    if (body && (upperMethod === "POST" || upperMethod === "PUT" || upperMethod === "PATCH" || upperMethod === "DELETE")) {
      options.body = body;
      // Set Content-Type default jika belum ada
      if (!options.headers["Content-Type"] && !options.headers["content-type"]) {
        // Coba deteksi apakah body berupa JSON
        try {
          JSON.parse(body);
          options.headers["Content-Type"] = "application/json";
        } catch (_) {
          options.headers["Content-Type"] = "text/plain";
        }
      }
    }

    const response = await safeFetch(url, options);
    const responseText = await response.text();

    const statusLine = `${response.status} ${response.statusText}`;
    const respHeaders = {};
    response.headers.forEach((value, key) => {
      respHeaders[key] = value;
    });

    const result = [
      `📡 ${upperMethod} ${url}`,
      `Status: ${statusLine}`,
      `Content-Type: ${respHeaders["content-type"] || "(tidak ada)"}`,
      ``,
      `Response Body:`,
      responseText,
    ].join("\n");

    return truncate(result);
  } catch (err) {
    if (err instanceof BlockedUrlError) return `⛔ ${err.message}`;
    if (err.name === "TimeoutError" || err.name === "AbortError") {
      return `⏱️ HTTP request timeout setelah 15 detik.`;
    }
    return `❌ Gagal melakukan HTTP request: ${err.message}`;
  }
}


module.exports = { toolWebSearch, toolReadUrl, toolHttpRequest };
