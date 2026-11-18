'use strict';
/* 免登录模式（v2.0）
   按要求取消「管理员 / 库管员」账号体系：本机启动即视为教师本人使用，
   固定下发一个具备全部权限的本地会话，不再读写 users.json、不再校验密码、
   不再有 30 分钟空闲锁定。
   保留原有函数签名，避免 main.js / ipc.js 的调用链改动过大。 */
const { permsMap, hasPerm } = require('../shared/permissions');

const ROLE = 'admin';
const TOKEN = 'local-teacher';
const GUEST = {
  token: TOKEN,
  user: '教师',
  role: ROLE,
  createdAt: 0,
  lastSeen: 0
};

function init() { /* 免登录：不创建账号文件，也不启动空闲锁定定时器 */ }
function isInitialized() { return true; }
function session() { GUEST.lastSeen = Date.now(); return GUEST; }
function status() {
  GUEST.lastSeen = Date.now();
  return {
    initialized: true,
    loggedIn: true,
    role: ROLE,
    perms: permsMap(ROLE),
    expiresAt: null,
    guest: true
  };
}
function login() {
  return { ok: true, token: TOKEN, role: ROLE, perms: permsMap(ROLE), expiresAt: null, guest: true };
}
function logout() { return { ok: true }; }
function authorize(_token, perm) {
  if (!hasPerm(ROLE, perm)) return { ok: false, code: 'NO_PERM', message: '当前操作不可用' };
  return { ok: true, role: ROLE };
}
function setup() { return { ok: false, code: 'DISABLED', message: '本版本已取消账号功能，无需登录' }; }
function changePwd() { return { ok: false, code: 'DISABLED', message: '本版本已取消账号功能' }; }
function resetPwd() { return { ok: false, code: 'DISABLED', message: '本版本已取消账号功能' }; }
function consumeChallenge() { return true; }
function destroyAll() { /* 无会话表需要清理 */ }

module.exports = {
  init, isInitialized, setup, login, session, status, logout, authorize,
  consumeChallenge, changePwd, resetPwd, destroyAll
};
