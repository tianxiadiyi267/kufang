'use strict';
/* One-time first-run migration: provide the bundled .db bytes to the renderer,
   which writes them into IndexedDB (that is where this app actually persists). */
const fs = require('node:fs');
const path = require('node:path');
const { app } = require('electron');

const MAGIC = Buffer.from('SQLite format 3\0', 'latin1');
let seedFile = null;
let flag = null;

function init(userData) {
  const candidates = [
    path.join(process.resourcesPath || '', 'seed', 'seed.db'),
    path.join(app.getAppPath(), 'resources', 'seed', 'seed.db')
  ];
  seedFile = candidates.find(p => { try { return fs.existsSync(p); } catch (_) { return false; } }) || candidates[0];
  flag = path.join(userData, 'seeded.flag');
}
function exists() { try { return fs.existsSync(seedFile); } catch (_) { return false; } }
function needed() { return exists() && !fs.existsSync(flag); }
function bytes() {
  const b = fs.readFileSync(seedFile);
  if (b.length < 512 || !b.subarray(0, 16).equals(MAGIC)) throw new Error('INVALID_SEED_DB');
  return b;
}
function markDone(note) {
  fs.writeFileSync(flag, new Date().toISOString() + ' ' + String(note || ''), 'utf8');
}
function reset() { try { if (fs.existsSync(flag)) fs.unlinkSync(flag); } catch (_) {} }

module.exports = { init, exists, needed, bytes, markDone, reset };
