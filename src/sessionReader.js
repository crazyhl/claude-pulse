// 读取 ~/.claude/sessions/<pid>.json
// 这是 Claude 进程自己维护的实时状态文件, 比 JSONL 推算更精确,
// 不依赖 hook 也能用.
//
// 文件结构:
//   {
//     "pid": 2228,
//     "sessionId": "9eb0c900-91bf-4649-b045-077a9af57baa",
//     "cwd": "/Users/haoliang/PhpProject/CoolApk-v13",
//     "startedAt": 1781688328323,
//     "status": "idle",                  <-- 原始字符串
//     "updatedAt": 1781765420925,
//     "statusUpdatedAt": 1781765420925
//   }
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const os = require('os');

const SESSIONS_DIR = path.join(os.homedir(), '.claude', 'sessions');

/**
 * 从 cwd 推导项目短名 (~/PhpProject/CoolApk-v13 → CoolApk-v13)
 */
function projectNameFromCwd(cwd) {
  if (!cwd) return '';
  const parts = cwd.split('/').filter(Boolean);
  return parts[parts.length - 1] || cwd;
}

/**
 * 列出 ~/.claude/sessions/ 下所有有效 session 文件 (异步)
 */
async function listSessions() {
  let entries;
  try { entries = await fsp.readdir(SESSIONS_DIR); } catch { return []; }
  const out = [];
  await Promise.all(entries.map(async (name) => {
    if (!name.endsWith('.json')) return;
    const file = path.join(SESSIONS_DIR, name);
    let raw;
    try {
      const text = await fsp.readFile(file, 'utf-8');
      raw = JSON.parse(text);
    } catch { return; }
    if (!raw || typeof raw !== 'object' || !raw.pid) return;
    out.push({
      pid: raw.pid,
      file,
      raw,
      status: raw.status || 'unknown',
      statusUpdatedAt: raw.statusUpdatedAt || raw.updatedAt || 0,
      sessionId: raw.sessionId || '',
      cwd: raw.cwd || '',
      project: projectNameFromCwd(raw.cwd),
    });
  }));
  return out;
}

/**
 * 兼容旧 API: 返回单个 claude session (最新更新的, 用于回退到单 session 场景)
 * @deprecated 改用 readAllClaudeSessions
 */
async function readSessionStatus(procs) {
  const all = await listSessions();
  if (all.length === 0) return { claudeSession: null, all };
  let claudeSession = null;
  if (procs && procs.details && Array.isArray(procs.details.claude)) {
    const livePids = new Set(procs.details.claude.map(p => p.pid));
    const candidates = all.filter(s => livePids.has(s.pid));
    if (candidates.length > 0) {
      candidates.sort((a, b) => b.statusUpdatedAt - a.statusUpdatedAt);
      claudeSession = candidates[0];
    }
  }
  if (!claudeSession) {
    const sorted = [...all].sort((a, b) => b.statusUpdatedAt - a.statusUpdatedAt);
    claudeSession = sorted[0] || null;
  }
  return { claudeSession, all };
}

/**
 * 新 API: 返回所有**当前 live pid 匹配**的 claude session
 * 每个 live claude 进程对应一个 session, 用于多 session 并行监控
 *
 * @param {object} procs detectProcesses() 结果, 用 details.claude[].pid 做匹配
 * @returns {Promise<{
 *   sessions: Array<{pid, sessionId, cwd, project, status, statusUpdatedAt, raw}>,
 *   inactiveSessions: Array<object>,  // 文件存在但进程已死的 session
 * }>}
 */
async function readAllClaudeSessions(procs) {
  const all = await listSessions();
  if (all.length === 0) return { sessions: [], inactiveSessions: [] };

  const livePids = new Set();
  if (procs && procs.details && Array.isArray(procs.details.claude)) {
    for (const p of procs.details.claude) livePids.add(p.pid);
  }

  const sessions = [];
  const inactiveSessions = [];
  for (const s of all) {
    if (livePids.has(s.pid)) sessions.push(s);
    else inactiveSessions.push(s);
  }
  // 按最近更新排序
  sessions.sort((a, b) => b.statusUpdatedAt - a.statusUpdatedAt);
  return { sessions, inactiveSessions };
}

module.exports = {
  readSessionStatus,
  readAllClaudeSessions,
  listSessions,
  projectNameFromCwd,
  SESSIONS_DIR,
};
