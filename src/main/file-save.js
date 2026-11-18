'use strict';
/* Export files by writing bytes directly from the main process.
   Replaces the old Chromium `a.download` + will-download pipeline, whose
   blob URL was revoked 100ms after click while the native save dialog is
   asynchronous -> "saved to desktop but no file". */
const fs = require('node:fs');
const path = require('node:path');
const { app, dialog, BrowserWindow } = require('electron');

const MAX_BYTES = 64 * 1024 * 1024;

function safeName(name) {
  let s = path.basename(String(name || '导出文件'));
  s = s.replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').replace(/^\.+/, '').slice(0, 180).trim();
  return s || '导出文件';
}

function filtersFor(name) {
  const ext = path.extname(name).toLowerCase();
  const list = [];
  if (ext === '.pdf') list.push({ name: 'PDF 文档', extensions: ['pdf'] });
  else if (ext === '.xlsx' || ext === '.xls') list.push({ name: 'Excel 工作簿', extensions: ['xlsx', 'xls'] });
  else if (ext === '.db' || ext === '.sqlite' || ext === '.sqlite3') list.push({ name: 'SQLite 数据库', extensions: ['db', 'sqlite', 'sqlite3'] });
  list.push({ name: '所有文件', extensions: ['*'] });
  return list;
}

function readableError(e) {
  const code = e && e.code ? e.code + '：' : '';
  if (e && (e.code === 'EPERM' || e.code === 'EACCES')) {
    return code + '没有写入权限。若为桌面/文档目录，请检查 Windows「受控文件夹访问」是否拦截了本程序，或另选一个可写目录。';
  }
  if (e && e.code === 'ENOSPC') return code + '磁盘空间不足。';
  if (e && e.code === 'ENOENT') return code + '目录不存在或不可访问。';
  return code + String((e && e.message) || '未知写入错误');
}

function currentWindow() {
  return BrowserWindow.getFocusedWindow()
    || BrowserWindow.getAllWindows().find(w => !w.isDestroyed())
    || null;
}

/* ctx: { audit, user, role }; testDir: absolute path or null (dev-only test hook) */
async function save({ name, data, mime }, ctx, testDir) {
  const audit = ctx && ctx.audit;
  const who = {
    user: (ctx && ctx.user) || '-',
    role: (ctx && ctx.role) || '-',
    src: 'file'
  };
  const fail = (code, message, detail) => {
    if (audit) {
      try {
        audit.append({
          ...who, action: 'exportFileFailed', result: 'fail',
          detail: String(detail || code || '').slice(0, 300)
        });
      } catch (_) {}
    }
    return { ok: false, code, message };
  };
  const ok = (target, size, safe) => {
    if (audit) {
      try {
        audit.append({
          ...who, action: 'exportFile', result: 'ok',
          detail: safe + ' ' + size + 'B -> ' + String(target).slice(-160)
        });
      } catch (_) {}
    }
    return { ok: true, path: target, size };
  };

  const u8 = data instanceof Uint8Array ? data : new Uint8Array(data || []);
  if (!u8.byteLength) return fail('EMPTY', '导出内容为空，未生成文件', 'EMPTY');
  if (u8.byteLength > MAX_BYTES) return fail('TOO_LARGE', '导出文件超过 64 MB 上限', 'TOO_LARGE');

  const buf = Buffer.from(u8.buffer, u8.byteOffset, u8.byteLength);
  const safe = safeName(name);
  let target;

  if (testDir) {
    target = path.join(testDir, safe);
  } else {
    let r;
    try {
      r = await dialog.showSaveDialog(currentWindow(), {
        title: '保存导出文件',
        defaultPath: path.join(app.getPath('desktop'), safe),
        filters: filtersFor(safe)
      });
    } catch (e) {
      return fail('DIALOG_FAILED', '打开保存对话框失败：' + ((e && e.message) || e), 'dialog ' + ((e && e.code) || ''));
    }
    if (!r || r.canceled || !r.filePath) return { ok: false, code: 'CANCELED', message: '已取消保存' };
    target = path.resolve(r.filePath);
  }

  const tmp = target + '.tmp-' + process.pid + '-' + Date.now();
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(tmp, buf);
    fs.renameSync(tmp, target);
    return ok(target, buf.length, safe);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch (_) {}
    const message = readableError(e);
    if (e && (e.code === 'EPERM' || e.code === 'EACCES')) {
      try {
        dialog.showErrorBox('保存失败',
          '无法写入该位置：\n' + target + '\n\n' + message +
          '\n\n文件未被保存，请重新导出并另选目录。');
      } catch (_) {}
    }
    return fail((e && e.code) || 'WRITE_FAILED', message, (e && e.code) + ' ' + target);
  }
}

module.exports = { save, safeName, filtersFor };
