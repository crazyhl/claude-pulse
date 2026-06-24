// 纯函数: 状态(state) → 标题 / tooltip 字符串
// 显示文案通过 i18n.t() 获取, 支持 en / zh-CN
const { STATES, ACTIVE_STATES, EXCLUDED_FROM_BAR, deriveAllStates } = require('./state');
const { t } = require('./i18n');

const TITLE_MAX_LEN = 24;

function clip(s, max = TITLE_MAX_LEN) {
  if (!s) return '';
  s = String(s).replace(/\s+/g, ' ').trim();
  if (s.length <= max) return s;
  return '\u2026' + s.slice(-(max - 1));
}

const STATE_EMOJI = {
  [STATES.OFFLINE]:               '\u26aa',  // ⚪
  [STATES.RUNNING]:               '\ud83d\udfe1',  // 🟡
  [STATES.AWAITING_CONFIRMATION]: '\ud83d\udfe1',
  [STATES.WORKING]:               '\ud83d\udfe2',  // 🟢
  [STATES.AWAITING_INPUT]:        '\ud83d\udfe2',
  [STATES.COMPLETED]:             '\ud83d\udfe3',  // 🟣
  [STATES.ERROR]:                 '\ud83d\udd34',  // 🔴
};

function toolDisplayName(key) {
  return t(`tool.${key}`);
}

function stateDesc(state) {
  return t(`state.${state}`);
}

function flashTag(state) {
  return [STATES.WORKING, STATES.AWAITING_CONFIRMATION, STATES.ERROR].includes(state)
    ? t('flashTag')
    : '';
}

/**
 * 单个 session 的显示名
 *   - claude + 项目名 (例如 "claude · CoolApk-v13")
 *   - opencode / trae 不带项目
 */
function sessionDisplayName(session) {
  const toolName = toolDisplayName(session.tool);
  if (session.project) return `${toolName} \u00b7 ${session.project}`;
  return toolName;
}

/**
 * 推导标题文字 (新版, 基于 deriveAllStates 返回的 sessions 数组)
 *
 * 'all' 模式: 显示所有 session 列表
 * 'cycle' 模式:
 *   - 0 个非 offline session: 空
 *   - 1 个非 offline: 显示 "tool · project" 或 "tool"
 *   - 2+ 个: 轮播 (rotationIndex 决定)
 *
 * @param {Array} sessions    deriveAllStates().sessions
 * @param {string} mode       'all' | 'cycle'
 * @param {number} rotationIndex
 */
function computeTitleFromSessions(sessions, mode, rotationIndex) {
  if (mode === 'all') {
    // all 模式: 显示所有非 offline session (包括 trae), 方便用户看全局
    const all = sessions.filter(s => s.state !== STATES.OFFLINE);
    return clip(all.map(sessionDisplayName).join(' \u00b7 '), TITLE_MAX_LEN * 2);
  }

  // cycle 模式: 过滤 offline 和 trae (EXCLUDED_FROM_BAR)
  const visible = sessions.filter(s =>
    s.state !== STATES.OFFLINE && !EXCLUDED_FROM_BAR.has(s.tool));

  if (visible.length === 0) return '';
  if (visible.length === 1) return sessionDisplayName(visible[0]);
  // 多 session 时轮播
  return sessionDisplayName(visible[rotationIndex % visible.length]);
}

/**
 * 旧 API 兼容: 单 activity 模式
 * @deprecated 改用 computeTitleFromSessions (直接传 sessions 数组)
 * 保留供测试文件使用, 生产代码不应调用
 */
function computeTitle(procs, activity, mode, rotationIndex, hooks) {
  // 兼容路径: 用 deriveAllStates 推导 sessions
  const claudeSessionEntries = [];
  if (procs && procs.claude) {
    const fakeSession = {
      pid: 0, sessionId: '', cwd: '', project: '',
      status: 'unknown', statusUpdatedAt: 0, file: '', raw: {},
    };
    const hookEntry = hooks && hooks.claude && hooks.claude.lastEntry ? hooks.claude.lastEntry : null;
    claudeSessionEntries.push({ session: fakeSession, activity, hookEntry });
  }
  const derived = deriveAllStates(procs, claudeSessionEntries, hooks || {});
  return computeTitleFromSessions(derived.sessions, mode, rotationIndex);
}

/**
 * tooltip (新版, 列出所有 sessions)
 */
function computeTooltipFromSessions(sessions, hooks) {
  const lines = [];
  // summary 行: 概览所有可见 session
  const visible = sessions.filter(s =>
    s.state !== STATES.OFFLINE && !EXCLUDED_FROM_BAR.has(s.tool));
  if (visible.length === 0) {
    lines.push(t('tooltip.allOffline'));
  } else {
    const items = visible.map(s =>
      t('tooltip.summaryItem', STATE_EMOJI[s.state], sessionDisplayName(s), stateDesc(s.state), flashTag(s.state)));
    lines.push(items.join(' \u00b7 '));
  }

  // 详情: 每个 session 一行
  for (const s of sessions) {
    if (s.tool === 'claude') {
      if (s.lastEntry) {
        const age = s.ageMs != null ? Math.floor(s.ageMs / 1000) : null;
        const ageStr = age != null ? t('tooltip.ageStr', age) : '';
        const label = s.project ? `${t('tool.claude')} · ${s.project}` : t('tool.claude');
        lines.push(t('tooltip.claudeLine', label, s.lastEntry.summary || '', ageStr));
      } else if (s.state !== STATES.OFFLINE) {
        const label = s.project ? `${t('tool.claude')} · ${s.project}` : t('tool.claude');
        lines.push(t('tooltip.claudeNoSession', label));
      }
    } else if (s.tool === 'opencode' && s.state !== STATES.OFFLINE) {
      if (s.lastEntry && s.lastEntry.summary) {
        lines.push(t('tooltip.opencodeHook', s.lastEntry.summary));
      } else {
        lines.push(t('tooltip.opencodeRunning'));
      }
    } else if (s.tool === 'trae' && s.state !== STATES.OFFLINE) {
      lines.push(t('tooltip.traeRunning'));
    }
  }

  return lines.join('\n');
}

/**
 * 旧 API 兼容
 * @deprecated 改用 computeTooltipFromSessions (直接传 sessions 数组)
 * 保留供测试文件使用, 生产代码不应调用
 */
function computeTooltip(procs, activity, hooks) {
  // 兼容路径: 用 deriveAllStates 真实推导状态
  const claudeSessionEntries = [];
  if (procs && procs.claude) {
    const fakeSession = {
      pid: 0, sessionId: '', cwd: '', project: '',
      status: 'unknown', statusUpdatedAt: 0, file: '', raw: {},
    };
    const hookEntry = hooks && hooks.claude && hooks.claude.lastEntry ? hooks.claude.lastEntry : null;
    claudeSessionEntries.push({ session: fakeSession, activity, hookEntry });
  }
  const derived = deriveAllStates(procs, claudeSessionEntries, hooks || {});
  return computeTooltipFromSessions(derived.sessions, hooks);
}

module.exports = {
  clip,
  computeTitle,
  computeTitleFromSessions,
  computeTooltip,
  computeTooltipFromSessions,
  sessionDisplayName,
  TITLE_MAX_LEN,
  STATE_EMOJI,
  toolDisplayName,
  stateDesc,
  flashTag,
};
