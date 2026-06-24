// 读取 ~/.cache/claude_status_tips/status.json
// 由 Claude hook (bash) / opencode plugin (JS) 写入
// 优先级比 JSONL 高 —— hook 提供的是事件级精确状态
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const os = require('os');
const { STATES } = require('./state');

const DEFAULT_PATH = path.join(os.homedir(), '.cache', 'claude_status_tips', 'status.json');

// hook 写入的状态字符串 → 我们的 STATES 枚举
const STATE_MAP = {
  'working':                 STATES.WORKING,
  'awaiting-confirmation':   STATES.AWAITING_CONFIRMATION,
  'awaiting-input':          STATES.AWAITING_INPUT,
  'completed':               STATES.COMPLETED,
  'error':                   STATES.ERROR,
  // idle: Claude 进程在但没在做事 → 等输入 (和 sessions/<pid>.json status='idle' 一致)
  // SessionEnd 触发后很快进程会退, 走 stale 保护 fallback 到 procs 检测
  'idle':                    STATES.AWAITING_INPUT,
  'offline':                 STATES.OFFLINE,
};

/**
 * 把 hook status 的一项转换成与 readLatestActivity() 兼容的 activity 对象
 * lastEntry.state 已经是我们的 STATES 枚举值, state.js 直接使用
 */
function adaptEntry(entry) {
  if (!entry || typeof entry !== 'object') return null;
  const mapped = STATE_MAP[entry.state];
  if (!mapped) return null;

  let kind = 'text';
  if (entry.event === 'PreToolUse' || entry.event === 'tool.execute.before') kind = 'tool_use';
  else if (entry.event === 'PostToolUse' || entry.event === 'tool.execute.after') kind = 'tool_result';
  else if (entry.event === 'PostToolUseFailure') kind = 'tool_result';
  else if (entry.event === 'UserPromptSubmit') kind = 'user_text';
  else if (entry.event === 'Stop' || entry.event === 'session.idle' || entry.event === 'session.end') kind = 'result';
  else if (entry.event === 'SessionStart' || entry.event === 'session.start') kind = 'system';

  const lastEntry = {
    kind,
    toolName: entry.tool || '',
    summary: entry.summary || entry.tool || entry.event || '',
    state: mapped,
    isError: mapped === STATES.ERROR,
    requiresConfirmation: mapped === STATES.AWAITING_CONFIRMATION,
    ts: entry.ts || 0,
  };
  const ageMs = entry.ts ? Math.max(0, Date.now() - entry.ts) : 0;
  return { lastEntry, ageMs };
}

/**
 * @param {string} filePath  可选
 * @returns {Promise<{claude: object|null, opencode: object|null, trae: object|null, updatedAt: number, exists: boolean}>}
 */
async function readHookStatus(filePath = DEFAULT_PATH) {
  const result = { claude: null, opencode: null, trae: null, updatedAt: 0, exists: false };
  let raw;
  try {
    raw = await fsp.readFile(filePath, 'utf-8');
  } catch (e) {
    if (e.code === 'ENOENT') return result;
    return result;
  }
  result.exists = true;
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return result;
  }
  if (!parsed || typeof parsed !== 'object') return result;

  if (parsed.claude) {
    const a = adaptEntry(parsed.claude);
    if (a) result.claude = { ...a, source: 'claude-hook' };
  }
  if (parsed.opencode) {
    const a = adaptEntry(parsed.opencode);
    if (a) result.opencode = { ...a, source: 'opencode-plugin' };
  }
  if (parsed.trae) {
    const a = adaptEntry(parsed.trae);
    if (a) result.trae = { ...a, source: 'trae-hook' };
  }
  const tsList = [parsed.claude, parsed.opencode, parsed.trae].filter(Boolean).map(e => e.ts || 0);
  result.updatedAt = tsList.length ? Math.max(...tsList) : 0;
  return result;
}

/**
 * 同步版本 (供测试 / 非 async 上下文使用)
 */
function readHookStatusSync(filePath = DEFAULT_PATH) {
  const result = { claude: null, opencode: null, trae: null, updatedAt: 0, exists: false };
  if (!fs.existsSync(filePath)) return result;
  result.exists = true;
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch {
    return result;
  }
  if (!raw || typeof raw !== 'object') return result;

  if (raw.claude) {
    const a = adaptEntry(raw.claude);
    if (a) result.claude = { ...a, source: 'claude-hook' };
  }
  if (raw.opencode) {
    const a = adaptEntry(raw.opencode);
    if (a) result.opencode = { ...a, source: 'opencode-plugin' };
  }
  if (raw.trae) {
    const a = adaptEntry(raw.trae);
    if (a) result.trae = { ...a, source: 'trae-hook' };
  }
  const tsList = [raw.claude, raw.opencode, raw.trae].filter(Boolean).map(e => e.ts || 0);
  result.updatedAt = tsList.length ? Math.max(...tsList) : 0;
  return result;
}

module.exports = { readHookStatus, readHookStatusSync, adaptEntry, STATE_MAP, DEFAULT_PATH };
