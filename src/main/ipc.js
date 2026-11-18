'use strict';
/* All IPC channels. The main process trusts ONLY its own session table. */
const { ipcMain, app } = require('electron');
const { hasPerm } = require('../shared/permissions');
const path = require('node:path');
const fileSave = require('./file-save');

/* dev-only test hook: never active in a packaged app, and dev uses a separate userData. */
const EXPORT_TEST_DIR = (!app.isPackaged && process.env.WH_EXPORT_TEST_DIR)
  ? path.resolve(process.env.WH_EXPORT_TEST_DIR)
  : null;

const ACTION_MAX = 64;
const DETAIL_MAX = 500;
function clip(v, n) { return String(v == null ? '' : v).slice(0, n); }

function register(ctx) {
  const { auth, audit, seed, version, userData, windowState } = ctx;

  const handle = (channel, fn) => ipcMain.handle(channel, async (_event, payload) => {
    try { return await fn(payload || {}); }
    catch (e) {
      audit.append({ action: 'ipcError', result: 'fail', detail: channel + ': ' + clip(e && e.message, 200), src: 'ipc' });
      return { ok: false, code: 'INTERNAL', message: (e && e.message) || '内部错误' };
    }
  });

  const sess = token => auth.session(token);
  const deny = (action, detail, code) => {
    audit.append({ action: 'authorize_deny', result: 'fail', detail: clip(action + ' ' + (detail || ''), DETAIL_MAX), src: 'ipc' });
    return { ok: false, code: code || 'NO_PERM' };
  };

  handle('wh:auth/status', p => ({ ok: true, ...auth.status(p.token) }));

  handle('wh:auth/setup', p => {
    if (auth.isInitialized()) return deny('setup', 'already initialized', 'ALREADY_INITIALIZED');
    const r = auth.setup(p.adminPwd, p.operatorPwd);
    audit.append({ action: 'setup', result: r.ok ? 'ok' : 'fail', detail: r.code || 'passwords created', src: 'ipc' });
    return r;
  });

  handle('wh:auth/login', p => {
    const r = auth.login(String(p.user || ''), String(p.pwd || ''));
    if (r.ok) {
      audit.append({ user: r.role === 'admin' ? 'admin' : 'operator', role: r.role, action: 'login', result: 'ok', src: 'ipc' });
    } else {
      audit.append({ user: clip(p.user, 32), role: '-', action: 'login_fail', result: 'fail', detail: r.code || '', src: 'ipc' });
    }
    return r;
  });

  handle('wh:auth/logout', p => {
    const s = sess(p.token);
    auth.logout(p.token);
    audit.append({ user: s ? s.user : '-', role: s ? s.role : '-', action: 'logout', result: 'ok', src: 'ipc' });
    return { ok: true };
  });

  handle('wh:auth/authorize', p => {
    const r = auth.authorize(p.token, p.perm, !!p.sensitive);
    if (!r.ok) return deny(p.perm, r.code, r.code);
    return r;
  });

  handle('wh:auth/confirm', p => {
    const s = sess(p.token);
    if (!s) return deny('confirm', 'no session', 'NO_SESSION');
    if (!hasPerm(s.role, p.perm)) return deny('confirm', 'no perm', 'NO_PERM');
    if (!auth.consumeChallenge(p.token, p.perm, p.challenge)) return deny('confirm', 'bad challenge', 'BAD_CHALLENGE');
    audit.append({ user: s.user, role: s.role, action: clip(p.action || 'confirm', ACTION_MAX), result: 'ok', detail: 'perm=' + clip(p.perm, 32), src: 'ipc' });
    return { ok: true };
  });

  handle('wh:auth/changePwd', p => {
    const s = sess(p.token);
    const r = auth.changePwd(p.token, p.oldPwd, p.newPwd);
    audit.append({ user: s ? s.user : '-', role: s ? s.role : '-', action: 'changePwd', result: r.ok ? 'ok' : 'fail', detail: r.code || '', src: 'ipc' });
    return r;
  });

  handle('wh:auth/resetPwd', p => {
    const s = sess(p.token);
    const r = auth.resetPwd(p.token, p.target, p.newPwd, p.challenge);
    audit.append({ user: s ? s.user : '-', role: s ? s.role : '-', action: 'resetPwd', result: r.ok ? 'ok' : 'fail', detail: clip((r.code || '') + ' target=' + p.target, DETAIL_MAX), src: 'ipc' });
    return r;
  });

  // First-run seed import intentionally requires NO session: it runs before login.
  handle('wh:seed/import', () => {
    if (!seed.needed()) return { ok: true, needed: false };
    const b = seed.bytes();
    audit.append({ action: 'seedImport', result: 'ok', detail: 'providing ' + b.length + ' bytes', src: 'ipc' });
    return { ok: true, needed: true, bytes: b.toString('base64'), size: b.length };
  });

  handle('wh:seed/done', p => {
    seed.markDone(p.note || 'renderer-confirmed');
    audit.append({ action: 'seedImport', result: 'ok', detail: 'seeded.flag written', src: 'ipc' });
    return { ok: true };
  });

  handle('wh:audit/query', p => {
    const r = auth.authorize(p.token, 'auditView');
    if (!r.ok) return deny('audit/query', r.code, r.code);
    return { ok: true, ...audit.query({ from: p.from, to: p.to, limit: p.limit }) };
  });

  handle('wh:audit/log', p => {
    const s = sess(p.token);
    if (!s) return deny('audit/log', 'no session', 'NO_SESSION');
    audit.append({
      user: s.user, role: s.role,
      action: clip(p.action, ACTION_MAX),
      detail: clip(p.detail, DETAIL_MAX),
      result: p.result === 'fail' ? 'fail' : 'ok',
      src: 'renderer'
    });
    return { ok: true };
  });

  // Direct file write for all exports. Only a valid login session is required:
  // most Excel/PDF/template exports are NOT wrapped by GUARDED, so requiring a
  // specific perm here would silently break the operator role.
  handle('wh:file/save', async p => {
    const s = sess(p.token);
    if (!s) {
      audit.append({ action: 'exportFileFailed', result: 'fail', detail: 'NO_SESSION', src: 'ipc' });
      return { ok: false, code: 'NO_SESSION', message: '会话已失效，请重新登录后再导出' };
    }
    return await fileSave.save(
      { name: p.name, data: p.data, mime: p.mime },
      { audit, user: s.user, role: s.role },
      EXPORT_TEST_DIR
    );
  });

  handle('wh:app/info', () => ({ ok: true, version: version || app.getVersion(), userDataPath: userData || app.getPath('userData') }));

  // Diagnostics: lets verification assert the window is really visible,
  // instead of only checking that the renderer script loaded.
  handle('wh:diag/windowState', () => ({ ok: true, ...(windowState ? windowState() : { exists: false, visible: false }) }));
}

module.exports = { register };
