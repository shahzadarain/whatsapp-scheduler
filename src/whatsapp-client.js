const path = require('path');
const fs = require('fs/promises');
const EventEmitter = require('events');
const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const QRCode = require('qrcode');
const logger = require('./logger');

const AUTH_DIR = path.join(__dirname, '..', '.wwebjs_auth');

const PUPPETEER_OPTS = {
  headless: true,
  timeout: 120000,
  protocolTimeout: 180000,
  args: [
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-dev-shm-usage',
    '--disable-accelerated-2d-canvas',
    '--no-first-run',
    '--no-zygote',
    '--disable-gpu'
  ]
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class WhatsAppClient extends EventEmitter {
  constructor() {
    super();
    this.state = 'initializing';
    this.qrDataUrl = null;
    this.qrText = null;
    this.lastReadyAt = null;
    this.lastDisconnectedAt = null;
    this.lastDisconnectReason = null;
    this.client = null;
    this.initAttempt = 0;
    this.recycling = false;
    this.shuttingDown = false;
  }

  start() {
    this._spawn();
  }

  async stop() {
    this.shuttingDown = true;
    if (this.client) {
      try { await this.client.destroy(); } catch (_) { /* ignore */ }
      this.client = null;
    }
  }

  isReady() {
    return this.state === 'ready';
  }

  getStatus() {
    return {
      state: this.state,
      ready: this.isReady(),
      hasQr: Boolean(this.qrDataUrl),
      lastReadyAt: this.lastReadyAt,
      lastDisconnectedAt: this.lastDisconnectedAt,
      lastDisconnectReason: this.lastDisconnectReason
    };
  }

  getQrDataUrl() {
    return this.qrDataUrl;
  }

  async sendMessage(jid, text) {
    if (!this.isReady()) throw new Error(`WhatsApp client is not ready (state=${this.state})`);
    return this.client.sendMessage(jid, text);
  }

  async sendMedia(jid, filePath, { mimetype, filename, asVoice = false, caption } = {}) {
    if (!this.isReady()) throw new Error(`WhatsApp client is not ready (state=${this.state})`);
    const media = MessageMedia.fromFilePath(filePath);
    if (asVoice) {
      // WhatsApp expects audio/ogg; codecs=opus for PTT (voice notes).
      // Browser-recorded webm/opus has the same codec inside a different container — relabel it.
      media.mimetype = 'audio/ogg; codecs=opus';
      if (filename) {
        media.filename = filename.replace(/\.(webm|m4a|mp3|wav|aac|mp4)$/i, '.ogg');
      } else {
        media.filename = 'voice.ogg';
      }
    } else {
      if (mimetype) media.mimetype = mimetype;
      if (filename) media.filename = filename;
    }
    const options = {};
    if (asVoice) options.sendAudioAsVoice = true;
    if (!asVoice && caption) options.caption = caption;
    return this.client.sendMessage(jid, media, options);
  }

  async destroy() { return this.stop(); }

  signalUnhealthy(err) {
    if (this.recycling || this.shuttingDown) return;
    logger.warn('Client signaled unhealthy by caller — scheduling recycle', {
      error: (err && err.message) || String(err)
    });
    this._scheduleRecycle({ reason: 'send_unhealthy', error: err });
  }

  // ---------- internals ----------

  _spawn() {
    if (this.shuttingDown) return;
    if (this.client) {
      logger.warn('_spawn called while a client already exists; skipping');
      return;
    }
    this.qrDataUrl = null;
    this.qrText = null;
    this.initAttempt += 1;

    this.client = new Client({
      authStrategy: new LocalAuth({ dataPath: AUTH_DIR }),
      qrMaxRetries: 5,
      authTimeoutMs: 120000,
      takeoverOnConflict: true,
      puppeteer: PUPPETEER_OPTS
    });

    this._wireEvents(this.client);

    logger.info(`WhatsApp initialize starting (attempt ${this.initAttempt})`);
    this._setState('initializing');

    const watchdog = setTimeout(() => {
      logger.warn('WhatsApp initialize is taking >60s — first run / cold cache can be slow');
    }, 60000);

    this.client.initialize()
      .then(() => { clearTimeout(watchdog); /* attempt counter resets when ready */ })
      .catch((err) => {
        clearTimeout(watchdog);
        const advice = this._adviceFor(err);
        logger.error('WhatsApp initialize failed', { error: err.message, attempt: this.initAttempt, advice });
        this._scheduleRecycle({ reason: 'init_failed', error: err });
      });
  }

  _wireEvents(client) {
    client.on('qr', async (qr) => {
      this.qrText = qr;
      try {
        this.qrDataUrl = await QRCode.toDataURL(qr, { width: 320, margin: 1 });
      } catch (e) {
        logger.error('Failed to render QR', { error: e.message });
      }
      this._setState('qr');
      logger.info('WhatsApp QR generated. Scan it from the dashboard.');
    });

    client.on('loading_screen', (percent, message) => {
      logger.info(`WhatsApp loading: ${percent}% ${message || ''}`);
    });

    client.on('authenticated', () => {
      logger.info('WhatsApp authenticated');
      this._setState('authenticated');
    });

    client.on('auth_failure', (msg) => {
      logger.error('WhatsApp auth failure', { msg });
      this._setState('auth_failure');
      this._scheduleRecycle({ reason: 'auth_failure', wipeAuth: true });
    });

    client.on('ready', () => {
      this.qrDataUrl = null;
      this.qrText = null;
      this.lastReadyAt = new Date().toISOString();
      this.initAttempt = 0;
      this._setState('ready');
      logger.info('WhatsApp client ready');
    });

    client.on('disconnected', (reason) => {
      this.lastDisconnectedAt = new Date().toISOString();
      this.lastDisconnectReason = reason;
      logger.warn('WhatsApp disconnected', { reason });
      this._setState('disconnected');
      this._scheduleRecycle({ reason: `disconnected:${reason}`, wipeAuth: reason === 'LOGOUT' });
    });

    client.on('change_state', (s) => logger.debug('WhatsApp internal state', { s }));
  }

  _scheduleRecycle({ reason, error, wipeAuth = false }) {
    if (this.shuttingDown) return;
    if (this.recycling) {
      logger.debug('Recycle already in progress, ignoring duplicate trigger', { reason });
      return;
    }
    this.recycling = true;
    this._setState('reconnecting');

    if (error) {
      const msg = error.message || '';
      if (/lockfile|already running for|EBUSY/i.test(msg)) {
        logger.info('Detected stuck Chromium / lockfile — will tear down before retry');
      }
    }

    const delay = Math.min(60000, 5000 * Math.max(1, this.initAttempt));
    logger.info(`Recycling WhatsApp client in ${delay}ms`, { reason, wipeAuth });

    setTimeout(async () => {
      try {
        await this._teardown();
        if (wipeAuth) await this._wipeAuth();
      } catch (e) {
        logger.warn('Error during recycle teardown', { error: e.message });
      } finally {
        this.recycling = false;
        this._spawn();
      }
    }, delay);
  }

  async _teardown() {
    if (!this.client) return;
    const c = this.client;
    this.client = null;
    try {
      await c.destroy();
    } catch (e) {
      logger.warn('client.destroy() threw, continuing', { error: e.message });
    }
    // Give Chromium a few seconds to fully exit and release the userDataDir lockfile.
    // On Windows the file handle release lags a bit behind the process exit.
    await sleep(3000);
  }

  async _wipeAuth() {
    try {
      await fs.rm(AUTH_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
      logger.warn('Wiped .wwebjs_auth/ — a fresh QR will be required');
    } catch (e) {
      logger.error('Failed to wipe .wwebjs_auth/', { error: e.message });
      logger.error('Stop the app, run "npm run reset:auth", then "npm start".');
    }
  }

  _adviceFor(err) {
    const m = (err && err.message) || '';
    if (/already running for|lockfile|EBUSY/i.test(m)) {
      return 'Stuck Chromium / locked userDataDir — the auto-recycle should clear it. If not: stop the app and run "npm run reset:cache".';
    }
    if (/protocolTimeout|callFunctionOn timed out|Navigation timeout/i.test(m)) {
      return 'Slow Chromium init. If repeated: npm run reset:cache && npm start';
    }
    if (/Failed to launch the browser process|spawn .* ENOENT/i.test(m)) {
      return 'Puppeteer cannot launch Chromium. Reinstall: rm -rf node_modules && npm install';
    }
    if (/EACCES|EPERM/i.test(m)) {
      return 'File permission issue — kill any leftover chrome.exe / node.exe, then retry.';
    }
    return 'See README "Troubleshooting" section.';
  }

  _setState(next) {
    if (this.state !== next) {
      const prev = this.state;
      this.state = next;
      this.emit('state', next, prev);
    }
  }
}

module.exports = new WhatsAppClient();
