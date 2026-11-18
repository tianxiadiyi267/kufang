'use strict';
/* V2.1 扫码焦点路由测试：串口数据 → 光标所在输入框
 * 覆盖 6 个输入框（入库/出库/借用扫码框 + 库存/入库/出库搜索）、
 * 无结束符兜底、光标离开输入框后的记忆填充、自动回车开关、无焦点时转发。
 * 用法：node tests/scan-focus.js   （应用需带 --remote-debugging-port=9333 启动）
 */
const http = require('node:http');
const WebSocket = require('ws');

const PORT = Number(process.env.CDP_PORT) || 9333;
function httpJson(path) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port: PORT, path }, res => {
      let b = ''; res.on('data', d => { b += d; });
      res.on('end', () => { try { resolve(JSON.parse(b)); } catch (e) { reject(e); } });
    }).on('error', reject);
  });
}
class CDP {
  constructor(url) { this.ws = new WebSocket(url); this.id = 0; this.pending = new Map();
    this.ws.on('message', raw => { const m = JSON.parse(raw.toString());
      if (m.id && this.pending.has(m.id)) { const p = this.pending.get(m.id); this.pending.delete(m.id);
        m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result); } }); }
  open() { return new Promise((res, rej) => { this.ws.on('open', res); this.ws.on('error', rej); }); }
  send(method, params) { const id = ++this.id; return new Promise((res, rej) => {
    this.pending.set(id, { resolve: res, reject: rej });
    this.ws.send(JSON.stringify({ id, method, params: params || {} }));
    setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); rej(new Error('timeout ' + method)); } }, 15000);
  }); }
  async eval(expr, awaitPromise) { const r = await this.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: !!awaitPromise });
    if (r.exceptionDetails) throw new Error('JS: ' + JSON.stringify(r.exceptionDetails));
    return r.result.value; }
  close() { try { this.ws.close(); } catch (_) {} }
}
let failed = 0;
function assert(cond, msg, detail) {
  if (cond) console.log('  ok  ' + msg);
  else { failed++; console.log('  FAIL ' + msg + (detail === undefined ? '' : '  -> ' + JSON.stringify(detail))); }
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  const list = await httpJson('/json/list');
  const page = list.find(t => t.type === 'page' && /index\.html/.test(t.url));
  if (!page) throw new Error('未找到页面');
  const cdp = new CDP(page.webSocketDebuggerUrl);
  await cdp.open();
  await cdp.send('Runtime.enable');
  await cdp.send('Page.enable');
  await cdp.send('Page.reload');
  await sleep(2600);
  for (let i = 0; i < 40; i++) {
    if (await cdp.eval('!!window.APP_READY')) break;
    await sleep(250);
  }
  await sleep(400);

  /* 清理上一轮残留 */
  await cdp.eval(`(function(){
    try{ localStorage.removeItem('wms.scanAutoEnter'); }catch(e){}
    document.getElementById('sp-fwd-A').value=''; document.getElementById('sp-fwd-B').value='';
    serial.A.buf=''; serial.B.buf=''; clearTimeout(serial.A.idle); clearTimeout(serial.B.idle);
  })()`);

  const it = await cdp.eval(`(function(){
    var x = (typeof ITEMS!=='undefined' && ITEMS.length) ? ITEMS[0] : null;
    return x ? {code:x.code, name:x.name, spec:x.spec, unit:x.unit, cat:x.cat} : null;
  })()`);
  if (!it) throw new Error('库存无数据');
  console.log('测试物品：', JSON.stringify(it));

  const focusAndFeed = async (pageName, inputId, payload, wait) => {
    await cdp.eval(`(function(){
      go(${JSON.stringify(pageName)});
      return true;
    })()`);
    await sleep(320);
    /* 聚焦与喂数据放在同一次执行里，避免被页面里延迟的定时器抢走焦点 */
    await cdp.eval(`(function(){
      document.getElementById(${JSON.stringify(inputId)}).focus();
      feedScanBuffer('A', ${JSON.stringify(payload)});
    })()`);
    await sleep(wait || 180);
  };

  /* 1. 入库扫码框 */
  await focusAndFeed('inbound', 'in-code', it.code + '\r\n');
  let r = await cdp.eval(`(function(){return {
    code:document.getElementById('in-code').value,
    name:document.getElementById('in-name').value,
    spec:document.getElementById('in-spec').value,
    unit:document.getElementById('in-unit').value,
    wh:document.getElementById('in-wh').value,
    flash:document.getElementById('in-code').classList.contains('scan-flash'),
    live:document.getElementById('scan-live-txt').textContent
  }})()`);
  console.log('入库：', JSON.stringify(r));
  assert(r.code === it.code, '入库扫码框收到串口数据', r.code);
  assert(r.name === it.name && r.unit === it.unit && r.wh === it.cat, '入库自动带出名称/单位/仓库', r);
  assert(r.flash === true, '填充时输入框有高亮反馈');
  assert(/入库扫码框/.test(r.live), '串口页「当前光标」提示同步（' + r.live + '）');

  /* 2. 出库扫码框（\r 结尾） */
  await focusAndFeed('consume', 'consume-code', it.code + '\r');
  r = await cdp.eval(`(function(){return {
    code:document.getElementById('consume-code').value,
    name:document.getElementById('consume-name').value,
    unit:document.getElementById('consume-unit').value
  }})()`);
  console.log('出库：', JSON.stringify(r));
  assert(r.code === it.code && r.name === it.name, '出库扫码框收到串口数据并带出名称', r);

  /* 3. 借用扫码框（\n 结尾） */
  await focusAndFeed('borrow', 'borrowout-code', it.code + '\n');
  r = await cdp.eval(`(function(){return {
    code:document.getElementById('borrowout-code').value,
    name:document.getElementById('borrowout-name').value,
    wh:document.getElementById('borrowout-wh').value
  }})()`);
  console.log('借用：', JSON.stringify(r));
  assert(r.code === it.code && r.name === it.name && r.wh === it.cat, '借用扫码框收到串口数据并带出名称/仓库', r);

  /* 4. 库存搜索 */
  const totalRows = await cdp.eval(`ITEMS.length`);
  await focusAndFeed('stock', 'st-search', it.code + '\r\n');
  r = await cdp.eval(`(function(){
    var rows = document.querySelectorAll('#stock-body tr').length;
    return {v:document.getElementById('st-search').value, rows:rows, total:${totalRows}};
  })()`);
  console.log('库存搜索：', JSON.stringify(r));
  assert(r.v === it.code, '库存搜索框收到串口数据', r.v);
  assert(r.rows >= 1 && r.rows < r.total, '库存列表按条码过滤', r);

  /* 5. 入库搜索 */
  await focusAndFeed('inbound', 'in-search', it.code + '\r\n');
  r = await cdp.eval(`document.getElementById('in-search').value`);
  assert(r === it.code, '入库搜索框收到串口数据', r);

  /* 6. 出库搜索 */
  await focusAndFeed('consume', 'consume-search', it.code + '\r\n');
  r = await cdp.eval(`document.getElementById('consume-search').value`);
  assert(r === it.code, '出库搜索框收到串口数据', r);

  /* 7. 光标不在输入框（点了按钮）→ 仍填回本页最近用过的扫码框 */
  await cdp.eval(`(function(){ go('inbound'); })()`);
  await sleep(300);
  await cdp.eval(`document.getElementById('in-code').focus()`);
  await sleep(60);
  await cdp.eval(`document.querySelector('#page-inbound .scan-row .btn-ghost').focus()`);
  await sleep(60);
  await cdp.eval(`feedScanBuffer('A', '690123\\r\\n')`);
  await sleep(180);
  r = await cdp.eval(`document.getElementById('in-code').value`);
  assert(r === '690123', '焦点在按钮时仍填回本页扫码框', r);

  /* 8. 无结束符：静默后兜底（窗口被遮挡时定时器会被节流，故多等一会儿） */
  await cdp.eval(`(function(){
    var el=document.getElementById('in-code'); el.value=''; el.dispatchEvent(new Event('input',{bubbles:true}));
    el.focus(); feedScanBuffer('A','690777');
  })()`);
  await sleep(1600);
  r = await cdp.eval(`document.getElementById('in-code').value`);
  assert(r === '690777', '无结束符的数据也能在静默后填入', r);

  /* 9. 自动回车开关 */
  await cdp.eval(`(function(){
    localStorage.setItem('wms.scanAutoEnter','1');
    var el=document.getElementById('in-code'); el.value=''; el.focus();
    window.__enterHit=0;
    el.addEventListener('keydown', function h(e){ if(e.key==='Enter'){ window.__enterHit++; } }, {once:false});
  })()`);
  await cdp.eval(`feedScanBuffer('A', ${JSON.stringify(it.code + '\r\n')})`);
  await sleep(220);
  r = await cdp.eval(`window.__enterHit`);
  assert(r >= 1, '开启「扫码后自动回车」后向扫码框派发回车', r);
  await cdp.eval(`localStorage.removeItem('wms.scanAutoEnter')`);

  /* 10. 无可见焦点时按「转发到」设置兜底（串口页） */
  await cdp.eval(`(function(){ go('serial'); })()`);
  await sleep(300);
  await cdp.eval(`(function(){
    document.getElementById('sp-fwd-A').value='st-search';
    document.getElementById('st-search').value='';
    document.activeElement.blur();
  })()`);
  await sleep(80);
  await cdp.eval(`feedScanBuffer('A','690888\\r\\n')`);
  await sleep(200);
  r = await cdp.eval(`document.getElementById('st-search').value`);
  assert(r === '690888', '无可见焦点时按「无焦点时转发到」兜底', r);
  await cdp.eval(`(function(){ document.getElementById('sp-fwd-A').value=''; })()`);

  /* 11. 顶栏串口状态标识 */
  r = await cdp.eval(`(function(){
    var old=serial.B.port;
    serial.B.port={}; updateSerialChip();
    var chip=document.getElementById('serial-chip');
    var out={shown:getComputedStyle(chip).display!=='none', text:chip.textContent.trim()};
    serial.B.port=old; updateSerialChip();
    out.hiddenAfter=getComputedStyle(chip).display==='none';
    return out;
  })()`);
  console.log('顶栏标识：', JSON.stringify(r));
  assert(r.shown === true && /串口 B 已连接/.test(r.text), '串口连接后顶栏显示状态', r);
  assert(r.hiddenAfter === true, '串口断开后顶栏标识隐藏', r);

  /* 串口原有功能仍在 */
  r = await cdp.eval(`(function(){
    return !!document.getElementById('sp-fwd-A') && !!document.getElementById('sp-send-A') &&
           typeof connectSerial==='function' && typeof sendSerial==='function' &&
           typeof disconnectSerial==='function' && !!(window.desktop && window.desktop.serial);
  })()`);
  assert(r === true, '串口连接/发送/断开与主进程桥保持完好');

  await cdp.eval(`go('inbound')`);
  await sleep(300);
  try {
    const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
    require('node:fs').writeFileSync('tests/v2-scan-focus.png', Buffer.from(shot.data, 'base64'));
  } catch (e) {
    console.log('  (截图跳过：' + e.message + ')');
  }

  console.log(failed === 0 ? '\n全部通过' : '\n失败 ' + failed + ' 项');
  cdp.close();
  process.exit(failed === 0 ? 0 : 1);
})().catch(e => { console.error(e); process.exit(2); });
