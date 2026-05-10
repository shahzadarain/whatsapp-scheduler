const path = require('path');
const express = require('express');
const messagesRouter = require('./routes/messages');
const whatsappClient = require('./whatsapp-client');
const logger = require('./logger');

function createServer() {
  const app = express();

  app.use(express.json({ limit: '256kb' }));
  app.use(express.static(path.join(__dirname, '..', 'public')));

  app.use('/api/messages', messagesRouter);

  app.get('/api/status', (req, res) => {
    const status = whatsappClient.getStatus();
    res.json({
      ...status,
      timezone: process.env.TIMEZONE || 'UTC',
      server_time: new Date().toISOString()
    });
  });

  app.get('/api/qr', (req, res) => {
    const dataUrl = whatsappClient.getQrDataUrl();
    if (!dataUrl) return res.status(404).json({ error: 'No QR available' });
    res.json({ qr: dataUrl });
  });

  app.use((err, req, res, next) => {
    logger.error('Unhandled API error', { error: err.message, stack: err.stack });
    res.status(500).json({ error: 'Internal server error' });
  });

  return app;
}

module.exports = { createServer };
