'use strict';
/* V2 冒烟测试：通过 CDP 在真实渲染进程里验证
 *   1. 无登录页 / 无账号管理，启动直接进入应用
 *   2. 导航只剩 入库/出库/借用/库存/存档/串口调试/审计日志
 *   3. 入库表单没有「业务类型 / 审批状态」
 *   4. 扫码后自动带出 名称/规格/单位/仓库/当前库存（入库、出库、借用）
 *   5. 点击签字区打开全屏固定签字板，确认后笔迹写回
 *   6. 串口桥仍在
 * 用法：node tests/smoke-v2.js   （应用需带 --remote-debugging-port=9333 启动）
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
    const ready = await cdp.eval('!!window.APP_READY');
    if (ready) break;
    await sleep(250);
  }
  await sleep(600);

  const state = await cdp.eval(`(function(){
    return {
      ready: !!window.APP_READY,
      dbError: window.DB_ERROR || '',
      login: !!document.getElementById('login'),
      appOn: document.getElementById('app').classList.contains('on'),
      navs: Array.from(document.querySelectorAll('.nav a')).map(a=>a.textContent.replace(/^[^\u4e00-\u9fa5]+/,'').trim()),
      pages: Array.from(document.querySelectorAll('.page')).map(p=>p.id),
      who: document.getElementById('u-info') ? document.getElementById('u-info').textContent.trim() : '',
      user: document.getElementById('u-info') ? document.getElementById('u-info').textContent.trim() : '',
      usersPage: !!document.getElementById('page-users'),
      inboundHasType: /业务类型|审批状态/.test(document.getElementById('page-inbound').textContent),
      items: (typeof ITEMS!=='undefined'?ITEMS.slice(0,3):[]).map(x=>({code:x.code,name:x.name,spec:x.spec,unit:x.unit,cat:x.cat,qty:x.qty})),
      itemCount: (typeof ITEMS!=='undefined'?ITEMS.length:0),
      serialBridge: !!(window.desktop && window.desktop.serial),
      cursorBridge: !!(window.desktop && window.desktop.cursor)
    };
  })()`);
  console.log('页面状态：', JSON.stringify(state, null, 2));

  assert(state.ready === true, '应用初始化完成');
  assert(state.dbError === '', '数据库无错误');
  assert(state.login === false, '登录页已移除');
  assert(state.appOn === true, '启动即进入主界面');
  assert(state.usersPage === false, '账号管理页已移除');
  assert(state.who.indexOf('免登录') >= 0, '侧栏显示免登录身份');
  assert(state.navs.join('|') === '入库|出库|借用|库存|存档|串口调试|审计日志', '导航为 7 项且已去掉盘点/报表/账号', state.navs);
  assert(state.pages.length === 7, '页面数量为 7', state.pages);
  assert(state.inboundHasType === false, '入库表单无业务类型/审批状态');
  assert(state.itemCount > 0, '库存数据已加载（' + state.itemCount + ' 条）');
  assert(state.serialBridge === true, '串口桥保留');
  assert(state.cursorBridge === true, '签字光标锁定桥已注入');

  const it = state.items[0];
  if (!it) throw new Error('没有可测试的物品');

  /* 入库自动带出 */
  const inFill = await cdp.eval(`(function(){
    var c=document.getElementById('in-code'); c.value=${JSON.stringify(it.code)};
    c.dispatchEvent(new Event('input',{bubbles:true}));
    return {name:document.getElementById('in-name').value, spec:document.getElementById('in-spec').value,
            unit:document.getElementById('in-unit').value, wh:document.getElementById('in-wh').value,
            stockEl:!!document.getElementById('in-stock')};
  })()`);
  console.log('入库回填：', JSON.stringify(inFill));
  assert(inFill.name === it.name && inFill.spec === it.spec && inFill.unit === it.unit, '入库自动带出 名称/规格/单位', inFill);
  assert(inFill.wh === it.cat, '入库自动带出 仓库', inFill.wh);
  assert(inFill.stockEl === false, '入库页已无「当前库存」字段');

  /* 出库自动带出（切换到出库页） */
  await cdp.eval(`go('consume')`);
  await sleep(200);
  const outFill = await cdp.eval(`(function(){
    var c=document.getElementById('consume-code'); c.value=${JSON.stringify(it.code)};
    c.dispatchEvent(new Event('input',{bubbles:true}));
    return {name:document.getElementById('consume-name').value, spec:document.getElementById('consume-spec').value,
            unit:document.getElementById('consume-unit').value, wh:document.getElementById('consume-wh').value,
            stockEl:!!document.getElementById('consume-stock')};
  })()`);
  console.log('出库回填：', JSON.stringify(outFill));
  assert(outFill.name === it.name && outFill.unit === it.unit && outFill.wh === it.cat, '出库自动带出 名称/单位/仓库', outFill);
  assert(outFill.stockEl === false, '出库页已无「当前库存」字段');

  /* 借用自动带出 */
  await cdp.eval(`go('borrow')`);
  await sleep(300);
  const boFill = await cdp.eval(`(function(){
    var c=document.getElementById('borrowout-code'); c.value=${JSON.stringify(it.code)};
    c.dispatchEvent(new Event('input',{bubbles:true}));
    return {name:document.getElementById('borrowout-name').value, spec:document.getElementById('borrowout-spec').value,
            unit:document.getElementById('borrowout-unit').value, wh:document.getElementById('borrowout-wh').value,
            stockEl:!!document.getElementById('borrowout-stock')};
  })()`);
  console.log('借用回填：', JSON.stringify(boFill));
  assert(boFill.name === it.name && boFill.unit === it.unit && boFill.wh === it.cat, '借用自动带出 名称/单位/仓库', boFill);
  assert(boFill.stockEl === false, '借用页已无「当前库存」字段');

  /* 签字放大（入库） */
  await cdp.eval(`go('inbound')`);
  await sleep(250);
  const zoom = await cdp.eval(`(function(){
    var cv=document.getElementById('sig-in');
    cv.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,cancelable:true,pointerId:1,clientX:10,clientY:10}));
    var ov=document.getElementById('sign-zoom');
    return {on:ov.classList.contains('on'), lock:document.body.classList.contains('sign-zoom-lock'),
            visible:!!ov.getClientRects().length, title:ov.querySelector('.sign-zoom-title').textContent};
  })()`);
  console.log('签字放大：', JSON.stringify(zoom));
  assert(zoom.on === true && zoom.visible === true, '点击签字区后整屏签字板打开');
  assert(zoom.lock === true, '签字时页面滚动锁定');
  const sigInfo = await cdp.eval(`(function(){
    var cv=document.getElementById('sig-zoom-cv'); var r=cv.getBoundingClientRect();
    var opt={bubbles:true,cancelable:true,pointerId:9,clientX:r.left+60,clientY:r.top+80};
    cv.dispatchEvent(new PointerEvent('pointerdown',opt));
    for(var i=0;i<12;i++){ cv.dispatchEvent(new PointerEvent('pointermove',{bubbles:true,cancelable:true,pointerId:9,clientX:r.left+60+i*14,clientY:r.top+80+i*6})); }
    window.dispatchEvent(new PointerEvent('pointerup',{bubbles:true,pointerId:9}));
    return {ink:!zoomPad.isEmpty(), w:r.width, h:r.height};
  })()`);
  console.log('签字笔迹：', JSON.stringify(sigInfo));
  assert(sigInfo.ink === true, '签字板可书写');
  await cdp.eval(`document.getElementById('sign-zoom-ok').click()`);
  await sleep(200);
  const afterOk = await cdp.eval(`(function(){
    var ov=document.getElementById('sign-zoom');
    return {on:ov.classList.contains('on'), lock:document.body.classList.contains('sign-zoom-lock'),
            signed:!sigIn.isEmpty()};
  })()`);
  assert(afterOk.on === false && afterOk.lock === false, '点确认后退出放大并解锁滚动');
  assert(afterOk.signed === true, '确认后笔迹写回原签字区');

  /* 串口页面仍可打开 */
  await cdp.eval(`go('serial')`);
  await sleep(250);
  const ser = await cdp.eval(`(function(){return {on:document.getElementById('page-serial').classList.contains('on'),
     text:document.getElementById('serial-support').textContent}})()`);
  assert(ser.on === true, '串口调试页仍可打开');

  /* 截图（整窗）：窗口最小化 / 被遮挡时可能拿不到帧，截图不作为断言 */
  try {
    const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
    require('node:fs').writeFileSync('tests/v2-main.png', Buffer.from(shot.data, 'base64'));
  } catch (e) {
    console.log('  (截图跳过：' + e.message + ')');
  }

  console.log(failed === 0 ? '\n全部通过' : '\n失败 ' + failed + ' 项');
  cdp.close();
  process.exit(failed === 0 ? 0 : 1);
})().catch(e => { console.error(e); process.exit(2); });
