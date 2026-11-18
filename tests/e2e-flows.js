'use strict';
/* 业务流程回归：入库 / 出库 / 借用（含签字）真实写入，验证：
 *   1. 入库不再需要业务类型 / 审批状态
 *   2. 扫码后自动带出字段，加入明细后提交成功，库存增加
 *   3. 出库提交成功，库存减少
 *   4. 借用非「工具库」物品也能提交（原限制已取消），库存减少并进入待归还
 * 运行前请用隔离的 WH_DEV_USERDATA 启动应用（避免污染真实数据）。
 */
const http = require('node:http');
const WebSocket = require('ws');

const PORT = Number(process.env.CDP_PORT) || 9333;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const httpJson = p => new Promise((res, rej) => {
  http.get({ host: '127.0.0.1', port: PORT, path: p }, r => {
    let b = ''; r.on('data', d => { b += d; }); r.on('end', () => { try { res(JSON.parse(b)); } catch (e) { rej(e); } });
  }).on('error', rej);
});
class CDP {
  constructor(url) { this.ws = new WebSocket(url); this.id = 0; this.pending = new Map();
    this.ws.on('message', raw => { const m = JSON.parse(raw.toString());
      if (m.id && this.pending.has(m.id)) { const p = this.pending.get(m.id); this.pending.delete(m.id);
        m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result); } }); }
  open() { return new Promise((res, rej) => { this.ws.on('open', res); this.ws.on('error', rej); }); }
  send(method, params) { const id = ++this.id; return new Promise((res, rej) => {
    this.pending.set(id, { resolve: res, reject: rej });
    this.ws.send(JSON.stringify({ id, method, params: params || {} }));
    setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); rej(new Error('timeout ' + method)); } }, 20000);
  }); }
  async eval(expr, awaitPromise) { const r = await this.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: !!awaitPromise });
    if (r.exceptionDetails) throw new Error('JS: ' + JSON.stringify(r.exceptionDetails).slice(0, 800));
    return r.result.value; }
  close() { try { this.ws.close(); } catch (_) {} }
}
let failed = 0;
function assert(cond, msg, detail) {
  if (cond) console.log('  ok  ' + msg);
  else { failed++; console.log('  FAIL ' + msg + (detail === undefined ? '' : ' -> ' + JSON.stringify(detail))); }
}
const INK = `(function(){var c=document.createElement('canvas');c.width=320;c.height=120;
  var x=c.getContext('2d');x.strokeStyle='#223344';x.lineWidth=4;x.lineCap='round';
  x.beginPath();x.moveTo(30,80);x.bezierCurveTo(80,20,140,110,190,50);x.bezierCurveTo(230,10,270,90,290,60);x.stroke();
  return c.toDataURL('image/png');})()`;

(async () => {
  const list = await httpJson('/json/list');
  const page = list.find(t => t.type === 'page' && /index\.html/.test(t.url));
  const cdp = new CDP(page.webSocketDebuggerUrl);
  await cdp.open();
  await cdp.send('Runtime.enable');
  await cdp.send('Page.enable');
  await cdp.send('Page.reload');
  await sleep(2800);
  for (let i = 0; i < 30; i++) { if (await cdp.eval('!!window.APP_READY')) break; await sleep(200); }
  await sleep(500);

  const ink = await cdp.eval(INK);
  const before = await cdp.eval(`(function(){var o={};ITEMS.forEach(function(i){o[i.code]=i.qty});return o;})()`);
  console.log('初始库存：', JSON.stringify(before));

  /* ---------- 入库 ---------- */
  const inRes = await cdp.eval(`(async function(){
    go('inbound');
    await new Promise(function(r){setTimeout(r,350)});
    document.getElementById('in-whom').value='自动化测试老师';
    var c=document.getElementById('in-code'); c.value='690001'; c.dispatchEvent(new Event('input',{bubbles:true}));
    document.getElementById('in-qty').value='2';
    var filled={name:document.getElementById('in-name').value, spec:document.getElementById('in-spec').value,
                unit:document.getElementById('in-unit').value, wh:document.getElementById('in-wh').value,
                stockEl:!!document.getElementById('in-stock'),
                unit:document.getElementById('in-unit').value,
                hasBiz:/业务类型|审批状态/.test(document.getElementById('page-inbound').textContent)};
    addInLine();
    var lines=inDraft.length;
    sigIn.load(${JSON.stringify(ink)});
    await new Promise(function(r){setTimeout(r,1200)});
    var signed=!sigIn.isEmpty();
    await submitIn();
    await new Promise(function(r){setTimeout(r,300)});
    return {filled:filled, lines:lines, signed:signed, after:findItem('690001').qty,
            orders:IN_ORDERS.length, draft:inDraft.length, toast:document.getElementById('toast-msg').textContent};
  })()`, true);
  console.log('入库结果：', JSON.stringify(inRes));
  assert(inRes.filled.hasBiz === false, '入库表单无业务类型/审批状态');
  assert(inRes.filled.name === 'A4 复印纸' && inRes.filled.wh === '耗材库' && inRes.filled.unit === '包', '入库扫码自动带出 名称/单位/仓库', inRes.filled);
  assert(inRes.filled.stockEl === false, '入库页已无「当前库存」字段');
  assert(inRes.lines === 1, '入库明细加入成功');
  assert(inRes.signed === true, '入库签字已写入');
  assert(inRes.after === before['690001'] + 2, '入库后库存 +2', inRes.after);
  assert(inRes.draft === 0, '提交后本单清空');

  /* ---------- 出库 ---------- */
  const outRes = await cdp.eval(`(async function(){
    go('consume');
    await new Promise(function(r){setTimeout(r,350)});
    document.getElementById('consume-whom').value='自动化领用老师';
    var c=document.getElementById('consume-code'); c.value='690002'; c.dispatchEvent(new Event('input',{bubbles:true}));
    document.getElementById('consume-qty').value='1';
    var filled={name:document.getElementById('consume-name').value, spec:document.getElementById('consume-spec').value,
                unit:document.getElementById('consume-unit').value, wh:document.getElementById('consume-wh').value,
                stockEl:!!document.getElementById('consume-stock')};
    addOutLine('consume');
    var lines=outDraft.consume.length;
    sigOut.consume.load(${JSON.stringify(ink)});
    await new Promise(function(r){setTimeout(r,1200)});
    await submitOut('consume');
    await new Promise(function(r){setTimeout(r,300)});
    return {filled:filled, lines:lines, after:findItem('690002').qty, draft:outDraft.consume.length,
            toast:document.getElementById('toast-msg').textContent};
  })()`, true);
  console.log('出库结果：', JSON.stringify(outRes));
  assert(outRes.filled.name === '签字笔' && outRes.filled.unit === '支' && outRes.filled.wh === '耗材库', '出库扫码自动带出 名称/规格/单位/仓库', outRes.filled);
  assert(outRes.filled.stockEl === false, '出库页已无「当前库存」字段');
  assert(outRes.lines === 1, '出库明细加入成功');
  assert(outRes.after === before['690002'] - 1, '出库后库存 -1', outRes.after);

  /* ---------- 借用（非工具库物品） ---------- */
  const borrowRes = await cdp.eval(`(async function(){
    go('borrow');
    switchBorrow('borrowout');
    await new Promise(function(r){setTimeout(r,350)});
    document.getElementById('borrowout-whom').value='自动化借用老师';
    var c=document.getElementById('borrowout-code'); c.value='690004'; c.dispatchEvent(new Event('input',{bubbles:true}));
    document.getElementById('borrowout-qty').value='1';
    var filled={name:document.getElementById('borrowout-name').value, wh:document.getElementById('borrowout-wh').value,
                stockEl:!!document.getElementById('borrowout-stock')};
    addOutLine('borrowout');
    var lines=outDraft.borrowout.length;
    sigOut.borrowout.load(${JSON.stringify(ink)});
    await new Promise(function(r){setTimeout(r,1200)});
    await submitOut('borrowout');
    await new Promise(function(r){setTimeout(r,300)});
    return {filled:filled, lines:lines, after:findItem('690004').qty, draft:outDraft.borrowout.length,
            toast:document.getElementById('toast-msg').textContent};
  })()`, true);
  console.log('借用结果：', JSON.stringify(borrowRes));
  assert(borrowRes.filled.name === '订书钉' && borrowRes.filled.wh === '耗材库', '借用扫码自动带出 名称/规格/单位/仓库', borrowRes.filled);
  assert(borrowRes.filled.stockEl === false, '借用页已无「当前库存」字段');
  assert(borrowRes.lines === 1, '非工具库物品也能加入借用单');
  assert(borrowRes.after === before['690004'] - 1, '借用后库存 -1', borrowRes.after);

  /* ---------- 持久化：刷新后仍在 ---------- */
  await cdp.send('Page.reload');
  await sleep(3000);
  for (let i = 0; i < 30; i++) { if (await cdp.eval('!!window.APP_READY')) break; await sleep(200); }
  await sleep(400);
  const persisted = await cdp.eval(`({a:findItem('690001').qty,b:findItem('690002').qty,c:findItem('690004').qty})`);
  console.log('刷新后库存：', JSON.stringify(persisted));
  assert(persisted.a === before['690001'] + 2, '入库结果已持久化');
  assert(persisted.b === before['690002'] - 1, '出库结果已持久化');
  assert(persisted.c === before['690004'] - 1, '借用结果已持久化');

  console.log(failed === 0 ? '\n业务流程全部通过' : '\n失败 ' + failed + ' 项');
  cdp.close();
  process.exit(failed === 0 ? 0 : 1);
})().catch(e => { console.error(e); process.exit(2); });
