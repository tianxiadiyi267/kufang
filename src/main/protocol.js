'use strict';
/* Fixed, stable origin app://local so IndexedDB survives restarts. */
const fs = require('node:fs');
const path = require('node:path');
const { protocol } = require('electron');

const SCHEME = 'app';
const HOST = 'local';
const URL_BASE = SCHEME + '://' + HOST + '/';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.wasm': 'application/wasm',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.svg': 'image/svg+xml'
};

function registerSchemes() {
  // MUST run before app.whenReady()
  protocol.registerSchemesAsPrivileged([{
    scheme: SCHEME,
    privileges: { standard: true, secure: true, allowServiceWorkers: true, supportFetchAPI: true, corsEnabled: true }
  }]);
}
function registerHandler(appDir) {
  const root = path.resolve(appDir);
  protocol.handle(SCHEME, request => {
    let rel;
    try { rel = decodeURIComponent(new URL(request.url).pathname).replace(/^\/+/, ''); }
    catch (_) { return new Response('Bad request', { status: 400 }); }
    if (!rel) rel = 'index.html';
    const full = path.resolve(root, rel);
    if (full !== root && !full.startsWith(root + path.sep)) {
      return new Response('Forbidden', { status: 403 });
    }
    let buf;
    try {
      if (!fs.statSync(full).isFile()) throw new Error('not a file');
      buf = fs.readFileSync(full);
    } catch (_) {
      // Missing assets/login-scape.* is expected: the page hides it via onerror.
      return new Response('Not found', { status: 404 });
    }
    const ext = path.extname(full).toLowerCase();
    return new Response(new Uint8Array(buf), {
      status: 200,
      headers: { 'content-type': MIME[ext] || 'application/octet-stream' }
    });
  });
}
module.exports = { registerSchemes, registerHandler, URL_BASE };
