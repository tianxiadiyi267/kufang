'use strict';
/* Single source of truth for role permissions. The main process is authoritative. */
const PERMS = {
  admin: [
    'write', 'delete', 'clearHistory', 'restore', 'backup',
    'downloadDb', 'importBackup', 'dbPanel', 'userManage', 'auditView'
  ],
  operator: ['write']
};

function permsFor(role) { return (PERMS[role] || []).slice(); }
function permsMap(role) {
  const out = {};
  for (const p of permsFor(role)) out[p] = true;
  return out;
}
function hasPerm(role, perm) { return permsFor(role).indexOf(perm) >= 0; }

module.exports = { PERMS, permsFor, permsMap, hasPerm };
