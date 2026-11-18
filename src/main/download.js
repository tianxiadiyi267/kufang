'use strict';
/* Turn a.download (Blob) into a native "Save as" dialog. */
const path = require('node:path');
const { app, dialog, BrowserWindow } = require('electron');

function attach(ses, audit) {
  ses.on('will-download', (event, item, webContents) => {
    event.preventDefault();
    const suggested = item.getFilename() || '导出文件';
    const win = BrowserWindow.fromWebContents(webContents) || BrowserWindow.getFocusedWindow();
    const ext = path.extname(suggested).toLowerCase();
    const filters = [{ name: '所有文件', extensions: ['*'] }];
    if (ext === '.pdf') filters.unshift({ name: 'PDF 文档', extensions: ['pdf'] });
    if (ext === '.xlsx') filters.unshift({ name: 'Excel 工作簿', extensions: ['xlsx'] });
    if (ext === '.db' || ext === '.sqlite') filters.unshift({ name: 'SQLite 数据库', extensions: ['db', 'sqlite', 'sqlite3'] });

    dialog.showSaveDialog(win, {
      title: '保存导出文件',
      defaultPath: path.join(app.getPath('documents'), suggested),
      filters
    }).then(r => {
      if (r.canceled || !r.filePath) { item.cancel(); return; }
      item.setSavePath(r.filePath);
      item.once('done', (_e, state) => {
        if (audit) audit.append({ action: state === 'completed' ? 'exportFile' : 'exportFileFailed', detail: suggested, result: state === 'completed' ? 'ok' : 'fail', src: 'download' });
      });
    }).catch(e => { console.error('[download] save dialog failed', e); item.cancel(); });
  });
}
module.exports = { attach };
