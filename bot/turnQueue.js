/**
 * bot/turnQueue.js — Satu giliran AI per sesi, sisanya antre.
 *
 * Tanpa ini, tiga pesan beruntun menjalankan tiga loop AI paralel di sandbox dan workspace yang
 * sama: file saling menimpa, tiap loop membaca riwayat yang belum memuat jawaban yang lain, dan
 * balasan datang tidak berurutan. Dengan antrean, pesan kedua baru diproses setelah jawaban
 * pertama terkirim dan tersimpan, jadi AI melihat riwayat yang lengkap.
 *
 * Kunci antrean adalah sessionId (chat, atau chat+topic di forum), jadi sesi berbeda tetap
 * berjalan paralel.
 */

class QueueFullError extends Error {
  constructor(limit) {
    super(`Antrean penuh (maksimal ${limit} pesan menunggu).`);
    this.name = "QueueFullError";
    this.limit = limit;
  }
}

class TurnQueue {
  /** @param {{ maxPending?: number }} [opts] maxPending: pesan yang boleh menunggu di luar yang sedang berjalan */
  constructor({ maxPending = 5 } = {}) {
    this.maxPending = maxPending;
    /** @type {Map<string, { running: boolean, pending: Array<{ task: Function, resolve: Function, reject: Function }> }>} */
    this.sessions = new Map();
  }

  isBusy(key) {
    return Boolean(this.sessions.get(String(key))?.running);
  }

  pendingCount(key) {
    return this.sessions.get(String(key))?.pending.length ?? 0;
  }

  /**
   * Menjalankan `task` segera kalau sesi kosong, kalau tidak, memasukkannya ke antrean.
   * @param {string} key
   * @param {() => Promise<any>} task
   * @param {{ onQueued?: (position: number) => void }} [hooks] dipanggil saat tugas harus menunggu (posisi mulai 1)
   * @returns {Promise<any>} selesai setelah tugas dijalankan, atau resolve `undefined` bila dibatalkan lewat cancelPending
   * @throws {QueueFullError} bila antrean sudah penuh
   */
  run(key, task, { onQueued } = {}) {
    const k = String(key);
    let state = this.sessions.get(k);
    if (!state) {
      state = { running: false, pending: [] };
      this.sessions.set(k, state);
    }

    if (!state.running) {
      state.running = true;
      return this._execute(k, state, task);
    }

    if (state.pending.length >= this.maxPending) {
      return Promise.reject(new QueueFullError(this.maxPending));
    }

    return new Promise((resolve, reject) => {
      state.pending.push({ task, resolve, reject });
      if (onQueued) {
        try {
          onQueued(state.pending.length);
        } catch (_) {}
      }
    });
  }

  /** Membuang semua tugas yang masih menunggu (yang sedang berjalan tidak disentuh). */
  cancelPending(key) {
    const state = this.sessions.get(String(key));
    if (!state) return 0;
    const dropped = state.pending.splice(0);
    for (const item of dropped) item.resolve(undefined);
    return dropped.length;
  }

  async _execute(key, state, task) {
    try {
      return await task();
    } finally {
      this._next(key, state);
    }
  }

  _next(key, state) {
    const next = state.pending.shift();
    if (!next) {
      state.running = false;
      this.sessions.delete(key);
      return;
    }
    // Berikutnya jalan di microtask sendiri; kegagalannya tidak boleh memutus rantai antrean.
    this._execute(key, state, next.task).then(next.resolve, next.reject);
  }
}

const turnQueue = new TurnQueue({ maxPending: Number(process.env.TURN_QUEUE_MAX) || 5 });

module.exports = { TurnQueue, QueueFullError, turnQueue };
