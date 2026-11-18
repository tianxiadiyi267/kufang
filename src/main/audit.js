'use strict';
/* Append-only JSON Lines audit log, owned exclusively by the main process. */
const fs = require('node:fs');
const path = require('node:path');

let dir = null;
const RETENTION_DAYS = 180;

function ymd(d) {
  const p = n => String(n).padStart(2, '0');
  return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate());
}
function init(userData) {
  dir = path.join(userData, 'audit');
  fs.mkdirSync(dir, { recursive: true });
  prune();
}
function append(entry) {
  if (!dir) return;
  const row = {
    ts: new Date().toISOString(),
    user: '-', role: '-', action: '', result: 'ok', detail: '', src: 'ipc',
    ...(entry || {})
  };
  try {
    fs.appendFileSync(path.join(dir, 'audit-' + ymd(new Date()) + '.log'),
      JSON.stringify(row) + '\n', 'utf8');
  } catch (e) { console.error('[audit] append failed', e); }
}
function query(opts) {
  if (!dir) return { rows: [] };
  const { from, to, limit } = opts || {};
  const max = Math.min(Math.max(Number(limit) || 500, 1), 5000);
  const rows = [];
  try {
    for (const name of fs.readdirSync(dir)) {
      if (!/^audit-\d{8}\.log$/.test(name)) continue;
      const text = fs.readFileSync(path.join(dir, name), 'utf8');
      for (const line of text.split('\n')) {
        if (!line.trim()) continue;
        try {
          const r = JSON.parse(line);
          if (from && r.ts < from) continue;
          if (to && r.ts > to) continue;
          rows.push(r);
        } catch (_) { /* skip a broken line */ }
      }
    }
  } catch (e) { console.error('[audit] query failed', e); }
  rows.sort((a, b) => String(b.ts).localeCompare(String(a.ts)));
  return { rows: rows.slice(0, max) };
}
function prune() {
  try {
    const cutoff = Date.now() - RETENTION_DAYS * 86400000;
    for (const name of fs.readdirSync(dir)) {
      const m = /^audit-(\d{4})(\d{2})(\d{2})\.log$/.exec(name);
      if (!m) continue;
      const t = new Date(+m[1], +m[2] - 1, +m[3]).getTime();
      if (t < cutoff) fs.unlinkSync(path.join(dir, name));
    }
  } catch (_) { /* non-fatal */ }
}
module.exports = { init, append, query };
