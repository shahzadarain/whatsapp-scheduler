require('dotenv').config();

const logger = require('./logger');
const whatsappClient = require('./whatsapp-client');
const scheduler = require('./scheduler');
const { createServer } = require('./server');
const { getFfmpegPath, getFfmpegSource } = require('./utils/transcode');

const PORT = parseInt(process.env.PORT || '3000', 10);

function main() {
  logger.info('Starting whatsapp-scheduler', {
    port: PORT,
    timezone: process.env.TIMEZONE || 'UTC',
    send_missed: process.env.SEND_MISSED_ON_STARTUP || 'false',
    rate_limit_ms: process.env.RATE_LIMIT_MS || '4000',
    ffmpeg: getFfmpegPath(),
    ffmpeg_source: getFfmpegSource()
  });

  whatsappClient.start();
  scheduler.start();

  const app = createServer();
  const server = app.listen(PORT, () => {
    logger.info(`Dashboard listening at http://localhost:${PORT}`);
  });

  const shutdown = async (signal) => {
    logger.info(`Received ${signal}, shutting down gracefully...`);
    scheduler.stop();
    server.close(() => logger.info('HTTP server closed'));
    try {
      await whatsappClient.destroy();
    } catch (e) {
      logger.warn('Error during WhatsApp client shutdown', { error: e.message });
    }
    setTimeout(() => process.exit(0), 1500).unref();
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('unhandledRejection', (reason) => {
    logger.error('Unhandled promise rejection', { reason: reason && reason.message ? reason.message : String(reason) });
  });
  process.on('uncaughtException', (err) => {
    logger.error('Uncaught exception', { error: err.message, stack: err.stack });
  });
}

main();
