#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

const target = (process.argv[2] || 'cache').toLowerCase();
const root = path.join(__dirname, '..');

const groups = {
  cache: ['.wwebjs_cache'],
  auth: ['.wwebjs_auth'],
  all: ['.wwebjs_cache', '.wwebjs_auth']
};

const dirs = groups[target];
if (!dirs) {
  console.error(`Unknown target "${target}". Use: cache | auth | all`);
  process.exit(1);
}

console.log(`Resetting: ${dirs.join(', ')}`);
let failures = 0;
for (const d of dirs) {
  const p = path.join(root, d);
  if (!fs.existsSync(p)) {
    console.log(`  - ${d}: not present, skipped`);
    continue;
  }
  try {
    fs.rmSync(p, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    console.log(`  - ${d}: removed`);
  } catch (err) {
    failures += 1;
    console.error(`  - ${d}: FAILED — ${err.message}`);
    console.error('    (a leftover chrome.exe / node.exe may be holding files. Kill it first.)');
  }
}

if (failures > 0) process.exit(2);
console.log('Done. Start the app with: npm start');
