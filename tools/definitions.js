/**
 * tools/definitions.js — Skema tool (format OpenAI function-calling) yang ditawarkan ke model.
 */

const TOOL_DEFINITIONS = [
  // --- a) run_command ---
  {
    type: "function",
    function: {
      name: "run_command",
      description:
        "Menjalankan perintah shell di dalam Persistent Docker Sandbox (Ubuntu Linux) terisolasi. " +
        "Kamu memiliki hak akses root penuh di dalam container sandbox kamu, bebas menginstall paket (apt-get, npm, pip), " +
        "menjalankan script, kompilasi kode, atau mengelola proses tanpa batasan. " +
        "PATH: folder kerja kamu di-mount sebagai /workspace. Path /workspace sama dengan folder yang dipakai file_write/file_read — " +
        "jangan menulis ke /opt atau path host lain karena tidak akan terlihat oleh container. " +
        "PERINTAH LAMA: set 'background': true (tanpa sleep!), lalu baca hasilnya dengan tool 'check_command_output'. " +
        "Timeout perintah biasa 120 detik, instalasi paket 300 detik. " +
        "PERINGATAN: DILARANG menggunakan tool ini untuk merender/membuat video animasi atau membuat klip TTS satu per satu. " +
        "Untuk video dengan suara/narasi, SELALU gunakan satu panggilan tool 'render_remotion_video' dengan tts_text atau tts_lines.",
      parameters: {
        type: "object",
        properties: {
          command: {
            type: "string",
            description: "Perintah shell yang akan dijalankan di dalam sandbox, misal 'ls -la' atau 'apt-get install -y ffmpeg'",
          },
          cwd: {
            type: "string",
            description: "Direktori kerja opsional di dalam container (default: /workspace)",
          },
          background: {
            type: "boolean",
            description:
              "true = jalankan tanpa menunggu selesai (untuk render/encode/batch TTS/download panjang). " +
              "Hasil dibaca nanti lewat check_command_output. Jangan pakai 'sleep' untuk menunggu.",
          },
        },
        required: ["command"],
      },
    },
  },

  // --- a2) check_command_output ---
  {
    type: "function",
    function: {
      name: "check_command_output",
      description:
        "Membaca status dan output perintah yang dijalankan dengan run_command {\"background\": true}. " +
        "Kosongkan job_id untuk melihat daftar semua job background. " +
        "Jangan polling berulang-ulang — untuk MENUNGGU job selesai gunakan wait_command_output.",
      parameters: {
        type: "object",
        properties: {
          job_id: {
            type: "string",
            description: "ID job dari hasil run_command background, misal 'bg1'. Kosong untuk list semua job.",
          },
        },
        required: [],
      },
    },
  },

  // --- a3) wait_command_output ---
  {
    type: "function",
    function: {
      name: "wait_command_output",
      description:
        "MENUNGGU job background selesai (blokir sampai kelar atau timeout) lalu mengembalikan status akhir " +
        "beserta output terakhirnya. SATU panggilan ini menggantikan poling check_command_output berulang — " +
        "jauh lebih hemat langkah dan token. Selagi menunggu, user melihat live tail terminalnya di chat. " +
        "Gunakan untuk instalasi paket, build, download, atau proses apa pun yang hasilnya langsung dibutuhkan " +
        "langkah berikutnya. Kalau timeout tercapai, panggil lagi dengan timeout lebih panjang.",
      parameters: {
        type: "object",
        properties: {
          job_id: {
            type: "string",
            description: "ID job dari hasil run_command background, misal 'bg3'.",
          },
          timeout_seconds: {
            type: "number",
            description: "Batas menunggu dalam detik (default 600, maks 600).",
          },
        },
        required: ["job_id"],
      },
    },
  },

  // --- b) run_code ---
  {
    type: "function",
    function: {
      name: "run_code",
      description:
        "Menjalankan potongan kode dan mengembalikan output-nya. " +
        "Mendukung JavaScript (Node.js), Python 3, dan Bash. " +
        "Timeout 90 detik; kode yang lebih panjang jalankan lewat run_command dengan file + background:true. " +
        "Kode dieksekusi di dalam sandbox Docker, jadi folder kerja hanya terlihat sebagai /workspace. " +
        "BLENDER 3D: sandbox memiliki Blender headless — untuk gambar 3D photorealistic, tulis script Python bpy dan jalankan via run_command: 'blender -b -P /workspace/script.py'. Baca skill 'blender_3d' untuk panduan. " +
        "PERINGATAN: DILARANG menggunakan tool ini untuk membuat/merender video animasi (ffmpeg/moviepy/manim/opencv) " +
        "atau membuat klip TTS/audio per segmen. Untuk video bernarasi, gunakan SATU panggilan 'render_remotion_video' " +
        "dengan tts_text (naskah utuh) atau tts_lines (banyak suara).",
      parameters: {
        type: "object",
        properties: {
          language: {
            type: "string",
            enum: ["javascript", "python", "bash"],
            description: "Bahasa pemrograman yang digunakan",
          },
          code: {
            type: "string",
            description: "Kode sumber yang akan dieksekusi",
          },
        },
        required: ["language", "code"],
      },
    },
  },

  // --- c) web_search ---
  {
    type: "function",
    function: {
      name: "web_search",
      description:
        "Mencari informasi di internet menggunakan DuckDuckGo. " +
        "Mengembalikan 5 hasil teratas berupa judul dan cuplikan teks. " +
        "Gunakan untuk mencari informasi terbaru, dokumentasi, atau referensi.",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "Kata kunci pencarian",
          },
        },
        required: ["query"],
      },
    },
  },

  // --- d) read_url ---
  {
    type: "function",
    function: {
      name: "read_url",
      description:
        "Membaca konten dari sebuah URL. Mengambil halaman web, menghapus tag HTML, " +
        "dan mengembalikan teks konten (maks 4000 karakter). Timeout 10 detik.",
      parameters: {
        type: "object",
        properties: {
          url: {
            type: "string",
            description: "URL lengkap yang akan dibaca, misal 'https://example.com'",
          },
        },
        required: ["url"],
      },
    },
  },

  // --- e) system_info ---
  {
    type: "function",
    function: {
      name: "system_info",
      description:
        "Mengambil informasi sistem VPS: hostname, OS, uptime, CPU, memori, dan disk. " +
        "Tidak memerlukan parameter.",
      parameters: {
        type: "object",
        properties: {},
        required: [],
      },
    },
  },

  // --- f) file_read ---
  {
    type: "function",
    function: {
      name: "file_read",
      description:
        "Membaca isi file di workspace (/workspace/...). Maks 4000 karakter. " +
        "Path di luar /workspace ditolak, file sensitif (.env, private key) diblokir.",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Path absolut atau relatif ke file yang akan dibaca",
          },
        },
        required: ["path"],
      },
    },
  },

  // --- g) file_write ---
  {
    type: "function",
    function: {
      name: "file_write",
      description:
        "Menulis konten ke file di workspace (/workspace/...). Direktori induk dibuat otomatis jika belum ada. " +
        "Path di luar /workspace ditolak.",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Path file tujuan",
          },
          content: {
            type: "string",
            description: "Konten yang akan ditulis ke file",
          },
        },
        required: ["path", "content"],
      },
    },
  },

  // --- file_edit ---
  {
    type: "function",
    function: {
      name: "file_edit",
      description:
        "Melakukan pengeditan bedah presisi (surgical replacement) pada file yang sudah ada di workspace (/workspace/...). " +
        "Mendukung pengeditan tunggal ('target' & 'replacement') maupun multi-edit sekaligus dalam satu panggilan ('edits': [{target, replacement}]). " +
        "Dilengkapi toleransi indentasi otomatis (fuzzy-indent match) jika spasi tepi sedikit berbeda namun barisnya unik, serta otomatis menyimpan snapshot untuk 'workspace_undo'. " +
        "SANGAT DIREKOMENDASIKAN daripada file_write untuk mengubah kode yang sudah ada.",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Path file yang akan diedit (misal: /workspace/work/server.js atau relatif)",
          },
          target: {
            type: "string",
            description: "Blok teks yang ingin diganti (untuk edit tunggal; opsional jika memakai 'edits')",
          },
          replacement: {
            type: "string",
            description: "Teks pengganti baru (kosongkan \"\" jika ingin menghapus blok target; opsional jika memakai 'edits')",
          },
          edits: {
            type: "array",
            description: "Daftar beberapa blok pengeditan berurutan dalam satu file: [{ target, replacement }]",
            items: {
              type: "object",
              properties: {
                target: { type: "string", description: "Blok teks yang ingin diganti" },
                replacement: { type: "string", description: "Teks pengganti baru" },
              },
              required: ["target", "replacement"],
            },
          },
        },
        required: ["path"],
      },
    },
  },

  // --- workspace_undo ---
  {
    type: "function",
    function: {
      name: "workspace_undo",
      description:
        "Membatalkan (undo/rollback) perubahan file terakhir yang dilakukan lewat file_write atau file_edit berdasarkan snapshot otomatis, " +
        "atau menampilkan daftar riwayat snapshot yang tersedia (action: 'list'). Gunakan jika perubahan kode menyebabkan error atau ingin kembali ke versi file sebelumnya secara instan.",
      parameters: {
        type: "object",
        properties: {
          action: {
            type: "string",
            enum: ["undo", "list"],
            description: "'undo' (default) untuk membatalkan perubahan terakhir, atau 'list' untuk melihat daftar riwayat snapshot.",
          },
          path: {
            type: "string",
            description: "Opsional. Path file spesifik yang ingin di-undo (kosongkan untuk meng-undo perubahan terakhir di file mana pun).",
          },
          steps: {
            type: "number",
            description: "Berapa langkah perubahan terakhir yang ingin dibatalkan (default: 1, maks: 10).",
          },
        },
        required: [],
      },
    },
  },

  // --- h) file_list ---
  {
    type: "function",
    function: {
      name: "file_list",
      description:
        "Menampilkan daftar file dan folder di sebuah direktori workspace (default: /workspace). " +
        "Path di luar /workspace ditolak.",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Path direktori yang akan di-list (default: direktori saat ini)",
          },
        },
        required: [],
      },
    },
  },

  // --- h2) code_search ---
  {
    type: "function",
    function: {
      name: "code_search",
      description:
        "Mencari teks atau pola regex secara cepat di seluruh file kode dalam workspace (/workspace/...). " +
        "Mengembalikan path file, nomor baris, dan potongan baris yang cocok. Otomatis melewati folder node_modules, .git, dan file biner. " +
        "Sangat berguna untuk menemukan lokasi fungsi, variabel, endpoint, atau error sebelum memakai file_read / file_edit.",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "Teks atau pola regex yang dicari (contoh: 'handleLogin' atau 'app\\.(get|post)')",
          },
          path: {
            type: "string",
            description: "Opsional. Subdirektori atau file spesifik di dalam /workspace yang ingin dicari (default: /workspace).",
          },
          file_pattern: {
            type: "string",
            description: "Opsional. Filter nama/ekstensi file (contoh: '*.js', '*.py', '.tsx').",
          },
          case_sensitive: {
            type: "boolean",
            description: "Opsional. true jika huruf besar/kecil harus dibedakan (default: false).",
          },
          max_results: {
            type: "number",
            description: "Opsional. Batas jumlah baris hasil pencarian (default: 30, maks: 80).",
          },
        },
        required: ["query"],
      },
    },
  },

  // --- i) http_request ---
  {
    type: "function",
    function: {
      name: "http_request",
      description:
        "Membuat HTTP request ke API eksternal. Mendukung GET, POST, PUT, DELETE. " +
        "Timeout 15 detik. Respons dibatasi 4000 karakter.",
      parameters: {
        type: "object",
        properties: {
          method: {
            type: "string",
            enum: ["GET", "POST", "PUT", "DELETE"],
            description: "Metode HTTP",
          },
          url: {
            type: "string",
            description: "URL endpoint tujuan",
          },
          headers: {
            type: "object",
            description: "Header HTTP opsional (key-value)",
          },
          body: {
            type: "string",
            description: "Body request opsional (untuk POST/PUT)",
          },
        },
        required: ["method", "url"],
      },
    },
  },

  // --- j) start_web_preview ---
  {
    type: "function",
    function: {
      name: "start_web_preview",
      description:
        "Membuka link publik instan (Cloudflare Tunnel) untuk preview aplikasi web atau server yang berjalan di port tertentu. " +
        "Mengembalikan URL HTTPS publik yang bisa dibuka di browser dari HP atau komputer.",
      parameters: {
        type: "object",
        properties: {
          port: {
            type: "number",
            description: "Nomor port lokal yang ingin diekspos (misal 3000, 5000, 8080)",
          },
          duration_minutes: {
            type: "number",
            description: "Durasi link aktif dalam menit (default 30 menit)",
          },
        },
        required: ["port"],
      },
    },
  },

  // --- k) create_reminder ---
  {
    type: "function",
    function: {
      name: "create_reminder",
      description:
        "Menjadwalkan pengingat (Reminder). Bot otomatis mengirim pesan ke chat Telegram ini saat waktunya tiba. " +
        "Isi SALAH SATU: 'minutes_from_now' (relatif) atau 'at' (jam/tanggal absolut, zona waktu default WIB/Asia/Jakarta). " +
        "Untuk pengingat berulang isi 'repeat'. Contoh: 'setiap Senin jam 08:00' -> at '2026-11-02 08:00' + repeat 'weekly'; " +
        "'tiap hari kerja jam 9' -> at '09:00' + repeat 'weekdays'.",
      parameters: {
        type: "object",
        properties: {
          message: {
            type: "string",
            description: "Pesan pengingat yang akan dikirimkan",
          },
          minutes_from_now: {
            type: "number",
            description: "Berapa menit lagi dari sekarang (misal 15, 60, 1440 untuk 1 hari). Kosongkan kalau memakai 'at'.",
          },
          at: {
            type: "string",
            description:
              "Waktu absolut menurut jam dinding zona 'timezone': 'YYYY-MM-DD HH:mm' atau cukup 'HH:mm' " +
              "(berarti kejadian berikutnya dari jam itu, hari ini atau besok).",
          },
          repeat: {
            type: "string",
            enum: ["none", "daily", "weekdays", "weekly", "monthly"],
            description: "Pengulangan: none (sekali, default), daily, weekdays (Senin-Jumat), weekly (hari yang sama tiap minggu), monthly (tanggal yang sama tiap bulan).",
          },
          timezone: {
            type: "string",
            description: "Zona waktu IANA, default 'Asia/Jakarta' (WIB). Contoh lain: 'Asia/Makassar' (WITA), 'Asia/Jayapura' (WIT).",
          },
        },
        required: ["message"],
      },
    },
  },

  // --- l) create_watchdog ---
  {
    type: "function",
    function: {
      name: "create_watchdog",
      description:
        "Memasang watchdog pemantau status website atau API server secara berkala. " +
        "Mendukung mode SELF-HEALING: jika 'auto_heal_task' diisi, saat website terdeteksi down/error, kamu (AI Agent) akan otomatis dibangunkan " +
        "untuk menjalankan instruksi diagnosa & perbaikan mandiri (cek log, restart service, fix konfigurasi) lalu melaporkan hasilnya ke Telegram!",
      parameters: {
        type: "object",
        properties: {
          url: {
            type: "string",
            description: "URL lengkap website yang ingin dipantau (misal 'https://example.com')",
          },
          interval_minutes: {
            type: "number",
            description: "Interval pengecekan dalam menit (default 10 menit)",
          },
          auto_heal_task: {
            type: "string",
            description:
              "Opsional (Self-Healing Mode). Instruksi perbaikan otomatis yang akan dieksekusi oleh AI Agent saat URL terdeteksi down " +
              "(contoh: 'Cek log server di /workspace/work/app.log, restart proses node di port 3000, lalu cek ulang endpoint').",
          },
        },
        required: ["url"],
      },
    },
  },

  // --- m) media_download ---
  {
    type: "function",
    function: {
      name: "media_download",
      description:
        "Mengunduh video atau audio dari link media (YouTube, TikTok, Instagram, Twitter/X, dsb.) menggunakan yt-dlp ke folder workspace.",
      parameters: {
        type: "object",
        properties: {
          url: {
            type: "string",
            description: "Link/URL video atau audio yang ingin diunduh",
          },
          format: {
            type: "string",
            enum: ["video", "audio"],
            description: "Format yang diinginkan: 'video' (MP4) atau 'audio' (MP3)",
          },
        },
        required: ["url"],
      },
    },
  },

  // --- n) render_remotion_video ---
  {
    type: "function",
    function: {
      name: "render_remotion_video",
      description:
        "Membuat dan merender video animasi berkualitas tinggi (MP4) secara terprogram dari kode React/TypeScript menggunakan Remotion. " +
        "Mendukung animasi hook Remotion (useCurrentFrame, interpolate, spring, useVideoConfig, AbsoluteFill, Sequence), teks dinamis, bentuk, warna, dan styling CSS flexbox. " +
        "DUKUNGAN 3D: bisa menggunakan Three.js via @remotion/three (ThreeCanvas), @react-three/fiber, @react-three/drei untuk video 3D (objek berputar, material PBR, pencahayaan sinematik, animasi produk). Baca skill 'threejs_3d' untuk panduan lengkap. " +
        "VIDEO PANJANG / BERNARASI: cukup SATU panggilan — kirim seluruh naskah lewat tts_text (atau tts_lines untuk banyak suara). " +
        "Durasi video otomatis mengikuti panjang voiceover sampai 900 detik, dan render dikerjakan di antrean latar belakang. " +
        "Dilarang membuat klip TTS/audio/video per segmen memakai run_command/run_code lalu menggabungkannya sendiri. " +
        "TOOL INI BERSIFAT NON-BLOCKING: pangilan langsung mengembalikan nomor job dan render berjalan di latar belakang; " +
        "video dikirim otomatis ke chat saat selesai. Cukup kabari user bahwa video sedang dikerjakan, lalu akhiri jawaban — jangan panggil tool ini dua kali untuk kode yang sama.",
      parameters: {
        type: "object",
        properties: {
          code: {
            type: "string",
            description:
              "Kode sumber React Component (TSX/JSX) untuk video. Gunakan hook Remotion seperti useCurrentFrame, useVideoConfig, spring, interpolate, dsb. " +
              "Bisa berupa komponen yang di-export (contoh: 'export const MyVideo = () => { ... }').",
          },
          duration_seconds: {
            type: "number",
            description: "Durasi video dalam detik (default: 5). Boleh panjang untuk narasi lengkap; render di server ini ±0,35 detik per frame (5 menit @30fps ≈ 53 menit render).",
          },
          fps: {
            type: "number",
            description:
              "Frame per second (default: 30). Server ini merender ±0,35 detik per frame, jadi video panjang lebih cepat dengan fps rendah: " +
              "5 menit @30fps ≈ 53 menit render, @15fps ≈ 26 menit. Untuk video > 2 menit pakai fps 15.",
          },
          width: {
            type: "number",
            description: "Lebar video dalam pixel (default: 1080 untuk vertikal 9:16 Shorts/Reels/TikTok, atau 1920 untuk horizontal 16:9)",
          },
          height: {
            type: "number",
            description: "Tinggi video dalam pixel (default: 1920 untuk vertikal 9:16 Shorts/Reels/TikTok, atau 1080 untuk horizontal 16:9)",
          },
          title: {
            type: "string",
            description: "Judul atau nama singkat untuk video (contoh: 'promo_diskon', 'quotes_video', 'birthday_sarah')",
          },
          tts_text: {
            type: "string",
            description:
              "Naskah narasi lengkap yang diucapkan AI di video (satu suara). DURASI VIDEO OTOMATIS MENGIKUTI PANJANG NASKAH " +
              "sampai maksimum 900 detik — jadi untuk video 5 menit, kirim seluruh naskah di sini dalam SATU panggilan. " +
              "Jangan pecah naskah menjadi klip TTS kecil dengan run_command/run_code.",
          },
          tts_lines: {
            type: "array",
            description:
              "Naskah multi-suara/dialog. Setiap item diucapkan terpisah lalu digabung otomatis menjadi satu voiceover MP3 " +
              "dan durasi video mengikuti total panjangnya. Komponen React-mu otomatis menerima prop " +
              "`nrozTimings`: array [{text, voice, start, end, words:[{text,start,end]}]} dalam detik — pakai ini untuk " +
              "subtitle/kinetic typography yang sinkron, bukan membuat klip TTS sendiri di sandbox.",
            items: {
              type: "object",
              properties: {
                text: { type: "string", description: "Teks yang diucapkan pada baris ini" },
                voice: {
                  type: "string",
                  description:
                    "Suara untuk baris ini: 'id-male', 'id-female', 'en-male', 'en-female', atau nama edge-tts penuh seperti 'id-ID-GadisNeural'. Kosong = pakai tts_voice.",
                },
              },
              required: ["text"],
            },
          },
          tts_voice: {
            type: "string",
            enum: ["id-male", "id-female", "en-male", "en-female"],
            description: "Pilihan suara AI: 'id-male' (Ardi - pria ID), 'id-female' (Gadis - wanita ID), 'en-male' (Christopher), 'en-female' (Jenny). Default: 'id-male'",
          },
          audio_path: {
            type: "string",
            description:
              "Path file audio (MP3/WAV) yang ingin dipakai sebagai backsound/suara user, misalnya /workspace/musik.mp3 " +
              "(file yang kamu buat lewat run_command/file_write di folder kerjamu). Tool menolak lebih dulu kalau file tidak ada.",
          },
        },
        required: ["code"],
      },
    },
  },

  // --- o) record_decision ---
  {
    type: "function",
    function: {
      name: "record_decision",
      description:
        "Mencatat keputusan, kesepakatan, atau pilihan yang telah ditentukan oleh user (contoh: user memilih Opsi B, user memilih library Tailwind, user menentukan arsitektur atau aturan khusus). " +
        "Catatan ini disimpan permanen di .memory/decisions.md dan otomatis diselipkan ke sistem prompt AI di percakapan berikutnya agar tidak pernah lupa. " +
        "Tiap keputusan punya nomor (#N) yang terlihat di memori. Jika keputusan baru MENGGANTIKAN yang lama (user berubah pikiran), isi 'supersedes' dengan nomor keputusan lama.",
      parameters: {
        type: "object",
        properties: {
          decision: {
            type: "string",
            description: "Inti keputusan atau kesepakatan user secara padat dan jelas (contoh: 'User menyetujui opsi C: menggunakan Tailwind CSS dan SQLite').",
          },
          category: {
            type: "string",
            description: "Kategori keputusan (misal: 'Arsitektur', 'Desain/UI', 'Database', 'Preferensi User', 'Umum'). Default: 'Umum'",
          },
          supersedes: {
            type: "number",
            description: "Opsional. Nomor (#N) keputusan lama yang digantikan oleh keputusan baru ini; keputusan lama otomatis dicabut.",
          },
        },
        required: ["decision"],
      },
    },
  },

  // --- o2) forget_decision ---
  {
    type: "function",
    function: {
      name: "forget_decision",
      description:
        "Mencabut keputusan lama di .memory/decisions.md yang sudah tidak berlaku (user membatalkan tanpa penggantinya, atau keputusan keliru). " +
        "Entri tetap tersimpan sebagai riwayat tetapi tidak lagi diselipkan ke memori. Jika ada pengganti, pakai record_decision dengan 'supersedes'.",
      parameters: {
        type: "object",
        properties: {
          id: {
            type: "number",
            description: "Nomor (#N) keputusan yang dicabut, sesuai daftar di memori keputusan.",
          },
          reason: {
            type: "string",
            description: "Opsional. Alasan singkat pencabutan.",
          },
        },
        required: ["id"],
      },
    },
  },

  // --- p) update_project_context ---
  {
    type: "function",
    function: {
      name: "update_project_context",
      description:
        "Memperbarui ringkasan status proyek terkini di .memory/project_context.md. " +
        "Panggil tool ini setelah kamu membuat/mengedit file penting, menjalankan server di background, atau menyelesaikan tahap proyek " +
        "agar status dan progres proyek selalu terekam saat user bertanya kembali di pesan berikutnya.",
      parameters: {
        type: "object",
        properties: {
          summary: {
            type: "string",
            description: "Ringkasan 1-3 kalimat status pengerjaan proyek saat ini.",
          },
          active_files: {
            type: "array",
            items: { type: "string" },
            description: "Daftar path file utama yang sedang aktif dikerjakan (contoh: ['work/snake/index.html', 'work/app.js']).",
          },
          active_services: {
            type: "string",
            description: "Layanan/server/port yang sedang aktif (contoh: 'Web server aktif di port 3000 (Python http.server)').",
          },
          status: {
            type: "string",
            description: "Status fase proyek (contoh: 'Dalam Pengerjaan', 'Selesai', 'Testing', 'Perencanaan'). Default: 'Dalam Pengerjaan'",
          },
        },
        required: ["summary"],
      },
    },
  },

  // --- q) search_raw_memory ---
  {
    type: "function",
    function: {
      name: "search_raw_memory",
      description:
        "Mencari kata kunci pada arsip obrolan mentah masa lalu di .memory/raw/. " +
        "Gunakan tool ini HANYA jika user merujuk kembali detail percakapan lama yang sudah terlewat dari jendela chat aktif " +
        "(contoh: 'eh pilihan A kemarin kamu bilang apa aja?', 'ingat gak alasan kenapa kita pakai database ini?').",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description:
              "Beberapa kata kunci penting (tanpa kata sambung), contoh: 'database sqlite alasan'. Pesan dicocokkan jika memuat minimal separuh kata di posisi mana pun, " +
              "dan hasil diurutkan dari yang paling relevan. Jika kosong, coba sinonim atau kata lain (mis. 'sqlite' alih-alih 'database').",
          },
          limit: {
            type: "number",
            description: "Batas jumlah potongan chat relevan yang dikembalikan (default: 5, maksimal 20).",
          },
        },
        required: ["query"],
      },
    },
  },

  // --- r) delegate_task ---
  {
    type: "function",
    function: {
      name: "delegate_task",
      description:
        "Mendelegasikan satu tugas teknis berat, terstruktur, atau multi-langkah ke Subagent Mandiri (Orchestration pattern ala Antigravity). " +
        "Subagent memiliki jendela konteks terisolasi, mengeksekusi tools (file_write, run_command, web_search, browser_*, dsb) hingga tuntas, dan mengembalikan laporan ringkas ke kamu. " +
        "Untuk menjalankan BEBERAPA subagent sekaligus secara bersamaan (paralel), gunakan 'delegate_parallel_tasks'.",
      parameters: {
        type: "object",
        properties: {
          role: {
            type: "string",
            description:
              "Nama peran subagent. Kamu bisa memakai preset ('coder', 'researcher', 'tester', 'general') atau menciptakan peran kustom spesialis baru secara bebas (contoh: 'DevOps Engineer', 'Data Analyst', 'Game Story Writer', 'Cybersecurity Auditor', 'UI Designer', dsb).",
          },
          role_description: {
            type: "string",
            description:
              "Deskripsi persona, keahlian khusus, dan fokus kerja untuk peran ini. Sangat dianjurkan diisi jika kamu menciptakan peran kustom baru agar subagent bertindak sesuai ekspektasi ahli.",
          },
          task: {
            type: "string",
            description: "Instruksi tugas yang lengkap, jelas, dan spesifik yang harus diselesaikan oleh subagent.",
          },
          max_rounds: {
            type: "number",
            description: "Batas maksimal langkah tool loop subagent (default: 10, maksimal: 20).",
          },
        },
        required: ["role", "task"],
      },
    },
  },

  // --- r2) delegate_parallel_tasks ---
  {
    type: "function",
    function: {
      name: "delegate_parallel_tasks",
      description:
        "Menjalankan 2 hingga 4 Subagent Mandiri SECARA PARALEL BERSAMAAN (Swarm / Map-Reduce Orchestration). " +
        "Gunakan tool ini saat tugas bisa dipecah menjadi beberapa pekerjaan independen agar selesai berkali-kali lipat lebih cepat " +
        "(contoh: meriset 3 topik/kompetitor sekaligus, membedah beberapa modul berbeda, atau menjalankan 'researcher' dan 'coder' secara paralel).",
      parameters: {
        type: "object",
        properties: {
          tasks: {
            type: "array",
            description: "Daftar 2–4 tugas subagent yang akan dijalankan serentak secara paralel.",
            items: {
              type: "object",
              properties: {
                role: {
                  type: "string",
                  description: "Peran subagent (misal 'researcher', 'coder', 'tester', atau peran kustom).",
                },
                role_description: {
                  type: "string",
                  description: "Opsional. Deskripsi keahlian khusus untuk peran ini.",
                },
                task: {
                  type: "string",
                  description: "Instruksi tugas spesifik dan mandiri untuk subagent ini.",
                },
                max_rounds: {
                  type: "number",
                  description: "Batas langkah subagent ini (default: 10, maks: 20).",
                },
              },
              required: ["role", "task"],
            },
          },
        },
        required: ["tasks"],
      },
    },
  },

  // --- s) send_photo ---
  {
    type: "function",
    function: {
      name: "send_photo",
      description:
        "Mengirimkan file gambar, foto, lukisan, grafik, diagram, atau ilustrasi (.png, .jpg, .jpeg, .webp) dari workspace langsung ke chat Telegram user. WAJIB kamu panggil setiap kali selesai membuat atau mengedit gambar agar hasil visualnya langsung sampai ke user!",
      parameters: {
        type: "object",
        properties: {
          file_path: {
            type: "string",
            description:
              "Path file gambar di workspace (contoh: '/workspace/artifacts/boneka_salju.png' atau 'artifacts/boneka_salju.png').",
          },
          caption: {
            type: "string",
            description: "Keterangan atau caption singkat yang akan menyertai foto di Telegram (opsional).",
          },
        },
        required: ["file_path"],
      },
    },
  },

  // --- t) send_file ---
  {
    type: "function",
    function: {
      name: "send_file",
      description:
        "Mengirimkan file fisik (dokumen PDF, arsip ZIP, file kode, JSON, CSV, TXT, dll) dari workspace langsung ke chat Telegram user sebagai lampiran.",
      parameters: {
        type: "object",
        properties: {
          file_path: {
            type: "string",
            description:
              "Path file di workspace (contoh: '/workspace/artifacts/project.zip' atau 'laporan.pdf').",
          },
          caption: {
            type: "string",
            description: "Keterangan dokumen (opsional).",
          },
        },
        required: ["file_path"],
      },
    },
  },

  // --- u) read_skill ---
  {
    type: "function",
    function: {
      name: "read_skill",
      description:
        "Membaca panduan teknis mendalam dan SOP operasional dari katalog skill untuk keahlian tertentu (contoh: 'remotion_video', 'image_generation', 'threejs_3d', 'blender_3d', 'subagent_orchestration', 'web_preview'). Gunakan tool ini sebelum memulai tugas yang relevan agar eksekusimu presisi.",
      parameters: {
        type: "object",
        properties: {
          skill_name: {
            type: "string",
            description:
              "Nama skill dari katalog yang ingin dipelajari (contoh: 'remotion_video', 'image_generation', 'subagent_orchestration', 'web_preview').",
          },
        },
        required: ["skill_name"],
      },
    },
  },

  // --- v) save_skill ---
  {
    type: "function",
    function: {
      name: "save_skill",
      description:
        "Menyimpan keahlian teknis, SOP eksekusi, resep coding, atau workflow baru ke pustaka skill khusus user di /workspace/skills/. " +
        "Gunakan tool ini secara proaktif setelah berhasil menyelesaikan tugas rumit, menemukan solusi/trik konfigurasi yang spesifik untuk proyek user, atau saat user meminta 'ingat cara ini' / '/learn'.",
      parameters: {
        type: "object",
        properties: {
          name: {
            type: "string",
            description: "Nama unik skill dalam snake_case (misal: 'deploy_express_pm2', 'format_laporan_bulanan', 'setup_jwt_auth')",
          },
          description: {
            type: "string",
            description: "Deskripsi singkat 1-2 kalimat tentang kegunaan skill ini dan kapan harus digunakan",
          },
          content: {
            type: "string",
            description: "Dokumen panduan lengkap (Markdown) berisi langkah-demi-langkah, contoh kode, konfigurasi, perintah terminal yang terbukti berhasil, dan cara mengatasi potensi error.",
          },
        },
        required: ["name", "description", "content"],
      },
    },
  },

  // --- w) schedule_agent_task ---
  {
    type: "function",
    function: {
      name: "schedule_agent_task",
      description:
        "Menjadwalkan TUGAS OTONOM (bukan sekadar pengingat). Saat waktunya tiba, KAMU akan dibangunkan otomatis " +
        "dengan instruksi 'task' ini di chat yang sama, lengkap dengan akses semua tools, lalu bekerja sampai tuntas " +
        "dan melaporkan hasilnya ke user. Gunakan untuk pekerjaan mandiri berkala seperti: digest pagi otomatis, " +
        "cek harga/berita/kompetitor tiap hari, backup mingguan, atau follow-up pekerjaan yang belum selesai. " +
        "BEDAKAN dari create_reminder (hanya mengirim teks pengingat) dan create_watchdog (hanya memantau status URL). " +
        "Isi 'task' sebagai instruksi lengkap yang bisa dipahami kamu di masa depan tanpa konteks tambahan.",
      parameters: {
        type: "object",
        properties: {
          task: {
            type: "string",
            description:
              "Instruksi tugas lengkap yang akan kamu eksekusi saat terpicu (misal: 'Cek harga emas hari ini di web, " +
              "bandingkan dengan catatan kemarin di work/harga.md, lalu laporkan perubahannya').",
          },
          minutes_from_now: {
            type: "number",
            description: "Berapa menit lagi dari sekarang (misal 60, 1440 untuk 1 hari). Kosongkan kalau memakai 'at'.",
          },
          at: {
            type: "string",
            description:
              "Waktu absolut menurut zona 'timezone': 'YYYY-MM-DD HH:mm' atau cukup 'HH:mm' (kejadian berikutnya dari jam itu).",
          },
          repeat: {
            type: "string",
            enum: ["none", "daily", "weekdays", "weekly", "monthly"],
            description: "Pengulangan: none (sekali, default), daily, weekdays (Senin-Jumat), weekly, monthly.",
          },
          timezone: {
            type: "string",
            description: "Zona waktu IANA, default 'Asia/Jakarta' (WIB).",
          },
        },
        required: ["task"],
      },
    },
  },

  // --- x) search_knowledge ---
  {
    type: "function",
    function: {
      name: "search_knowledge",
      description:
        "Pencarian SEMANTIK (RAG) atas dokumen yang pernah di-upload user (PDF, DOCX, teks, kode), catatan pengetahuan yang disimpan lewat save_knowledge, " +
        "dan arsip percakapan masa lalu. Mencari berdasarkan makna, bukan cocok kata kunci persis — jadi bisa menemukan " +
        "jawaban walau kata-katanya berbeda. Gunakan SEBELUM menjawab pertanyaan yang mungkin sudah terjawab di " +
        "dokumen/obrolan lama (contoh: 'apa isi kontrak yang gue upload minggu lalu soal penalty?'). " +
        "Untuk mencocokkan kata persis di arsip chat, gunakan search_raw_memory.",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "Pertanyaan atau topik yang dicari secara semantik, misal 'aturan denda keterlambatan proyek'.",
          },
          source: {
            type: "string",
            description: "Filter sumber opsional: 'upload' (dokumen user), 'chat' (percakapan), 'note' (pengetahuan dari save_knowledge), atau nama sumber spesifik. Kosong = semua.",
          },
          limit: {
            type: "number",
            description: "Jumlah potongan hasil (default 6, maks 20).",
          },
        },
        required: ["query"],
      },
    },
  },

  // --- x2) save_knowledge ---
  {
    type: "function",
    function: {
      name: "save_knowledge",
      description:
        "Menyimpan informasi penting, dokumentasi API, rangkuman riset, atau pengetahuan domain ke dalam database memori semantik (PostgreSQL pgvector). " +
        "Pengetahuan yang disimpan di sini tahan terhadap /newtopic dan dapat dicari kembali kapan saja berdasarkan makna menggunakan tool 'search_knowledge'.",
      parameters: {
        type: "object",
        properties: {
          title: {
            type: "string",
            description: "Judul atau topik pengetahuan (contoh: 'Dokumentasi Endpoint Payment Gateway', 'Arsitektur Server Produksi').",
          },
          content: {
            type: "string",
            description: "Isi lengkap pengetahuan/catatan yang ingin diindeks ke memori semantik.",
          },
        },
        required: ["title", "content"],
      },
    },
  },

  // --- y) ask_user ---
  {
    type: "function",
    function: {
      name: "ask_user",
      description:
        "BERTANYA ATAU MEMINTA INPUT KE USER di tengah tugas TANPA MEMATIKAN SESI/LOOP AI. " +
        "Tugas akan PAUSE dan MENUNGGU jawaban user (teks, kode OTP, klik tombol, kiriman foto, atau file dokumen) " +
        "lalu langsung melanjutkan langkah berikutnya di giliran yang sama! " +
        "WAJIB DIGUNAKAN (JANGAN mengakhiri jawaban dengan teks biasa!) saat: " +
        "(1) membutuhkan kode OTP / 2FA / kode verifikasi email/SMS / password / data form saat login atau daftar di web, " +
        "(2) meminta user melakukan aksi manual di layar komputer (set 'include_desktop': true agar screenshot & link Live Desktop ikut dikirim), " +
        "(3) meminta user mengirim foto/dokumen yang akan di-upload ke form, " +
        "(4) requirement ambigu atau sebelum tindakan berisiko (deploy, hapus data).",
      parameters: {
        type: "object",
        properties: {
          question: {
            type: "string",
            description: "Pertanyaan atau permintaan input yang jelas (misal: 'Masukkan 6 digit kode OTP yang dikirim ke email/HP kamu:').",
          },
          options: {
            type: "array",
            items: { type: "string" },
            description:
              "Pilihan jawaban berupa tombol (2-8 opsi, tiap opsi maks 64 karakter). " +
              "Kosongkan bila user diminta mengetik kode OTP / teks bebas atau mengirim file.",
          },
          include_desktop: {
            type: "boolean",
            description:
              "Set true jika pertanyaan berkaitan dengan layar komputer/browser (misal minta OTP, login manual, atau konfirmasi tampilan). " +
              "Otomatis melampirkan screenshot layar terkini + tombol Link Live Desktop (noVNC).",
          },
          timeout_minutes: {
            type: "number",
            description: "Batas menunggu jawaban dalam menit (default 10, maks 60). Setelah itu lanjut dengan asumsi.",
          },
        },
        required: ["question"],
      },
    },
  },

  // --- y2) computer_use ---
  {
    type: "function",
    function: {
      name: "computer_use",
      description:
        "Mengendalikan Komputer Virtual GUI (Layar Desktop 1280x720 + Browser Chromium GUI dengan profil & tab permanen + Live Web VNC). " +
        "Kemampuan utama: " +
        "• 'start_desktop': menyalakan komputer virtual & menghasilkan Link Live Desktop (noVNC Cloudflare Tunnel) agar user bisa menonton/mengklik layar secara live dari HP/Laptop. " +
        "• 'screenshot': memotret layar komputer 1280x720 (lengkap dengan penggaris koordinat X/Y dan analisis Vision). " +
        "• 'open_url': membuka website di Chromium GUI (set 'new_tab': true untuk buka tab baru). " +
        "• 'list_tabs', 'switch_tab', 'close_tab': melihat daftar tab browser, pindah tab, atau menutup tab. " +
        "• 'click_text': mencari dan mengklik otomatis tombol/link/input di layar berdasarkan teks/label/placeholder-nya (misal target_text: 'Sign in' atau 'Email', opsional 'input_text' & 'press_enter': true) — 100% akurat tanpa takut meleset koordinat! " +
        "• 'click', 'double_click', 'right_click', 'move', 'drag', 'scroll': menggerakkan mouse & klik koordinat (x, y) di layar. Pada 'click', kamu bisa sekaligus mengisi 'text' dan 'press_enter': true agar klik kotak input + ketik + Enter jalan dalam 1 langkah! " +
        "• 'type': mengetik teks pada input yang sedang fokus (opsional 'clear_first': true, 'press_enter': true). " +
        "• 'key': menekan tombol atau kombinasi shortcut keyboard (misal 'Return', 'Tab', 'Escape', 'ctrl+t', 'ctrl+w', 'ctrl+l', 'ctrl+Tab', 'BackSpace'). " +
        "• 'wait': menunggu beberapa detik hingga halaman selesai loading lalu mengambil screenshot. " +
        "PENTING: Jika saat login/daftar muncul permintaan kode OTP, 2FA, password, atau butuh bantuan user di layar, JANGAN berhenti/menjawab teks biasa — PANGGIL tool 'ask_user' dengan 'include_desktop': true agar sesi tetap hidup menunggu user!",
      parameters: {
        type: "object",
        properties: {
          action: {
            type: "string",
            enum: [
              "start_desktop",
              "stop_desktop",
              "screenshot",
              "open_url",
              "list_tabs",
              "switch_tab",
              "close_tab",
              "click_text",
              "click",
              "double_click",
              "right_click",
              "move",
              "drag",
              "scroll",
              "type",
              "key",
              "wait"
            ],
            description: "Jenis aksi komputer yang dijalankan.",
          },
          url: {
            type: "string",
            description: "URL website untuk action='open_url'.",
          },
          new_tab: {
            type: "boolean",
            description: "Jika true pada 'open_url', buka di tab baru tanpa menutup tab aktif.",
          },
          tab: {
            type: "string",
            description: "Nomor urut tab (1, 2, ...) atau kata kunci judul/URL untuk 'switch_tab' / 'close_tab'.",
          },
          x: {
            type: "number",
            description: "Koordinat horizontal X di layar (0 sampai 1280) untuk click/double_click/right_click/move/drag/scroll.",
          },
          y: {
            type: "number",
            description: "Koordinat vertikal Y di layar (0 sampai 720) untuk click/double_click/right_click/move/drag/scroll.",
          },
          to_x: {
            type: "number",
            description: "Koordinat X tujuan akhir untuk action='drag'.",
          },
          to_y: {
            type: "number",
            description: "Koordinat Y tujuan akhir untuk action='drag'.",
          },
          text: {
            type: "string",
            description: "Teks yang diketik untuk action='type' atau langsung diketik setelah action='click' (atau label tombol untuk 'click_text').",
          },
          target_text: {
            type: "string",
            description: "Teks tombol, link, placeholder, atau label input yang ingin diklik pada action='click_text' (contoh: 'Sign in', 'Kirim Kode', 'Email').",
          },
          input_text: {
            type: "string",
            description: "Opsional untuk action='click_text': teks yang langsung diketik ke elemen setelah diklik.",
          },
          clear_first: {
            type: "boolean",
            description: "Jika true pada 'type' atau 'click', hapus isi kotak input sebelumnya (Ctrl+A + BackSpace) sebelum mengetik.",
          },
          press_enter: {
            type: "boolean",
            description: "Jika true pada 'type' atau 'click', tekan tombol Enter setelah selesai mengetik.",
          },
          key: {
            type: "string",
            description: "Nama tombol/shortcut X11 untuk action='key' (contoh: 'Return', 'Tab', 'Escape', 'BackSpace', 'ctrl+t', 'ctrl+w', 'ctrl+l', 'Page_Down').",
          },
          direction: {
            type: "string",
            enum: ["down", "up", "left", "right"],
            description: "Arah gulir untuk action='scroll' (default: 'down').",
          },
          amount: {
            type: "number",
            description: "Jumlah step scroll untuk action='scroll' (default: 4).",
          },
          seconds: {
            type: "number",
            description: "Durasi tunggu dalam detik (1-30) untuk action='wait'.",
          },
          send_to_chat: {
            type: "boolean",
            description: "Kirim hasil screenshot layar ke chat Telegram user (default true untuk 'screenshot', false untuk aksi lainnya kecuali diminta).",
          },
          visual_focus: {
            type: "string",
            description: "Fokus elemen/area yang ingin diperiksa Vision pada layar.",
          },
        },
        required: ["action"],
      },
    },
  },

  // --- z) analyze_video_reference ---
  {
    type: "function",
    function: {
      name: "analyze_video_reference",
      description:
        "Menganalisis VIDEO REFERENSI di workspace (kiriman user atau hasil media_download) agar kamu bisa meniru " +
        "gaya visualnya di Remotion. Tool menghasilkan: metadata (durasi, orientasi/rasio yang sudah dikoreksi " +
        "rotasi, fps), ritme scene cut (potongan per 10 detik, rata-rata panjang shot), contact sheet frame " +
        "yang tersimpan di artifacts/refsheets/ (bisa dikirim ke user dengan send_photo), dan SPEC GAYA VISUAL " +
        "dari vision (palet, layout, tipografi, motion, tempo, rekomendasi struktur scene). WAJIB dipanggil " +
        "sebelum menulis kode render_remotion_video ketika user meminta video 'seperti ini', 'niru gaya ini', " +
        "atau melampirkan video referensi.",
      parameters: {
        type: "object",
        properties: {
          video_path: {
            type: "string",
            description: "Path video referensi di workspace (contoh: '/workspace/uploads/referensi.mp4' atau '/workspace/nama_video.mp4').",
          },
          focus: {
            type: "string",
            description: "Opsional. Aspek yang ingin ditekankan user (misal: 'warna dan tempo', 'gaya teksnya saja').",
          },
        },
        required: ["video_path"],
      },
    },
  },
];

module.exports = { TOOL_DEFINITIONS };
