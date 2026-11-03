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
        "Jangan polling berulang-ulang — cek sekali setelah kamu menyelesaikan pekerjaan lain atau setelah user bertanya.",
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
        "Mencari blok teks 'target' yang sama persis dan menggantinya dengan 'replacement'. " +
        "SANGAT DIREKOMENDASIKAN daripada file_write untuk mengubah kode yang sudah ada agar tidak menghapus atau merusak baris kode lainnya.",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Path file yang akan diedit (misal: /workspace/work/server.js atau relatif)",
          },
          target: {
            type: "string",
            description: "Blok karakter/baris teks yang sama persis yang ingin diganti (termasuk spasi/indentasi)",
          },
          replacement: {
            type: "string",
            description: "Teks pengganti baru (kosongkan \"\" jika ingin menghapus blok target)",
          },
        },
        required: ["path", "target", "replacement"],
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
        "Memasang watchdog pemantau status website atau API server. Bot akan mengecek target URL secara berkala dan otomatis mengirimkan pesan peringatan di Telegram jika website down/error.",
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
        "Mendelegasikan tugas teknis berat, terstruktur, atau multi-langkah ke Subagent Mandiri (Orchestration pattern ala Antigravity). " +
        "Subagent memiliki jendela konteks terisolasi, mengeksekusi tools (file_write, run_command, web_search, dsb) hingga tuntas, dan mengembalikan laporan ringkas ke kamu. " +
        "Gunakan tool ini jika: " +
        "(1) membuat proyek/kumpulan file kode lengkap di /workspace/work/ ('role': 'coder'), " +
        "(2) riset web mendalam atau membaca banyak dokumen ('role': 'researcher'), atau " +
        "(3) menguji kode, mencari bug, dan memeriksa respon server ('role': 'tester').",
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
        "Membaca panduan teknis mendalam dan SOP operasional dari katalog skill untuk keahlian tertentu (contoh: 'remotion_video', 'image_generation', 'subagent_orchestration', 'web_preview'). Gunakan tool ini sebelum memulai tugas yang relevan agar eksekusimu presisi.",
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
];

module.exports = { TOOL_DEFINITIONS };
