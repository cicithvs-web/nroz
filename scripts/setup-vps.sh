#!/usr/bin/env bash
#
# setup-vps.sh — Siapkan VPS kosong sampai bot Nroz siap berjalan.
#
#   bash scripts/setup-vps.sh              # pasang yang kurang, lalu jalankan bot
#   bash scripts/setup-vps.sh --check      # periksa saja, tidak mengubah apa pun
#
# Opsi: --skip-node --skip-docker --skip-npm --skip-start --swap-mb=4096
# Idempoten: aman dijalankan ulang, tiap langkah dilewati kalau sudah beres.

set -uo pipefail
cd "$(dirname "$0")/.."
ROOT_DIR="$(pwd)"

CHECK_ONLY=0
INSTALL_NODE=1
INSTALL_DOCKER=1
INSTALL_NPM=1
START_BOT=1
SWAP_MB=4096

for arg in "$@"; do
  case "$arg" in
    --check) CHECK_ONLY=1 ;;
    --skip-node) INSTALL_NODE=0 ;;
    --skip-docker) INSTALL_DOCKER=0 ;;
    --skip-npm) INSTALL_NPM=0 ;;
    --skip-start) START_BOT=0 ;;
    --swap-mb=*) SWAP_MB="${arg#--swap-mb=}" ;;
    *) echo "Opsi tidak dikenal: $arg"; exit 2 ;;
  esac
done

say() { printf '\033[1;36m==>\033[0m %s\n' "$*"; }
ok() { printf '  \033[0;32mOK\033[0m   %s\n' "$*"; }
bad() { printf '  \033[0;31mKURANG\033[0m %s\n' "$*"; }
warn() { printf '  \033[0;33mPERHATIAN\033[0m %s\n' "$*"; }

MISSING=0
check() { # check "label" "perintah-uji" ["cara-mengatasi"]
  local rc=0
  # grep -q keluar begitu saja saat ada tanda cocok, sehingga perintah di depan pipeline
  # (systemctl/ldconfig) kena SIGPIPE. Dengan pipefail itu terbaca sebagai kegagalan, jadi
  # pipefail dimatikan khusus untuk uji ini.
  set +o pipefail
  eval "$2" >/dev/null 2>&1 || rc=$?
  set -o pipefail
  if [ "$rc" -eq 0 ]; then
    ok "$1"
  else
    MISSING=$((MISSING + 1))
    bad "$1${3:+ — $3}"
  fi
}

if [ "$EUID" -ne 0 ] && [ "$CHECK_ONLY" -eq 0 ]; then
  echo "Jalankan sebagai root (script ini memasang paket dan menulis /etc/fstab)."
  echo "Periksa tanpa mengubah: bash scripts/setup-vps.sh --check"
  exit 1
fi

. /etc/os-release 2>/dev/null || true
OS_LABEL="${PRETTY_NAME:-linux tidak dikenal}"
OS_ARCH="$(uname -m)"
case "${ID:-}" in
  debian|ubuntu) PKG=apt-get ;;
  *) echo "Distro tidak dikenal (ID=${ID:-kosong}); script ini ditulis untuk Debian/Ubuntu."
     echo "Coba: bash scripts/setup-vps.sh --check"
     [ "$CHECK_ONLY" -eq 1 ] || exit 1
     PKG="" ;;
esac

apt_updated=0
apt_ensure_update() {
  if [ "$apt_updated" -eq 0 ]; then
    say "Meng-refresh daftar paket apt"
    apt-get update -qq
    apt_updated=1
  fi
}

# ---------------------------------------------------------------- periksa saja
if [ "$CHECK_ONLY" -eq 1 ]; then
  echo "Kondisi server saat ini ($OS_LABEL, $OS_ARCH):"
  check "Node.js >= 18" '[ "$(node -v 2>/dev/null | tr -d v | cut -d. -f1)" -ge 18 ]' "bash scripts/setup-vps.sh"
  check "npm" "command -v npm"
  check "Docker daemon jalan" "docker info" "bash scripts/setup-vps.sh (atau: systemctl start docker)"
  check "ffmpeg" "command -v ffmpeg"
  check "ffprobe" "command -v ffprobe"
  check "yt-dlp" "command -v yt-dlp"
  check "cloudflared (web preview & link unduhan)" "command -v cloudflared" "bash scripts/setup-vps.sh"
  check "python3 + venv" "python3 -m venv --help"
  check ".env terisi BOT_TOKEN" "grep -qE '^BOT_TOKEN=[A-Za-z0-9]' .env" "cp .env.example .env lalu isi"
  check "node_modules bot" "[ -d node_modules ]" "npm install"
  check "node_modules remotion-engine" "[ -d remotion-engine/node_modules ]" "cd remotion-engine && npm install"
  check "Chrome Headless Shell (Remotion)" "[ -d remotion-engine/node_modules/.remotion/chrome-headless-shell ]" "cd remotion-engine && npx remotion browser ensure"
  check "venv TTS (/opt/voice-env)" "[ -x /opt/voice-env/bin/edge-tts ]" "dibuat otomatis saat TTS pertama dipakai"
  check "image sandbox Docker" "docker image inspect nroz-sandbox:latest" "docker build -f Dockerfile.sandbox -t nroz-sandbox:latest ."
  check "swap aktif" "[ \"\$(awk '/^SwapTotal/ {print \$2}' /proc/meminfo)\" -gt 102400 ]" "bash scripts/setup-vps.sh --swap-mb=4096"
  check "libnss3 (dipakai Chrome headless)" "ldconfig -p | grep -q libnss3" "bash scripts/setup-vps.sh"
  check "proses bot jalan di pm2" "pm2 describe nroz" "bash scripts/setup-vps.sh"
  check "auto-start saat reboot" "systemctl list-unit-files 2>/dev/null | grep -q pm2-root" "pm2 startup"
  echo
  if [ "$MISSING" -gt 0 ]; then
    echo "$MISSING item perlu dibereskan — jalankan: sudo bash scripts/setup-vps.sh"
    exit 1
  fi
  echo "Semua siap. Tidak ada yang perlu diubah."
  exit 0
fi

# ---------------------------------------------------------------- node
if [ "$INSTALL_NODE" -eq 1 ]; then
  if [ "$(node -v 2>/dev/null | tr -d v | cut -d. -f1)" -ge 18 ] 2>/dev/null; then
    say "Node.js $(node -v) sudah cukup, lewati"
  else
    say "Memasang Node.js 20 dari NodeSource"
    apt_ensure_update
    apt-get install -y -qq curl ca-certificates gnupg
    curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
    apt-get install -y -qq nodejs
  fi
fi

# ---------------------------------------------------------------- paket dasar
say "Memasang ffmpeg, ffprobe, yt-dlp, python3-venv, python3-pip"
apt_ensure_update
apt-get install -y -qq ffmpeg python3-venv python3-pip rsync
command -v yt-dlp >/dev/null || apt-get install -y -qq yt-dlp || pip3 install --break-system-packages yt-dlp

# ---------------------------------------------------------------- library chrome
# Debian 13 menamai paketnya dengan sufiks t64, Ubuntu 22.04/24.04 tidak. Diambil
# nama pertama yang benar-benar ada di repo, supaya satu script jalan di keduanya.
say "Memasang library yang dibutuhkan Chrome Headless Shell"
apt_ensure_update
for candidates in "libnss3" "libnspr4" "libasound2t64 libasound2" "libatk1.0-0t64 libatk1.0-0" \
                  "libatk-bridge2.0-0t64 libatk-bridge2.0-0" "libatspi2.0-0t64 libatspi2.0-0" \
                  "libxkbcommon0" "libgbm1" "libdrm2" "libxshmfence1" "libcups2t64 libcups2"; do
  picked=""
  for pkg in $candidates; do
    if apt-cache show "$pkg" >/dev/null 2>&1; then picked="$pkg"; break; fi
  done
  if [ -n "$picked" ]; then
    apt-get install -y -qq "$picked"
  else
    warn "tidak ada kandidat untuk: $candidates"
  fi
done

# ---------------------------------------------------------------- docker
if [ "$INSTALL_DOCKER" -eq 1 ]; then
  if command -v docker >/dev/null && docker info >/dev/null 2>&1; then
    say "Docker sudah jalan, lewati"
  else
    say "Memasang Docker (dipakai sandbox per user)"
    apt_ensure_update
    apt-get install -y -qq docker.io
    systemctl enable --now docker
  fi
fi

# ---------------------------------------------------------------- cloudflared
# Dipakai web preview DAN link unduhan video besar. Tidak ada di repo distro,
# jadi diambil langsung dari rilis resmi Cloudflare.
if command -v cloudflared >/dev/null; then
  say "cloudflared $(cloudflared --version 2>/dev/null | awk '{print $3}') sudah ada, lewati"
else
  say "Memasang cloudflared"
  case "$(uname -m)" in
    x86_64|amd64) CF_ARCH=amd64 ;;
    aarch64|arm64) CF_ARCH=arm64 ;;
    *) echo "Arsitektur $(uname -m) tidak didukung cloudflared binary resmi — pasang manual." ; CF_ARCH="" ;;
  esac
  if [ -n "$CF_ARCH" ]; then
    curl -fsSL -o /usr/local/bin/cloudflared \
      "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-${CF_ARCH}"
    chmod 755 /usr/local/bin/cloudflared
    cloudflared --version
  fi
fi

# ---------------------------------------------------------------- swap
TOTAL_SWAP_KB=$(awk '/^SwapTotal/ {print $2}' /proc/meminfo)
if [ "$TOTAL_SWAP_KB" -ge $((SWAP_MB * 1024)) ]; then
  say "Swap sudah $((TOTAL_SWAP_KB / 1024)) MB, lewati"
else
  say "Menyiapkan swapfile ${SWAP_MB} MB (render video panjang butuh di atas RAM 2 GB)"
  if [ ! -f /swapfile ]; then
    dd if=/dev/zero of=/swapfile bs=1M count="$SWAP_MB" status=none
    chmod 600 /swapfile
    mkswap /swapfile
  fi
  grep -q '^/swapfile' /etc/fstab || echo '/swapfile none swap sw,pri=1 0 0' >> /etc/fstab
  swapon /swapfile || swapon -a
fi

# ---------------------------------------------------------------- .env
if [ -f .env ]; then
  say ".env sudah ada"
else
  say "Membuat .env dari .env.example"
  cp .env.example .env
  chmod 600 .env
  warn ".env masih berisi contoh. Isi BOT_TOKEN, API_KEY, BASE_URL, MODEL, ONLYX_DB_URL, ONLYX_DB_KEY, OWNER_ID."
fi

# ---------------------------------------------------------------- node deps
if [ "$INSTALL_NPM" -eq 1 ]; then
  say "npm install (bot)"
  npm install --no-fund --no-audit
  say "npm install (remotion-engine) + unduh Chrome Headless Shell"
  (cd remotion-engine && npm install --no-fund --no-audit && npx remotion browser ensure)
fi

# ---------------------------------------------------------------- voice env
say "Menyiapkan venv edge-tts (/opt/voice-env)"
node -e "require('./ttsManager').ensureVoiceEnv().then(()=>console.log('  voice-env siap')).catch(e=>{console.warn('  voice-env belum siap:', e.message)})"

# ---------------------------------------------------------------- sandbox image
if docker image inspect nroz-sandbox:latest >/dev/null 2>&1; then
  say "Image sandbox sudah ada, lewati"
else
  say "Membangun image sandbox Docker (perlu beberapa menit pertama kali)"
  docker build -f Dockerfile.sandbox -t nroz-sandbox:latest "$ROOT_DIR"
fi

mkdir -p workspace

# ---------------------------------------------------------------- jalankan
if [ "$START_BOT" -eq 1 ]; then
  if ! grep -qE '^BOT_TOKEN=[A-Za-z0-9]' .env; then
    echo
    warn "BOT_TOKEN belum diisi di .env — bot tidak kuk jalankan."
    echo "Isi .env lalu jalankan ulang script ini, atau: pm2 start bot.js --name nroz"
    exit 0
  fi
  command -v pm2 >/dev/null || npm install -g pm2
  say "Menjalankan bot lewat pm2 (app: nroz)"
  if pm2 describe nroz >/dev/null 2>&1; then
    pm2 reload nroz --update-env
  else
    pm2 start bot.js --name nroz
  fi
  pm2 save

  # Konfigurasi auto-start dari pm2 menghasilkan satu perintah yang dicetak ke stdout;
  # perintah itu yang dieksekusi, bukan yang lain.
  if [ ! -e /etc/systemd/system/pm2-root.service ]; then
    say "Mengaktifkan auto-start bot saat server reboot"
    startup_cmd=$(pm2 startup systemd -u root --hp /root 2>/dev/null | grep -m1 '^sudo ' | sed 's/^sudo //' || true)
    if [ -n "$startup_cmd" ]; then
      eval "$startup_cmd" >/dev/null 2>&1 || warn "auto-start perlu diatur manual: $startup_cmd"
    else
      warn "tidak menemukan perintah startup dari pm2 — cek: pm2 startup"
    fi
  fi
fi

echo
say "Laporan akhir"
bash "$(dirname "$0")/setup-vps.sh" --check
