const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const multer = require('multer');

const db = require('../db');
const logger = require('../logger');
const { normalizeRecipient } = require('../utils/phone');
const { parseRecurrence, nextOccurrence } = require('../utils/recurrence');
const { transcodeToVoiceOgg } = require('../utils/transcode');

const UPLOAD_DIR = path.join(__dirname, '..', '..', 'uploads');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const ALLOWED_AUDIO_MIMES = new Set([
  'audio/ogg', 'audio/oga', 'audio/opus',
  'audio/mpeg', 'audio/mp3',
  'audio/mp4', 'audio/x-m4a', 'audio/aac',
  'audio/wav', 'audio/x-wav',
  'audio/webm'
]);

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname || '') || guessExt(file.mimetype);
    cb(null, `${Date.now()}-${crypto.randomUUID()}${ext}`);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: 25 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const mt = (file.mimetype || '').toLowerCase().split(';')[0].trim();
    if (!ALLOWED_AUDIO_MIMES.has(mt)) {
      return cb(new Error(`Unsupported audio type: ${file.mimetype}`));
    }
    cb(null, true);
  }
});

function guessExt(mime) {
  const m = (mime || '').toLowerCase();
  if (m.includes('ogg') || m.includes('opus')) return '.ogg';
  if (m.includes('mpeg') || m.includes('mp3')) return '.mp3';
  if (m.includes('mp4') || m.includes('m4a') || m.includes('aac')) return '.m4a';
  if (m.includes('wav')) return '.wav';
  if (m.includes('webm')) return '.webm';
  return '';
}

const router = express.Router();

function safeUnlink(filePath) {
  if (!filePath) return;
  fs.unlink(filePath, (err) => {
    if (err && err.code !== 'ENOENT') {
      logger.warn('Failed to delete media file', { filePath, error: err.message });
    }
  });
}

function deleteIfOrphan(filePath) {
  if (!filePath) return;
  if (db.countByMediaPath(filePath) === 0) safeUnlink(filePath);
}

async function parseBody(req, existingMedia) {
  const body = req.body || {};
  const recipientInput = body.recipient;
  const messageText = String(body.message_text || body.message || '').trim();
  const sendAtInput = body.send_at;
  const chatTypeHint = body.chat_type;
  const recurrenceInput = body.recurrence;
  const messageType = String(body.message_type || 'text').toLowerCase();

  if (!['text', 'voice', 'audio'].includes(messageType)) {
    throw new Error('message_type must be one of: text, voice, audio');
  }
  if (!sendAtInput) throw new Error('send_at is required');

  const sendAtDate = new Date(sendAtInput);
  if (Number.isNaN(sendAtDate.getTime())) throw new Error('send_at is not a valid date');

  const { jid, chatType } = normalizeRecipient(recipientInput, chatTypeHint);
  const recurrence = parseRecurrence(recurrenceInput);

  const out = {
    recipient: jid,
    chat_type: chatType,
    message_type: messageType,
    message_text: messageText,
    send_at: sendAtDate.toISOString(),
    recurrence,
    media_path: null,
    media_mimetype: null,
    media_filename: null
  };

  if (messageType === 'voice' || messageType === 'audio') {
    if (req.file) {
      if (messageType === 'voice') {
        const transcoded = await transcodeToVoiceOgg(req.file.path);
        safeUnlink(req.file.path);
        out.media_path = transcoded;
        out.media_mimetype = 'audio/ogg; codecs=opus';
        out.media_filename = path.basename(transcoded);
        logger.info('Transcoded voice upload', { from: req.file.originalname, to: out.media_filename });
      } else {
        out.media_path = req.file.path;
        out.media_mimetype = req.file.mimetype;
        out.media_filename = req.file.originalname || path.basename(req.file.path);
      }
    } else if (existingMedia && existingMedia.media_path) {
      out.media_path = existingMedia.media_path;
      out.media_mimetype = existingMedia.media_mimetype;
      out.media_filename = existingMedia.media_filename;
    } else {
      throw new Error(`An audio file is required for message_type="${messageType}"`);
    }
  } else {
    if (!messageText) throw new Error('message_text is required for text messages');
  }

  return out;
}

function withNextRun(msg) {
  if (!msg) return msg;
  const next = msg.recurrence && msg.status === 'sent'
    ? nextOccurrence(msg.recurrence, msg.send_at)
    : null;
  return { ...msg, next_run: next };
}

router.get('/', (req, res) => {
  const all = db.listMessages().map(withNextRun);
  res.json({ messages: all });
});

router.get('/history', (req, res) => {
  const rows = db.listHistory();
  res.json({ messages: rows });
});

router.get('/:id', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const msg = db.getMessage(id);
  if (!msg) return res.status(404).json({ error: 'Not found' });
  res.json({ message: withNextRun(msg) });
});

router.get('/:id/media', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const msg = db.getMessage(id);
  if (!msg || !msg.media_path) return res.status(404).json({ error: 'No media' });
  if (!fs.existsSync(msg.media_path)) return res.status(404).json({ error: 'File missing on disk' });
  res.setHeader('Content-Type', msg.media_mimetype || 'application/octet-stream');
  fs.createReadStream(msg.media_path).pipe(res);
});

router.post('/', upload.single('audio'), async (req, res) => {
  try {
    const data = await parseBody(req);
    const created = db.createMessage(data);
    res.status(201).json({ message: withNextRun(created) });
  } catch (err) {
    if (req.file) safeUnlink(req.file.path);
    logger.warn('POST /api/messages failed', { error: err.message });
    res.status(400).json({ error: err.message });
  }
});

router.put('/:id', upload.single('audio'), async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const existing = db.getMessage(id);
  if (!existing) {
    if (req.file) safeUnlink(req.file.path);
    return res.status(404).json({ error: 'Not found' });
  }
  if (existing.status !== 'pending') {
    if (req.file) safeUnlink(req.file.path);
    return res.status(409).json({ error: `Cannot edit a message with status="${existing.status}"` });
  }

  try {
    const data = await parseBody(req, existing);
    const replacingMedia = req.file && existing.media_path && existing.media_path !== data.media_path;
    const updated = db.updateMessage(id, data);
    if (replacingMedia) deleteIfOrphan(existing.media_path);
    res.json({ message: withNextRun(updated) });
  } catch (err) {
    if (req.file) safeUnlink(req.file.path);
    logger.warn('PUT /api/messages/:id failed', { id, error: err.message });
    res.status(400).json({ error: err.message });
  }
});

router.delete('/:id', (req, res) => {
  const existing = db.getMessage(parseInt(req.params.id, 10));
  if (!existing) return res.status(404).json({ error: 'Not found' });
  const ok = db.deleteMessage(existing.id);
  if (!ok) return res.status(404).json({ error: 'Not found' });
  deleteIfOrphan(existing.media_path);
  res.json({ ok: true });
});

router.use((err, req, res, next) => {
  if (err instanceof multer.MulterError || /Unsupported audio type/.test(err.message)) {
    return res.status(400).json({ error: err.message });
  }
  next(err);
});

module.exports = router;
