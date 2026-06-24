// 进程监控: 检测 claude / opencode / Trae 是否在运行
// ps-list v8 是 ESM, 在 CJS 中必须用动态 import
const psListPromise = import('ps-list').then(m => m.default || m);

/**
 * 检测规则:
 *   - claude: 进程名 "claude" 或命令行包含 "claude-code" 等特征
 *   - opencode: 进程名 "opencode" 或命令行包含
 *   - trae: 进程名 "Trae"(大小写不敏感)
 *
 *   排除自身进程 (process.pid), 避免 Electron 主进程名包含 "claude" 时误中
 */
const SELF_PID = process.pid;

const RULES = {
  claude: (p) => {
    if (p.pid === SELF_PID) return false;
    const name = (p.name || '').toLowerCase();
    const cmd = (p.cmd || '').toLowerCase();
    if (name === 'claude' || name.startsWith('claude')) return true;
    if (cmd.includes('@anthropic-ai/claude-code') || cmd.includes('claude-code')) return true;
    return false;
  },
  opencode: (p) => {
    if (p.pid === SELF_PID) return false;
    const name = (p.name || '').toLowerCase();
    const cmd = (p.cmd || '').toLowerCase();
    if (name === 'opencode' || name.startsWith('opencode')) return true;
    if (cmd.includes('opencode')) return true;
    return false;
  },
  trae: (p) => {
    if (p.pid === SELF_PID) return false;
    const name = (p.name || '').toLowerCase();
    if (name === 'trae' || name.startsWith('trae')) return true;
    return false;
  },
};

/**
 * @returns {Promise<{
 *   claude: boolean, opencode: boolean, trae: boolean,
 *   details: object, processCount: number,
 * }>}
 */
async function detectProcesses() {
  let procs = [];
  try {
    const psList = await psListPromise;
    procs = await psList();
  } catch (e) {
    console.error('[monitor] ps-list failed:', e.message);
    return {
      claude: false, opencode: false, trae: false,
      details: { claude: [], opencode: [], trae: [] },
      processCount: 0,
    };
  }

  const matched = { claude: [], opencode: [], trae: [] };
  for (const p of procs) {
    for (const [tool, rule] of Object.entries(RULES)) {
      if (rule(p)) matched[tool].push(p);
    }
  }

  return {
    claude: matched.claude.length > 0,
    opencode: matched.opencode.length > 0,
    trae: matched.trae.length > 0,
    details: matched,
    processCount: procs.length,
  };
}

module.exports = { detectProcesses };
