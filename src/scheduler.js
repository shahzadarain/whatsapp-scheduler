const fs = require('fs');
const cron = require('node-cron');
const db = require('./db');
const logger = require('./logger');
const whatsappClient = require('./whatsapp-client');
const { nextOccurrence } = require('./utils/recurrence');

const RATE_LIMIT_MS = parseInt(process.env.RATE_LIMIT_MS || '4000', 10);
const SEND_MISSED_ON_STARTUP = String(process.env.SEND_MISSED_ON_STARTUP || 'false').toLowerCase() === 'true';

const TRANSIENT_PATTERNS = /detached Frame|Target closed|Session closed|Protocol error|Execution context was destroyed|Connection closed|page has been closed|Cannot read propert(?:y|ies) of (null|undefined)/i;

function isTransientClientError(err) {
  const m = (err && err.message) || String(err || '');
  return TRANSIENT_PATTERNS.test(m);
}

let task = null;
let running = false;

function nowIso() {
  return new Date().toISOString();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function processDueMessages({ ignoreOldThreshold = false } = {}) {
  if (running) {
    logger.debug('Scheduler tick skipped — previous run still in progress');
    return;
  }
  if (!whatsappClient.isReady()) {
    logger.debug('Scheduler tick skipped — WhatsApp client not ready');
    return;
  }
  running = true;
  try {
    const due = db.listPendingDue(nowIso());
    if (!due.length) return;
    logger.info(`Scheduler picked up ${due.length} due message(s)`);

    for (const msg of due) {
      if (!ignoreOldThreshold && shouldSkipAsMissed(msg)) {
        logger.warn('Skipping missed message (older than threshold and SEND_MISSED_ON_STARTUP=false)', {
          id: msg.id, send_at: msg.send_at
        });
        db.markFailed(msg.id, 'Skipped: missed during downtime (SEND_MISSED_ON_STARTUP=false)');
        rolloverIfRecurring(msg);
        continue;
      }

      if (!whatsappClient.isReady()) {
        logger.warn('Client became not-ready mid-batch; deferring remaining messages');
        break;
      }

      const result = await sendOne(msg);
      if (result === 'transient') {
        logger.warn('Stopping batch due to transient client error — recycle scheduled, message stays pending');
        break;
      }
      await sleep(RATE_LIMIT_MS);
    }
  } catch (err) {
    logger.error('Scheduler tick error', { error: err.message });
  } finally {
    running = false;
  }
}

function shouldSkipAsMissed(msg) {
  if (SEND_MISSED_ON_STARTUP) return false;
  const ageMs = Date.now() - new Date(msg.send_at).getTime();
  return ageMs > 5 * 60 * 1000;
}

async function sendOne(msg) {
  const jid = buildJid(msg);
  const messageType = msg.message_type || 'text';
  try {
    logger.info('Sending message', {
      id: msg.id, recipient: msg.recipient, chat_type: msg.chat_type, message_type: messageType
    });

    if (messageType === 'voice' || messageType === 'audio') {
      if (!msg.media_path) throw new Error('Media path missing for voice/audio message');
      if (!fs.existsSync(msg.media_path)) {
        throw new Error(`Media file not found on disk: ${msg.media_path}`);
      }
      await whatsappClient.sendMedia(jid, msg.media_path, {
        mimetype: msg.media_mimetype,
        filename: msg.media_filename,
        asVoice: messageType === 'voice',
        caption: msg.message_text
      });
    } else {
      await whatsappClient.sendMessage(jid, msg.message_text);
    }

    const sentAt = nowIso();
    db.markSent(msg.id, sentAt);
    logger.info('Message sent', { id: msg.id, sent_at: sentAt });
    rolloverIfRecurring(msg);
    return 'sent';
  } catch (err) {
    const errorMessage = err && err.message ? err.message : String(err);

    if (isTransientClientError(err)) {
      logger.warn('Transient client error during send — leaving message pending', {
        id: msg.id, error: errorMessage
      });
      whatsappClient.signalUnhealthy(err);
      return 'transient';
    }

    db.markFailed(msg.id, errorMessage);
    logger.error('Send failed', { id: msg.id, error: errorMessage });
    rolloverIfRecurring(msg);
    return 'failed';
  }
}

function buildJid(msg) {
  const recipient = msg.recipient.trim();
  if (recipient.endsWith('@c.us') || recipient.endsWith('@g.us')) return recipient;
  if (msg.chat_type === 'group') return `${recipient}@g.us`;
  return `${recipient}@c.us`;
}

function rolloverIfRecurring(msg) {
  if (!msg.recurrence) return;
  try {
    const next = nextOccurrence(msg.recurrence, msg.send_at);
    if (!next) return;
    const newRow = db.createMessage({
      recipient: msg.recipient,
      chat_type: msg.chat_type,
      message_type: msg.message_type || 'text',
      message_text: msg.message_text,
      media_path: msg.media_path,
      media_mimetype: msg.media_mimetype,
      media_filename: msg.media_filename,
      send_at: next,
      recurrence: msg.recurrence
    });
    logger.info('Recurring message rolled over', { from_id: msg.id, new_id: newRow.id, next });
  } catch (err) {
    logger.error('Failed to roll over recurring message', { id: msg.id, error: err.message });
  }
}

function start() {
  if (task) return;
  task = cron.schedule('* * * * *', () => processDueMessages());
  logger.info('Scheduler started (cron: every minute)', { rate_limit_ms: RATE_LIMIT_MS });

  whatsappClient.on('state', async (next, prev) => {
    if (next === 'ready' && prev !== 'ready') {
      logger.info('WhatsApp ready — running catch-up tick');
      await processDueMessages();
    }
  });
}

function stop() {
  if (task) {
    task.stop();
    task = null;
    logger.info('Scheduler stopped');
  }
}

module.exports = { start, stop, processDueMessages };
