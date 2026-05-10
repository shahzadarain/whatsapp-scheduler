const cron = require('node-cron');

const PRESETS = new Set(['daily', 'weekly', 'monthly']);

function parseRecurrence(input) {
  if (input === undefined || input === null || input === '') return null;
  const value = String(input).trim().toLowerCase();
  if (!value || value === 'none' || value === 'once') return null;

  if (PRESETS.has(value)) return value;

  const cronExpr = String(input).trim();
  if (!cron.validate(cronExpr)) {
    throw new Error(`Invalid recurrence: "${input}". Use one of daily, weekly, monthly, or a valid cron expression.`);
  }
  return cronExpr;
}

function nextOccurrence(recurrence, fromIso) {
  if (!recurrence) return null;

  const from = new Date(fromIso);
  if (Number.isNaN(from.getTime())) {
    throw new Error('Invalid base date for recurrence');
  }

  if (recurrence === 'daily') {
    return new Date(from.getTime() + 24 * 60 * 60 * 1000).toISOString();
  }
  if (recurrence === 'weekly') {
    return new Date(from.getTime() + 7 * 24 * 60 * 60 * 1000).toISOString();
  }
  if (recurrence === 'monthly') {
    const d = new Date(from.getTime());
    d.setUTCMonth(d.getUTCMonth() + 1);
    return d.toISOString();
  }

  return nextCronOccurrence(recurrence, from).toISOString();
}

function nextCronOccurrence(expr, from) {
  const parts = expr.trim().split(/\s+/);
  let minute, hour, dom, month, dow;
  if (parts.length === 5) [minute, hour, dom, month, dow] = parts;
  else if (parts.length === 6) [, minute, hour, dom, month, dow] = parts;
  else throw new Error('Cron expression must have 5 or 6 fields');

  const matchers = {
    minute: buildMatcher(minute, 0, 59),
    hour: buildMatcher(hour, 0, 23),
    dom: buildMatcher(dom, 1, 31),
    month: buildMatcher(month, 1, 12),
    dow: buildMatcher(dow, 0, 6)
  };

  const candidate = new Date(from.getTime() + 60 * 1000);
  candidate.setUTCSeconds(0, 0);

  const limit = 366 * 24 * 60;
  for (let i = 0; i < limit; i++) {
    if (
      matchers.minute(candidate.getUTCMinutes()) &&
      matchers.hour(candidate.getUTCHours()) &&
      matchers.month(candidate.getUTCMonth() + 1) &&
      matchers.dom(candidate.getUTCDate()) &&
      matchers.dow(candidate.getUTCDay())
    ) {
      return candidate;
    }
    candidate.setUTCMinutes(candidate.getUTCMinutes() + 1);
  }
  throw new Error('Could not find next cron occurrence within 1 year');
}

function buildMatcher(field, min, max) {
  if (field === '*') return () => true;
  const allowed = new Set();
  for (const part of field.split(',')) {
    const stepSplit = part.split('/');
    const range = stepSplit[0];
    const step = stepSplit[1] ? parseInt(stepSplit[1], 10) : 1;
    let lo, hi;
    if (range === '*') {
      lo = min; hi = max;
    } else if (range.includes('-')) {
      const [a, b] = range.split('-').map(n => parseInt(n, 10));
      lo = a; hi = b;
    } else {
      const n = parseInt(range, 10);
      lo = n; hi = n;
    }
    for (let v = lo; v <= hi; v += step) allowed.add(v);
  }
  return (v) => allowed.has(v);
}

module.exports = { parseRecurrence, nextOccurrence };
