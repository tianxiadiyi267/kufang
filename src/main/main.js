'use strict';
/* Startup hardening (v1.0.1)
   1. Some hosts export ELECTRON_RUN_AS_NODE=1 / NODE_OPTIONS into child
      processes; that turns this exe into a plain Node process with no window.
   2. On this machine Chromium's Windows sandbox cannot load DLLs from an
      install directory containing non-ASCII characters: GPU/renderer children
      die with 0xC0000135 and the browser process hits
      FATAL "GPU process isn't usable. Goodbye."  Only in that case we drop
      the sandbox; an ASCII install path keeps the sandbox fully enabled.
   3. Every startup failure is now written to startup.log and shown to the
      user instead of being swallowed silently. */
delete process.env.ELECTRON_RUN_AS_NODE;
delete process.env.NODE_OPTIONS;

const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { app, BrowserWindow, dialog, session, ipcMain, screen } = require('electron');
const protocolMod = require('./protocol');
const auth = require('./auth');
const audit = require('./audit');
const seed = require('./seed');
const ipc = require('./ipc');

const PRODUCT = '库房管理系统-桌面版 V2';
/* 与旧版共用同一份本机数据（IndexedDB 按 app://local 源存放于该 userData 下）。
   这样新安装的 V2 打开后仍是原来的库存/单据，不会出现“装了新版本数据全空”。 */
const LEGACY_USER_DATA = path.join(app.getPath('appData'), '库房管理系统-桌面版');
const NON_ASCII = /[^\x00-\x7F]/;
const exeDir = path.dirname(process.execPath);
const sandboxDisabledForPath = NON_ASCII.test(exeDir);

// Must be before app.whenReady(); only affects non-ASCII install paths.
if (sandboxDisabledForPath) app.commandLine.appendSwitch('no-sandbox');

protocolMod.registerSchemes(); // must be before app.whenReady()

// Keep dev runs in a separate userData so testing never consumes the production first-run seed.
// WH_DEV_USERDATA is a dev-only test switch (mirrors WH_EXPORT_TEST_DIR): it lets a
// regression run use a clean isolated profile. Packaged builds ignore it entirely.
if (!app.isPackaged) {
  const devData = process.env.WH_DEV_USERDATA
    ? path.resolve(process.env.WH_DEV_USERDATA)
    : path.join(app.getPath('appData'), PRODUCT + '-dev');
  app.setPath('userData', devData);
} else {
  // 安装版固定复用旧版数据目录：新 APP 与旧 APP 各自独立安装，但看到同一份库房数据。
  // setPath 要求目录已存在（首次在干净用户上运行时可能还没有），先创建再设置；
  // 极端情况下（目录不可写）退回默认目录，保证程序仍能启动。
  try {
    fs.mkdirSync(LEGACY_USER_DATA, { recursive: true });
    app.setPath('userData', LEGACY_USER_DATA);
  } catch (e) {
    try { console.error('[startup] setPath(userData) failed:', e && e.message); } catch (_) {}
  }
}
const USER_DATA = app.getPath('userData');
const STARTUP_LOG = path.join(USER_DATA, 'startup.log');

function log(step, detail) {
  const line = new Date().toISOString() + ' | ' + step + (detail ? ' | ' + detail : '') + '\n';
  try { fs.mkdirSync(USER_DATA, { recursive: true }); fs.appendFileSync(STARTUP_LOG, line, 'utf8'); }
  catch (_) {}
  try { console.log('[startup] ' + line.trim()); } catch (_) {}
}
function showError(title, e) {
  const msg = (e && (e.stack || e.message)) || String(e || '未知错误');
  log('ERROR ' + title, msg.slice(0, 1200));
  try { dialog.showErrorBox(title, msg.slice(0, 1200)); } catch (_) {}
}
process.on('uncaughtException', e => showError('程序遇到未处理的异常', e));
process.on('unhandledRejection', e => showError('程序遇到未处理的异步错误', e));

log('boot', 'version=' + app.getVersion() + ' exe=' + process.execPath + ' packaged=' + app.isPackaged + ' noSandboxForPath=' + sandboxDisabledForPath);

const gotLock = app.requestSingleInstanceLock();
let win = null;
let startupFailed = false;

if (!gotLock) {
  log('single-instance', 'another instance holds the lock; quitting');
  try { dialog.showErrorBox(PRODUCT, '程序已经在运行中。请在任务栏找到已打开的窗口；如果没有看到窗口，请重启电脑后再试。'); } catch (_) {}
  app.quit();
} else {
  app.on('second-instance', () => {
    log('second-instance', 'focus existing window');
    if (win && !win.isDestroyed()) {
      if (win.isMinimized()) win.restore();
      if (!win.isVisible()) win.show();
      win.focus();
    }
  });

  app.whenReady().then(() => {
    log('ready', 'userData=' + USER_DATA);
    const steps = [
      ['audit.init', () => audit.init(USER_DATA)],
      ['seed.init', () => seed.init(USER_DATA)],
      ['auth.init', () => auth.init(USER_DATA, {
        onIdle: s => {
          audit.append({ user: s.user, role: s.role, action: 'lock', result: 'ok', detail: 'idle timeout', src: 'main' });
          if (win && !win.isDestroyed()) win.webContents.send('wh:auth/locked', { reason: 'idle' });
        }
      })],
      ['protocol.registerHandler', () => protocolMod.registerHandler(path.join(__dirname, '..', '..', 'app'))],
      ['serial.permissions', () => setupSerialPermissions()],
      ['serial.listPorts', () => setupSerialPortsApi()],
      ['cursor.register', () => setupCursorApi()],
      ['ipc.register', () => ipc.register({ auth, audit, seed, version: app.getVersion(), userData: USER_DATA, windowState })]
    ];
    for (const [name, fn] of steps) {
      try { fn(); log(name, 'ok'); }
      catch (e) { startupFailed = true; showError('启动失败：' + name, e); app.quit(); return; }
    }
    createWindow();
    app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
    app.on('window-all-closed', () => app.quit());
    app.on('before-quit', () => { log('quit', 'bye'); releaseCursorClip(); try { auth.destroyAll(); } catch (_) {} });
  }).catch(e => { startupFailed = true; showError('启动失败', e); app.quit(); });
}


/* ============================================================
   签字放大模式：系统级光标锁定（user32!ClipCursor）
   前端把签字区放大到整屏后调用，书写板/鼠标只能在窗口内移动；
   确认、取消、窗口失焦、程序退出都会立即释放，避免鼠标被卡住。
   ============================================================ */
let cursorClipped = false;

function runPowerShell(script) {
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  execFile('powershell.exe',
    ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-EncodedCommand', encoded],
    { windowsHide: true, timeout: 8000 },
    (err, _stdout, stderr) => {
      if (err) log('cursor.ps.error', String((stderr || err.message || '').slice(0, 300)));
    });
}

const CURSOR_TYPE = [
  'Add-Type -TypeDefinition @"',
  'using System;',
  'using System.Runtime.InteropServices;',
  'public static class WhCursor {',
  '  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }',
  '  [DllImport("user32.dll", SetLastError=true)] static extern bool ClipCursor(ref RECT lpRect);',
  '  [DllImport("user32.dll", SetLastError=true)] static extern bool ClipCursor(IntPtr lpRect);',
  '  public static bool Clip(int l,int t,int r,int b){ RECT x = new RECT(); x.Left=l; x.Top=t; x.Right=r; x.Bottom=b; return ClipCursor(ref x); }',
  '  public static bool Free(){ return ClipCursor(IntPtr.Zero); }',
  '}',
  '"@'
].join('\n');

function clipCursorToWindow() {
  if (!win || win.isDestroyed()) return { ok: false };
  const b = win.getBounds();
  let sf = 1;
  try {
    const disp = screen.getDisplayMatching(b);
    sf = (disp && disp.scaleFactor) || 1;
  } catch (_) {}
  const l = Math.round(b.x * sf);
  const t = Math.round(b.y * sf);
  const r = Math.round((b.x + b.width) * sf);
  const bt = Math.round((b.y + b.height) * sf);
  cursorClipped = true;
  runPowerShell(CURSOR_TYPE + '\n[WhCursor]::Clip(' + l + ',' + t + ',' + r + ',' + bt + ') | Out-Null');
  log('cursor.clip', l + ',' + t + ',' + r + ',' + bt + ' scale=' + sf);
  return { ok: true };
}

function releaseCursorClip() {
  if (!cursorClipped) return { ok: true };
  cursorClipped = false;
  runPowerShell(CURSOR_TYPE + '\n[WhCursor]::Free() | Out-Null');
  log('cursor.release', 'released');
  return { ok: true };
}

function setupCursorApi() {
  ipcMain.handle('wh:cursor/clip', () => clipCursorToWindow());
  ipcMain.handle('wh:cursor/release', () => releaseCursorClip());
  log('cursor.register', 'ok');
}

/* ============================================================
   Web Serial / 串口调试（桌面版必需）
   Electron 不会自动弹出串口设备列表：必须由主进程接管
   'select-serial-port' 并显式 callback(portId)，否则页面里的
   navigator.serial.requestPort() 会直接失败（NotFoundError）。
   ============================================================ */
function setupSerialPermissions(){
  const ses = session.defaultSession;
  // 放行串口权限；其余权限维持原有放行行为，避免影响下载等既有功能
  ses.setPermissionCheckHandler((_wc, permission) => {
    if (permission === 'serial') return true;
    return true;
  });
  // 允许页面持久访问已授权的串口设备
  ses.setDevicePermissionHandler((details) => {
    if (details && details.deviceType === 'serial') return true;
    return true;
  });
  log('serial.permissions', 'ok');
}

let serialPortCache = [];
/* 端口列表持久化：Chromium 在设备已连接/被占用时，select-serial-port 事件给出的
   portList 可能为空，导致第二次点「连接」不再弹出设备列表（用户看到「连一次就没了」）。
   把上一次枚举结果写到 userData，重启程序后也能兜底显示。 */
const SERIAL_CACHE_FILE = path.join(USER_DATA, 'serial-ports.json');
try{
  const saved = JSON.parse(fs.readFileSync(SERIAL_CACHE_FILE, 'utf8'));
  if(Array.isArray(saved)) serialPortCache = saved;
}catch(_e){}
function saveSerialPortCache(list){
  serialPortCache = list;
  try{ fs.writeFileSync(SERIAL_CACHE_FILE, JSON.stringify(list), 'utf8'); }catch(_e){}
}

/* Electron 不同版本给出的 SerialPort 字段名不完全一致，统一规整 */
function normaliseSerialPorts(list){
  return (list || []).map(function(p, i){
    const vid = (p.usbVendorId != null) ? p.usbVendorId : p.vendorId;
    const pid = (p.usbProductId != null) ? p.usbProductId : p.productId;
    const bt  = String(p.bluetoothServiceClassId || '');
    const name = String(p.displayName || p.portName || ('设备 ' + (i + 1)));
    let kind = '串口设备';
    if (vid != null && pid != null) kind = 'USB 串口';
    else if (/^00001101/i.test(bt)) kind = '蓝牙 SPP 串口';
    else if (bt) kind = '蓝牙设备';
    return {
      portId: String(p.portId || ''),
      name: name,
      portName: String(p.portName || ''),
      vendorId: (vid == null ? '' : String(vid)),
      productId: (pid == null ? '' : String(pid)),
      bluetoothServiceClassId: bt,
      kind: kind
    };
  });
}

function serialPickerHtml(list){
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c =>
    ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const css = [
    '*{box-sizing:border-box}',
    'body{margin:0;font-family:"Microsoft YaHei","Segoe UI",sans-serif;background:#f6f8f9;color:#1f2a33;font-size:13px}',
    '.hd{padding:18px 20px 14px;background:#fff;border-bottom:1px solid #e9eef0}',
    '.tt{font-size:17px;font-weight:800;color:#0b6a5e}',
    '.sub{margin-top:4px;color:#5f6b78;font-size:12px}',
    '#q{margin-top:12px;width:100%;height:34px;border:1px solid #dde5e8;border-radius:8px;padding:0 10px;font-size:13px;font-family:inherit}',
    '#q:focus{outline:none;border-color:#1aa695;box-shadow:0 0 0 3px rgba(26,166,149,.15)}',
    '.list{padding:10px 14px;max-height:330px;overflow:auto}',
    '.row{display:flex;align-items:center;gap:12px;width:100%;text-align:left;background:#fff;border:1px solid #e9eef0;border-radius:10px;padding:10px 12px;margin-bottom:8px;cursor:pointer;font-family:inherit;color:inherit;transition:.15s}',
    '.row:hover{border-color:#1aa695;background:#eaf7f4;transform:translateX(2px)}',
    '.no{flex:0 0 24px;height:24px;border-radius:7px;background:#eef3f4;color:#5f6b78;font-size:11px;font-weight:700;display:flex;align-items:center;justify-content:center}',
    '.txt{flex:1;min-width:0;display:flex;flex-direction:column;gap:3px}',
    '.txt b{font-size:13.5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
    '.txt small{color:#8b96a3;font-size:11px;font-family:ui-monospace,Consolas,monospace}',
    '.go{color:#0f8577;font-weight:700;font-size:12px;white-space:nowrap}',
    '.ft{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:12px 20px;border-top:1px solid #e9eef0;background:#fff;color:#8b96a3;font-size:11.5px}',
    '.ft button{border:1px solid #dde5e8;background:#fff;border-radius:8px;padding:7px 16px;cursor:pointer;font-family:inherit;font-size:12.5px;color:#3d4956}'
  ].join('');
  const rows = list.map(function(p, i){
    const meta = [p.kind];
    if (p.portName && p.portName !== p.name) meta.push(p.portName);
    if (p.vendorId || p.productId) meta.push('VID:' + p.vendorId + ' PID:' + p.productId);
    else if (p.bluetoothServiceClassId) meta.push('UUID ' + p.bluetoothServiceClassId.slice(0, 8));
    return '<button class="row" data-k="' + esc((p.name + ' ' + meta.join(' ')).toLowerCase()) + '"'
      + ' data-id="' + esc(p.portId) + '">'
      + '<span class="no">' + (i + 1) + '</span>'
      + '<span class="txt"><b>' + esc(p.name) + '</b><small>' + esc(meta.join(' · ')) + '</small></span>'
      + '<span class="go">连接 ›</span></button>';
  }).join('');
  const script = 'document.getElementById("q").addEventListener("input",function(e){'
    + 'var k=e.target.value.trim().toLowerCase();'
    + 'Array.prototype.forEach.call(document.querySelectorAll(".row"),function(r){'
    + 'r.style.display=(!k||r.getAttribute("data-k").indexOf(k)>=0)?"":"none";});});'
    + 'Array.prototype.forEach.call(document.querySelectorAll(".row"),function(b){'
    + 'b.addEventListener("click",function(){console.log("WMS_PICK:"+b.getAttribute("data-id"));});});'
    + 'document.getElementById("cancel").addEventListener("click",function(){console.log("WMS_CANCEL");});';
  return '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><style>' + css + '</style></head><body>'
    + '<div class="hd"><div class="tt">选择串口设备</div>'
    + '<div class="sub">共 ' + list.length + ' 个可用端口 · 点击要连接的设备</div>'
    + '<input id="q" placeholder="输入名称 / COM / VID 过滤" autocomplete="off"></div>'
    + '<div class="list">' + rows + '</div>'
    + '<div class="ft"><span>没看到设备？请插入 USB 转串口并装好驱动后重试</span>'
    + '<button id="cancel">取消</button></div>'
    + '<script>' + script + '<\/script></body></html>';
}

/* 用独立窗口列出所有端口。Chromium/Electron 在 Windows 上可能给出几十个
   蓝牙服务端口，系统自带 messageBox 的按钮列表无法容纳，故用可滚动窗口。 */
function showSerialPicker(parent, list){
  return new Promise(function(resolve){
    let done = false, picker = null, timer = null;
    const finish = function(id){
      if (done) return;
      done = true;
      if (timer) { clearTimeout(timer); timer = null; }
      try { if (picker && !picker.isDestroyed()) picker.close(); } catch (_) {}
      resolve(id || '');
    };
    try {
      picker = new BrowserWindow({
        parent: parent, modal: true, width: 560, height: 520,
        minWidth: 460, minHeight: 380, resizable: true,
        title: '选择串口设备', backgroundColor: '#f6f8f9',
        autoHideMenuBar: true, show: false,
        webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: false }
      });
      picker.webContents.on('console-message', function(){
        const a = Array.prototype.slice.call(arguments);
        const msg = (a[1] && typeof a[1] === 'object') ? String(a[1].message || '') : String(a[2] || '');
        if (!msg) return;
        const i = msg.indexOf('WMS_PICK:');
        if (i >= 0) { log('serial.picker.pick', msg.slice(i + 9, i + 89)); finish(msg.slice(i + 9)); }
        else if (msg.indexOf('WMS_CANCEL') >= 0) { log('serial.picker.cancel', 'button'); finish(''); }
      });
      picker.on('closed', function(){ finish(''); });
      picker.once('ready-to-show', function(){ try { picker.show(); picker.focus(); } catch (_) {} });
      picker.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(serialPickerHtml(list)));
      log('serial.picker', 'opened ports=' + list.length);
      timer = setTimeout(function(){ finish(''); }, 120000);
    } catch (e) {
      log('serial.picker.error', String(e && e.message || e));
      finish('');
    }
  });
}

function setupSerialPortChooser(target){
  if (!target || !target.webContents || !target.webContents.session) return;
  /* 关键修复：'select-serial-port' 是 Session 的事件，不是 webContents 的。
     注册错对象时 requestPort() 永远返回 NotFoundError 且不弹任何设备列表。 */
  const ses = target.webContents.session;
  ses.on('select-serial-port', (event, portList, _webContents, callback) => {
    event.preventDefault();
    let ports = normaliseSerialPorts(portList || []);
    /* 关键修复：与上次枚举结果合并去重，保证每次点「连接」都能看到设备列表。
       设备被占用 / 刚断开时 Chromium 常给出空 portList。 */
    if(serialPortCache.length){
      const seen = {};
      ports.forEach(p => { if(p.portId) seen[p.portId] = true; });
      serialPortCache.forEach(p => { if(p.portId && !seen[p.portId]) ports.push(p); });
    }
    if(ports.length) saveSerialPortCache(ports);
    else if(serialPortCache.length) ports = serialPortCache.slice();
    /* 诊断开关：仅在显式设置 WMS_SERIAL_DEMO=1 时启用，用于无硬件环境下
       验证设备选择窗口；正常启动不会执行这里。 */
    if (!ports.length && process.env.WMS_SERIAL_DEMO === '1') {
      ports = normaliseSerialPorts([
        { portId: 'demo-usb', portName: 'COM9', displayName: 'DEMO USB-SERIAL CH340',
          usbVendorId: 0x1a86, usbProductId: 0x7523 },
        { portId: 'demo-bt', displayName: 'DEMO 蓝牙扫码枪',
          bluetoothServiceClassId: '00001101-0000-1000-8000-00805f9b34fb' }
      ]);
      log('serial.choose', 'demo-list enabled');
    }
    serialPortCache = ports;
    log('serial.choose', 'ports=' + ports.length + ' sample=' + JSON.stringify(ports.slice(0, 2)).slice(0, 360));
    if (!ports.length){
      /* 无设备时明确提示，不再静默 callback('') 让页面无从判断 */
      try {
        dialog.showMessageBox(target, {
          type: 'warning', title: '未检测到可用的串口设备',
          message: '程序没有找到可访问的串口设备，因此无法弹出设备列表。',
          detail: '请依次检查：\n'
            + '① USB 转串口 / 扫码枪是否已插入，并装好 CH340 / CP210x / FTDI 驱动；\n'
            + '② 串口是否被串口助手、Arduino IDE 等其它程序占用；\n'
            + '③ 在「串口调试」页点「刷新设备」查看程序已识别到的端口。\n\n'
            + '注意：Windows 蓝牙虚拟 COM 口（BthModem）一般不被 Web Serial 识别，'
            + '若设备只提供蓝牙 COM 口，请改用 USB 连接。',
          buttons: ['知道了'], defaultId: 0
        }).catch(() => {});
      } catch (_) {}
      callback('');
      return;
    }
    showSerialPicker(target, ports).then(id => {
      log('serial.choose.result', id ? 'picked=' + String(id).slice(0, 64) : 'cancelled');
      callback(id || '');
    }).catch(e => {
      log('serial.choose.error', String(e && e.message || e));
      callback('');
    });
  });
  const notifyPortChange = kind => {
    try{
      if(target && !target.isDestroyed())
        target.webContents.send('wh:serial/ports-changed', {kind:kind, ts:Date.now()});
    }catch(_e){}
  };
  ses.on('serial-port-added', (_e, p) => {
    log('serial.port-added', String((p && (p.portName || p.portId)) || ''));
    notifyPortChange('added');
  });
  ses.on('serial-port-removed', (_e, p) => {
    const id = String((p && p.portId) || '');
    log('serial.port-removed', String((p && (p.portName || p.portId)) || ''));
    if(id) saveSerialPortCache(serialPortCache.filter(x => x.portId !== id));
    notifyPortChange('removed');
  });
  log('serial.chooser', 'registered on session');
}

/* 端口列表改由 select-serial-port 事件在进程内缓存，不再调用外部进程。
   之前的 reg.exe 在本机安全策略下 spawn EPERM，导致「刷新设备」永远失败。 */
function listWindowsSerialPorts(){
  return Promise.resolve(serialPortCache.slice());
}
function setupSerialPortsApi(){
  ipcMain.handle('wh:serial/resetPorts', async () => {
    saveSerialPortCache([]);
    log('serial.resetPorts', 'cache cleared');
    return { ok: true };
  });
  ipcMain.handle('wh:serial/listPorts', async () => {
    const cache = await listWindowsSerialPorts();
    return { ok: true,
             ports: cache.map(function(p){
               return { name: p.name, label: p.kind, portName: p.portName,
                        vendorId: p.vendorId, productId: p.productId };
             }),
             source: 'web-serial-chooser', error: '' };
  });
  log('serial.listPorts', 'registered (in-process)');
}

function windowState() {
  if (!win || win.isDestroyed()) return { exists: false, visible: false };
  return {
    exists: true,
    visible: win.isVisible(),
    minimized: win.isMinimized(),
    focused: win.isFocused(),
    bounds: win.getBounds(),
    title: win.getTitle()
  };
}

function createWindow() {
  const root = path.join(__dirname, '..', '..');
  const iconPath = path.join(root, 'resources', 'app.ico');
  const isDev = !app.isPackaged;
  const hasIcon = fs.existsSync(iconPath);

  win = new BrowserWindow({
    width: 1440, height: 900,
    minWidth: 1280, minHeight: 800,
    title: PRODUCT,
    ...(hasIcon ? { icon: iconPath } : {}),
    backgroundColor: '#f6f8f9',
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(root, 'src', 'preload', 'index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      spellcheck: false,
      devTools: isDev
    }
  });
  log('createWindow', 'icon=' + hasIcon);
  setupSerialPortChooser(win);
  win.on('blur', () => { try { releaseCursorClip(); } catch (_) {} });
  win.on('closed', () => { try { releaseCursorClip(); } catch (_) {} });
  win.removeMenu();

  let shown = false;
  const showOnce = via => {
    if (shown || win.isDestroyed()) return;
    shown = true;
    try { win.show(); win.focus(); log('window.show', via); } catch (e) { log('window.show failed', e.message); }
  };
  win.once('ready-to-show', () => showOnce('ready-to-show'));
  // Fallback: if the renderer never reaches ready-to-show, still show the window
  // so the user sees an error page instead of "nothing happened".
  setTimeout(() => showOnce('timeout-fallback-4s'), 4000);

  win.webContents.on('did-fail-load', (_e, code, desc, url) => {
    log('did-fail-load', code + ' ' + desc + ' ' + url);
    try { dialog.showErrorBox('页面加载失败', '代码：' + code + '\n' + desc + '\n' + url); } catch (_) {}
  });
  win.webContents.on('preload-error', (_e, p, e) => showError('预加载脚本失败：' + p, e));
  win.webContents.on('render-process-gone', (_e, d) => {
    log('render-process-gone', JSON.stringify(d));
    try { dialog.showErrorBox('页面进程意外退出', '原因：' + (d && d.reason) + '\n请重新启动程序；若反复出现，请把 %APPDATA%\\' + PRODUCT + '\\startup.log 提供给维护人员。'); } catch (_) {}
  });
  app.on('child-process-gone', (_e, d) => log('child-process-gone', JSON.stringify(d)));

  win.loadURL(protocolMod.URL_BASE + 'index.html');
  log('loadURL', protocolMod.URL_BASE + 'index.html');
  if (process.argv.indexOf('--dev') >= 0) win.webContents.openDevTools({ mode: 'detach' });
}
