// 状态推导: 把 process + activity 数据转成可视状态
// 与 Electron / i18n 解耦, 方便单测
//
// 注意: 不再用进程 CPU 来判定 working —— 后台进程(socket、UI 渲染、心跳)
//       会让 CPU 偶尔 spike, 误判严重。状态判定完全基于:
//         - claude: JSONL 最后一条记录 + age
//         - opencode / trae: 进程是否存在 (RUNNING / OFFLINE)
//       如需更精确, 应改用 Claude Code Hooks 接收精确事件.

const STATES = Object.freeze({
  OFFLINE:                'offline',                  // 灰
  RUNNING:                'running',                  // 黄
  AWAITING_CONFIRMATION:  'awaiting-confirmation',    // 黄 闪烁
  WORKING:                'working',                  // 绿 闪烁
  AWAITING_INPUT:         'awaiting-input',           // 绿
  COMPLETED:              'completed',                // 蓝
  ERROR:                  'error',                    // 红 闪烁
});

// "活跃"(任务在跑)状态集合 —— 状态机定义
const ACTIVE_STATES = new Set([STATES.WORKING, STATES.AWAITING_CONFIRMATION]);

// 需要闪烁的状态集合
const FLASHING_STATES = new Set([STATES.WORKING, STATES.AWAITING_CONFIRMATION, STATES.ERROR]);

// 状态优先级: 用于 worst 决策 (数值越大越优先显示)
const STATE_PRIORITY = {
  [STATES.ERROR]:                  6,
  [STATES.AWAITING_CONFIRMATION]:  5,
  [STATES.WORKING]:                4,
  [STATES.AWAITING_INPUT]:         3,
  [STATES.RUNNING]:                2,
  [STATES.COMPLETED]:              1,
  [STATES.OFFLINE]:                0,
};

/**
 * 不参与状态栏核心展示的工具 (Trae 不支持 hooks, 没有详细活动日志)
 * 这些工具的 status 仍然可在 tooltip / 菜单中查看, 但:
 *   - 不进 anyRunning / activeNames, 不轮播
 *   - 不参与 worst, 不决定图标颜色
 *   - 仅有 running / offline 两态
 */
const EXCLUDED_FROM_BAR = new Set(['trae']);

// 阈值(毫秒)
const T = {
  ACTIVE:          3_000,    // < 3s 视为"刚刚在做事"
  CONFIRM_WAIT:    3_000,    // 工具发出后 3s 内可能还在跑/自动执行
  CONFIRM_TIMEOUT: 60_000,   // 60s 还没结果视为确认超时
  RECENT:         30_000,    // < 30s 算"最近活动过"
  STALE:          300_000,   // > 5min 算"长时无活动"
};

// hook status.json 超时时间 —— 超过此时间认为 hook 数据 stale, fallback
const HOOK_STALE_MS = 5 * 60 * 1000;
// sessions/<pid>.json status 字段超时时间
const SESSION_STALE_MS = 5 * 60 * 1000;

/**
 * Claude 会话文件 (~/.claude/sessions/<pid>.json) 里 status 字段到 7 态的映射
 * inline 在这里避免和 sessionReader 循环依赖.
 */
const SESSION_STATUS_MAP = {
  'idle':       STATES.AWAITING_INPUT,     // 用户最常见: 等输入 = 绿常亮
  'ready':      STATES.AWAITING_INPUT,
  'waiting':    STATES.AWAITING_CONFIRMATION,
  'pending':    STATES.AWAITING_CONFIRMATION,
  'running':    STATES.WORKING,
  'active':     STATES.WORKING,
  'responding': STATES.WORKING,
  'busy':       STATES.WORKING,
  'starting':   STATES.RUNNING,
  'loading':    STATES.RUNNING,
  'finished':   STATES.COMPLETED,
  'complete':   STATES.COMPLETED,
  'done':       STATES.COMPLETED,
  'exited':     STATES.COMPLETED,
  'error':      STATES.ERROR,
  'failed':     STATES.ERROR,
  'crashed':    STATES.ERROR,
};

function mapSessionStatus(statusStr) {
  if (!statusStr) return null;
  return SESSION_STATUS_MAP[statusStr] || null;
}

/**
 * hook status.json 是否过期 (超过 5 分钟视为不可信)
 * 兼容 hook 写入的 ts 字段 和理论上可能的 timestamp 字段
 */
function isHookStale(activity) {
  if (!activity || !activity.lastEntry) return true;
  const ts = activity.lastEntry.ts || activity.lastEntry.timestamp;
  if (!ts) return true;  // 无时间戳视为不可信
  return (Date.now() - ts) > HOOK_STALE_MS;
}

/**
 * 推导单个 claude session 的状态 (per-pid)
 *
 * @param {object} sessionInfo   readAllClaudeSessions 的单条 session
 * @param {object} activity      readLatestActivity() 结果
 * @param {object} hookEntry     hooks.claude.lastEntry (可选)
 * @returns {string} STATE.*
 */
/**
 * 推导单个 claude session 的状态 (per-pid)
 *
 * 数据源优先级 (按你的要求"完全依赖 status"):
 *   0. sessions/<pid>.json 的 status 字段 —— Claude 自己报告的实时状态 (主要数据源)
 *   1. hook (status.json) —— 仅在 sessions.status 缺失时作为 fallback
 *
 * 为什么 sessions 优先:
 *   - sessions 是 Claude 进程主循环同步更新的, 实时
 *   - hook 是 bash 脚本异步写入, 有几百 ms 到几秒延迟, 经常和 sessions 错位
 *   - hook 是全局共用, 多进程时可能错位 (session A 的事件被错用到 session B)
 *   - hook 卸载不彻底时, 会写 stale 状态
 *   - Claude 自己的 status 字段已经够准 (waiting/running/idle/error 都覆盖了 7 态)
 *
 * @param {object} sessionInfo   readAllClaudeSessions 的单条 session (含 status)
 * @param {object} hookEntry     hooks.claude.lastEntry (可选, 仅作 fallback)
 * @returns {string} STATE.*
 */
function deriveClaudeSessionState(sessionInfo, hookEntry) {
  // 0) sessions/<pid>.json 的 status 字段 —— Claude 自己报告的, 优先
  if (sessionInfo && sessionInfo.status) {
    const mapped = mapSessionStatus(sessionInfo.status);
    if (mapped) return mapped;
  }

  // 1) hook fallback —— 只在 sessions.status 完全不可用时 (例如进程刚启动还没写 sessions)
  //    同样需要 stale 检查, 避免用 hook 写了几小时前的 stale 状态
  if (hookEntry && hookEntry.state && !isHookStale({ lastEntry: hookEntry })) {
    const s = hookEntry.state;
    if (Object.values(STATES).includes(s)) return s;
  }

  // 兜底: 有进程但没任何 status 数据
  return STATES.RUNNING;
}

/**
 * 兼容旧签名 (带 activity) —— ignore activity
 * @deprecated 改用 deriveClaudeSessionState (不需要 activity 参数)
 */
function deriveClaudeSessionStateLegacy(sessionInfo, activity, hookEntry) {
  return deriveClaudeSessionState(sessionInfo, hookEntry);
}

/**
 * 推导 Claude Code 的状态(单 session 兼容 API)
 * 数据源优先级:
 *   0. hook (status.json) —— 但 stale 自动降级
 *   1. sessions/<pid>.json 的 status 字段
 *   2. JSONL 最后一条记录 + age
 *
 * @deprecated 改用 deriveAllStates + deriveClaudeSessionState
 * @param {object} procs       detectProcesses() 结果
 * @param {object} activity    readLatestActivity() 结果 (JSONL + 可选 hook 注入)
 * @param {object} sessions    readSessionStatus() 结果 { claudeSession, all }
 * @returns {string} STATE.*
 */
function deriveClaudeState(procs, activity, sessions) {
  if (!procs || !procs.claude) return STATES.OFFLINE;
  const sessionInfo = sessions && sessions.claudeSession ? sessions.claudeSession : null;
  const hookEntry = activity && activity.lastEntry && activity.lastEntry.state
    ? activity.lastEntry : null;
  return deriveClaudeSessionState(sessionInfo, hookEntry);
}

/**
 * opencode / Trae 状态推导
 * - 进程不在 → offline
 * - hook 有数据 → 直接用 hook 状态
 * - 否则: RUNNING(进程在但不证明在执行任务)
 */
function deriveSimpleState(procs, toolKey, hook) {
  if (!procs || !procs[toolKey]) return STATES.OFFLINE;
  if (hook && hook.lastEntry && hook.lastEntry.state) {
    const s = hook.lastEntry.state;
    if (Object.values(STATES).includes(s)) return s;
  }
  return STATES.RUNNING;
}

/**
 * 综合所有工具 + 所有 session 的状态
 *
 * 双签名兼容:
 *   新: deriveAllStates(procs, claudeSessionEntries, hooks)  -- array
 *   旧: deriveAllStates(procs, activity, hooks, sessions)    -- object
 */
function deriveAllStates(procs, claudeSessionEntriesOrActivity, hooks = {}, sessions = null) {
  // 旧 API 检测: 第二参数不是 array 且 (有 lastEntry / state) 或第 4 参数 sessions 存在
  const isOldApi = !Array.isArray(claudeSessionEntriesOrActivity)
                && (claudeSessionEntriesOrActivity == null
                    || typeof claudeSessionEntriesOrActivity !== 'object'
                    || claudeSessionEntriesOrActivity.lastEntry !== undefined
                    || claudeSessionEntriesOrActivity.state !== undefined
                    || sessions != null);
  if (isOldApi) {
    return deriveAllStatesLegacy(procs, claudeSessionEntriesOrActivity, hooks, sessions);
  }
  return deriveAllStatesMulti(procs, claudeSessionEntriesOrActivity || [], hooks);
}

/**
 * 旧 API 兼容: 把单 activity 转成 entry 数组
 * @deprecated 改用 deriveAllStates (直接传 claudeSessionEntries 数组)
 */
function deriveAllStatesLegacy(procs, activity, hooks = {}, sessions = null) {
  let entries = [];
  if (sessions && sessions.claudeSession) {
    const hookEntry = activity && activity.lastEntry && activity.lastEntry.state
      ? activity.lastEntry : null;
    entries = [{ session: sessions.claudeSession, activity, hookEntry }];
  } else if (activity) {
    entries = [{ session: null, activity, hookEntry: null }];
  }
  return deriveAllStates(procs, entries, hooks);
}

/**
 * 多 session 实现
 */
function deriveAllStatesMulti(procs, claudeSessionEntries = [], hooks = {}) {
  const sessions = [];
  const toolStates = { claude: STATES.OFFLINE, opencode: STATES.OFFLINE, trae: STATES.OFFLINE };

  // Claude: 多 session 独立
  if (Array.isArray(claudeSessionEntries) && claudeSessionEntries.length > 0) {
    let bestPriority = -1;
    let worstClaude = STATES.OFFLINE;
    for (const e of claudeSessionEntries) {
      if (!e) continue;
      // 兼容: session 可能为 null (旧 API 模式, 仅用 activity + hook 推导)
      const session = e.session || { pid: 0, project: '', cwd: '', status: '', statusUpdatedAt: 0 };
      const s = deriveClaudeSessionState(e.session, e.hookEntry);
      // 推导 stateSource (供菜单 / 调试使用, 让用户能看出状态来自 hook 还是 sessions)
      // 优先级 (与 deriveClaudeSessionState 保持一致): sessions 优先, hook 仅 fallback
      let stateSource = 'default';
      if (session && session.status) {
        stateSource = 'sessions';
      } else if (e.hookEntry && e.hookEntry.state && !isHookStale({ lastEntry: e.hookEntry })) {
        stateSource = 'hook';
      }
      sessions.push({
        tool: 'claude',
        pid: session.pid,
        sessionId: session.sessionId,
        project: session.project || (session.cwd ? session.cwd.split('/').filter(Boolean).pop() : ''),
        cwd: session.cwd,
        state: s,
        stateSource,
        lastEntry: e.activity && e.activity.lastEntry,
        ageMs: e.activity && e.activity.ageMs,
        source: e.activity && e.activity.source,
      });
      const p = STATE_PRIORITY[s] != null ? STATE_PRIORITY[s] : 99;
      if (p > bestPriority) {
        bestPriority = p;
        worstClaude = s;
      }
    }
    if (sessions.filter(s => s.tool === 'claude').length > 0) {
      toolStates.claude = worstClaude;
    }
  }

  // opencode / trae: 单状态
  toolStates.opencode = deriveSimpleState(procs, 'opencode', hooks.opencode);
  toolStates.trae     = deriveSimpleState(procs, 'trae',     hooks.trae);

  // opencode / trae 各算一个 session (没有 per-pid 细分)
  if (toolStates.opencode !== STATES.OFFLINE) {
    sessions.push({
      tool: 'opencode',
      pid: null,
      project: '',
      state: toolStates.opencode,
      lastEntry: hooks.opencode && hooks.opencode.lastEntry,
      ageMs: hooks.opencode && hooks.opencode.ageMs,
    });
  }
  if (toolStates.trae !== STATES.OFFLINE) {
    sessions.push({
      tool: 'trae',
      pid: null,
      project: '',
      state: toolStates.trae,
      lastEntry: hooks.trae && hooks.trae.lastEntry,
      ageMs: hooks.trae && hooks.trae.ageMs,
    });
  }

  // activeNames / anyRunning: 用 sessions 而非 tools
  // Trae 等 EXCLUDED_FROM_BAR 工具不进轮播池
  const activeNames = [];
  const anyRunning = [];
  for (const s of sessions) {
    if (s.state === STATES.OFFLINE) continue;
    if (EXCLUDED_FROM_BAR.has(s.tool)) continue;
    if (!anyRunning.includes(s.tool)) anyRunning.push(s.tool);
    if (ACTIVE_STATES.has(s.state) && !activeNames.includes(s.tool)) activeNames.push(s.tool);
  }

  // worst: 跨所有 session 的最高优先级 (排除 trae)
  let worst = STATES.OFFLINE;
  let worstPriority = -1;
  for (const s of sessions) {
    if (EXCLUDED_FROM_BAR.has(s.tool)) continue;
    const p = STATE_PRIORITY[s.state] != null ? STATE_PRIORITY[s.state] : 99;
    if (p > worstPriority) {
      worstPriority = p;
      worst = s.state;
    }
  }

  return { tools: toolStates, sessions, activeNames, anyRunning, worst };
}

/**
 * 把状态名转成图标文件名
 */
function stateToIconBase(state) {
  switch (state) {
    case STATES.OFFLINE:               return 'gray';
    case STATES.RUNNING:               return 'yellow';
    case STATES.AWAITING_CONFIRMATION: return 'yellow';
    case STATES.WORKING:               return 'green';
    case STATES.AWAITING_INPUT:        return 'green';
    case STATES.COMPLETED:             return 'blue';
    case STATES.ERROR:                 return 'red';
    default:                           return 'gray';
  }
}

module.exports = {
  STATES,
  ACTIVE_STATES,
  FLASHING_STATES,
  EXCLUDED_FROM_BAR,
  STATE_PRIORITY,
  T,
  HOOK_STALE_MS,
  SESSION_STALE_MS,
  SESSION_STATUS_MAP,
  deriveClaudeState,
  deriveClaudeSessionState,
  deriveSimpleState,
  deriveAllStates,
  deriveAllStatesLegacy,
  deriveAllStatesMulti,
  stateToIconBase,
  mapSessionStatus,
  isHookStale,
  STATE_DESC_EN: {
    [STATES.OFFLINE]:               'Idle',
    [STATES.RUNNING]:               'Running',
    [STATES.AWAITING_CONFIRMATION]: 'Awaiting confirmation',
    [STATES.WORKING]:               'Working',
    [STATES.AWAITING_INPUT]:        'Awaiting input',
    [STATES.COMPLETED]:             'Completed',
    [STATES.ERROR]:                 'Error',
  },
};