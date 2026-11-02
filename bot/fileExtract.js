/**
 * bot/fileExtract.js — Fungsi murni untuk mengambil file dari jawaban AI
 * (tag <<<FILE:...>>> atau code block) dan menebak nama file/ZIP.
 */

const path = require("path");
const { sanitizePath } = require("./text");

function extractZipName(text, userPrompt = "") {
  // 1. Cek dari tag AI: <<<ZIP:nama.zip>>>
  const aiZipMatch = text.match(/<<<ZIP:\s*([a-zA-Z0-9_\-\.]+\.zip)\s*>>>/i);
  if (aiZipMatch) return path.basename(aiZipMatch[1].trim());

  // 2. Cek dari prompt user jika menyebutkan nama_file.zip (misal: contoh.zip)
  const userZipMatch = userPrompt.match(/\b([a-zA-Z0-9_\-]+\.zip)\b/i);
  if (userZipMatch) return path.basename(userZipMatch[1].trim());

  return "project.zip";
}

function extractFilesFromPrompt(prompt) {
  if (!prompt) return [];
  const list = [];
  const regex = /(?:^|[\s`*(\[])([a-zA-Z0-9_\-\.\/]+\.[a-zA-Z0-9_]{1,10})(?:$|[\s`*)\],:;])/g;
  let m;
  while ((m = regex.exec(prompt)) !== null) {
    const fn = sanitizePath(m[1]);
    if (!fn.endsWith(".zip") && fn.includes(".") && !fn.startsWith("http") && !list.includes(fn)) {
      list.push(fn);
    }
  }
  return list;
}

function detectFilename(fullText, codeBlockMatch, codeBlockIndex, promptFiles, blockIndex) {
  const info = codeBlockMatch[1].trim();
  const code = codeBlockMatch[2].trimEnd();

  // 1. Info string code block: ```html:public/index.html atau ```public/index.html
  if (info) {
    const m = info.match(/(?:file:)?([a-zA-Z0-9_\-\.\/]+\.[a-zA-Z0-9_]{1,10})/i);
    if (m && m[1].includes(".")) return sanitizePath(m[1]);
  }

  // 2. Baris pertama komentar di dalam kode
  const firstLine = code.split("\n")[0].trim();
  const commentMatch = firstLine.match(/^(?:#|\/\/|\/\*|<!--|;)\s*(?:file:?\s*)?([a-zA-Z0-9_\-\.\/]+\.[a-zA-Z0-9_]{1,10})\b/i);
  if (commentMatch) {
    return sanitizePath(commentMatch[1]);
  }

  // 3. Teks tepat sebelum codeblock (sampai 300 karakter ke belakang)
  const prevText = fullText.slice(Math.max(0, codeBlockIndex - 300), codeBlockIndex);
  const pathRegex = /(?:`|\*\*|\#{1,6}\s*|\bfile:?\s*)([a-zA-Z0-9_\-\.\/]+\.[a-zA-Z0-9_]{1,10})/gi;
  let pMatch, lastCandidate = null;
  while ((pMatch = pathRegex.exec(prevText)) !== null) {
    const fn = sanitizePath(pMatch[1]);
    if (fn.includes(".") && !fn.startsWith("http") && !fn.endsWith(".zip")) {
      lastCandidate = fn;
    }
  }
  if (lastCandidate) return lastCandidate;

  // 4. Ambil dari nama file yang secara spesifik diminta user di prompt jika ada
  if (promptFiles && promptFiles.length > blockIndex) {
    return promptFiles[blockIndex];
  }

  // 5. Nama cerdas berdasarkan konten & bahasa (tidak pernah menggunakan file_1)
  const lang = info.toLowerCase();
  if (code.includes("<html") || lang === "html") return blockIndex === 0 ? "index.html" : `page_${blockIndex + 1}.html`;
  if (lang === "css" || code.includes("body {") || code.includes(":root")) return "style.css";
  if (lang === "javascript" || lang === "js") return blockIndex === 0 ? "index.js" : `script_${blockIndex + 1}.js`;
  if (lang === "typescript" || lang === "ts") return blockIndex === 0 ? "index.ts" : `script_${blockIndex + 1}.ts`;
  if (lang === "python" || lang === "py") return blockIndex === 0 ? "main.py" : `script_${blockIndex + 1}.py`;
  if (lang === "json") return "data.json";

  return `script_${blockIndex + 1}.txt`;
}

function extractFilesFromAnswer(text, userPrompt = "") {
  const files = [];

  // 1. Pola eksplisit tag <<<FILE:path/ke/nama_file.ext>>> ... <<<ENDFILE>>>
  const explicitRegex = /<<<FILE:\s*([^\n>]+)>>>\s*\n([\s\S]*?)<<<ENDFILE>>>/gi;
  let match;
  while ((match = explicitRegex.exec(text)) !== null) {
    const filename = sanitizePath(match[1]);
    const content = match[2].trimEnd();
    if (filename && content) files.push({ filename, content });
  }

  // 2. Pola fallback cerdas jika AI menggunakan codeblock standar
  if (files.length === 0) {
    const wantsFile = /file|dokumen|script|unduh|download|kirim.*file|jadikan.*zip|buatkan.*zip|isinya/i.test(userPrompt);
    if (wantsFile) {
      const promptFiles = extractFilesFromPrompt(userPrompt);
      const codeblockRegex = /```([a-zA-Z0-9_\-\.\:\=\s]*)\n([\s\S]*?)```/g;
      let count = 0;
      while ((match = codeblockRegex.exec(text)) !== null) {
        const code = match[2].trimEnd();
        if (!code) continue;

        const filename = detectFilename(text, match, match.index, promptFiles, count++);
        files.push({ filename, content: code });
      }
    }
  }

  return files;
}


module.exports = { extractZipName, extractFilesFromPrompt, detectFilename, extractFilesFromAnswer };
