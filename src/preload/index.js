'use strict';
const { contextBridge, ipcRenderer } = require('electron');

const invoke = (channel, payload) => ipcRenderer.invoke(channel, payload || {});

contextBridge.exposeInMainWorld('desktop', {
  auth: {
    status: p => invoke('wh:auth/status', p),
    setup: p => invoke('wh:auth/setup', p),
    login: p => invoke('wh:auth/login', p),
    logout: p => invoke('wh:auth/logout', p),
    authorize: p => invoke('wh:auth/authorize', p),
    confirm: p => invoke('wh:auth/confirm', p),
    changePwd: p => invoke('wh:auth/changePwd', p),
    resetPwd: p => invoke('wh:auth/resetPwd', p),
    onLocked: cb => ipcRenderer.on('wh:auth/locked', (_event, payload) => { try { cb(payload); } catch (_) {} })
  },
  audit: {
    query: p => invoke('wh:audit/query', p),
    log: p => invoke('wh:audit/log', p)
  },
  seed: {
    import: p => invoke('wh:seed/import', p),
    done: p => invoke('wh:seed/done', p)
  },
  app: { info: () => invoke('wh:app/info') },
  file: { save: p => invoke('wh:file/save', p) },
  diag: { windowState: () => invoke('wh:diag/windowState') },
  cursor: {
    clip: () => invoke('wh:cursor/clip'),
    release: () => invoke('wh:cursor/release')
  },
  serial: {
    listPorts: () => invoke('wh:serial/listPorts'),
    resetPorts: () => invoke('wh:serial/resetPorts')
  }
});
