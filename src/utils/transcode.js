const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { execSync } = require('child_process');
const ffmpeg = require('fluent-ffmpeg');
const logger = require('../logger');

let resolvedFfmpegPath = null;
let resolvedSource = 'unresolved';

resolveFfmpeg();

function bind(p, source) {
  resolvedFfmpegPath = p;
  resolvedSource = source;
  ffmpeg.setFfmpegPath(p);
  // Belt and suspenders — fluent-ffmpeg also honors this env var,
  // and it survives across any internal cache resets.
  process.env.FFMPEG_PATH = p;
}

function resolveFfmpeg() {
  // 1. Bundled @ffmpeg-installer/ffmpeg
  try {
    const inst = require('@ffmpeg-installer/ffmpeg');
    if (inst && inst.path && fs.existsSync(inst.path)) {
      bind(inst.path, '@ffmpeg-installer/ffmpeg');
      logger.info('Using bundled ffmpeg', { path: inst.path });
      verifyBinary(inst.path);
      return;
    }
    logger.warn('@ffmpeg-installer/ffmpeg loaded but binary missing on disk', {
      reported_path: inst && inst.path,
      exists: inst && inst.path ? fs.existsSync(inst.path) : false
    });
  } catch (e) {
    logger.warn('@ffmpeg-installer/ffmpeg not loadable', { error: e.message });
  }

  // 2. Manually look in node_modules (handles optional-dep skips)
  try {
    const platform = `${process.platform}-${process.arch}`;
    const expected = path.join(
      __dirname, '..', '..', 'node_modules', '@ffmpeg-installer', platform,
      process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg'
    );
    if (fs.existsSync(expected)) {
      bind(expected, `manual-lookup:${platform}`);
      logger.info('Using ffmpeg from manual node_modules lookup', { path: expected });
      verifyBinary(expected);
      return;
    }
  } catch (_) { /* ignore */ }

  // 3. System ffmpeg from PATH
  try {
    const cmd = process.platform === 'win32' ? 'where ffmpeg' : 'which ffmpeg';
    const found = execSync(cmd, { stdio: ['ignore', 'pipe', 'ignore'] }).toString().split(/\r?\n/)[0].trim();
    if (found && fs.existsSync(found)) {
      bind(found, 'system-path');
      logger.warn('Using system ffmpeg from PATH (bundled binary not found)', { path: found });
      verifyBinary(found);
      return;
    }
  } catch (_) { /* not on PATH */ }

  // 4. Nothing available
  resolvedFfmpegPath = null;
  resolvedSource = 'none';
  logger.error('No ffmpeg binary available — voice transcoding will fail.');
  logger.error('Fix: stop the app, then run:  npm install @ffmpeg-installer/ffmpeg --include=optional');
}

function verifyBinary(binPath) {
  try {
    const out = execSync(`"${binPath}" -version`, { stdio: ['ignore', 'pipe', 'pipe'], timeout: 10000 }).toString();
    const firstLine = out.split(/\r?\n/)[0];
    logger.info('ffmpeg verified', { version_line: firstLine });
  } catch (e) {
    logger.error('ffmpeg binary failed verification — voice transcoding will fail', {
      path: binPath,
      error: e.message
    });
    resolvedFfmpegPath = null;
    resolvedSource = `${resolvedSource}:broken`;
  }
}

function getFfmpegPath() {
  return resolvedFfmpegPath;
}

function getFfmpegSource() {
  return resolvedSource;
}

async function transcodeToVoiceOgg(inputPath) {
  if (!resolvedFfmpegPath) {
    throw new Error(
      'ffmpeg not available on this server — cannot transcode voice messages. ' +
      'Run: npm install @ffmpeg-installer/ffmpeg --include=optional'
    );
  }

  // Re-bind defensively in case anything (or another module loaded later)
  // reset fluent-ffmpeg's internal cache.
  ffmpeg.setFfmpegPath(resolvedFfmpegPath);
  process.env.FFMPEG_PATH = resolvedFfmpegPath;

  const dir = path.dirname(inputPath);
  const base = path.basename(inputPath, path.extname(inputPath));
  const outputPath = path.join(dir, `${base}.voice.ogg`);

  logger.info('Transcoding voice', { input: inputPath, output: outputPath, ffmpeg: resolvedFfmpegPath });

  await new Promise((resolve, reject) => {
    ffmpeg(inputPath)
      .noVideo()
      .audioCodec('libopus')
      .audioChannels(1)
      .audioFrequency(16000)
      .audioBitrate('32k')
      .outputOptions(['-application voip'])
      .format('ogg')
      .on('start', (cmd) => logger.info('ffmpeg invocation', { cmd }))
      .on('error', (err) => reject(new Error(`ffmpeg failed: ${err.message} (using path=${resolvedFfmpegPath})`)))
      .on('end', () => resolve())
      .save(outputPath);
  });

  const stat = fs.statSync(outputPath);
  if (!stat.size) {
    await fsp.unlink(outputPath).catch(() => {});
    throw new Error('Transcoded voice file is empty');
  }
  return outputPath;
}

module.exports = { transcodeToVoiceOgg, getFfmpegPath, getFfmpegSource };
