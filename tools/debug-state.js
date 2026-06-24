// 调试: 查看 state.js 完整数据源链 (procs / hook / sessions / JSONL)
const { detectProcesses } = require('../src/monitor');
const { readLatestActivity } = require('../src/claudeActivity');
const { readHookStatus } = require('../src/statusReader');
const { readAllClaudeSessions, projectNameFromCwd } = require('../src/sessionReader');
const {
  deriveAllStates,
  FLASHING_STATES,
  HOOK_STALE_MS,
  SESSION_STALE_MS,
  isHookStale,
} = require('../src/state');
const { computeTitleFromSessions, computeTooltipFromSessions, stateDesc } = require('../src/title');
const { getLocale } = require('../src/i18n');

(async () => {
  const procs = await detectProcesses();
  const hooks = await readHookStatus();

  // 多 session 模式
  const allSessionsData = await readAllClaudeSessions(procs);
  const claudeSessionEntries = await Promise.all(
    allSessionsData.sessions.map(async (session) => {
      const hints = {};
      if (session.sessionId) hints.hintSessionId = session.sessionId;
      if (session.cwd)        hints.hintCwd      = session.cwd;
      const activity = await readLatestActivity(hints);
      const hookEntry = hooks.claude && hooks.claude.lastEntry ? hooks.claude.lastEntry : null;
      return { session, activity, hookEntry };
    })
  );

  const hookStale = hooks.claude && hooks.claude.lastEntry
    ? isHookStale({ lastEntry: hooks.claude.lastEntry })
    : true;
  const derived = deriveAllStates(procs, claudeSessionEntries, hooks);
  const title = computeTitleFromSessions(derived.sessions, 'cycle', 0);
  const tooltip = computeTooltipFromSessions(derived.sessions, hooks);

  console.log(`(locale = ${getLocale()})`);
  console.log('=== 数据源 ===');
  console.log('procs:', {
    claude: procs.claude,
    opencode: procs.opencode,
    trae: procs.trae,
    liveClaudePids: procs.details && procs.details.claude && procs.details.claude.map(p => p.pid),
  });
  console.log('');
  console.log('hook (status.json):', hooks);
  console.log('hook stale?', hookStale, `(>${HOOK_STALE_MS / 1000}s 视为过期)`);
  console.log('');
  console.log('sessions (~/.claude/sessions):');
  for (const s of allSessionsData.sessions) {
    console.log(`  ✓ pid=${s.pid}  project=${s.project}  status=${s.status}  age=${Math.floor((Date.now() - s.statusUpdatedAt) / 1000)}s`);
  }
  for (const s of allSessionsData.inactiveSessions) {
    console.log(`  ✗ pid=${s.pid}  project=${s.project}  [dead process]`);
  }
  console.log(`  → live=${allSessionsData.sessions.length}, inactive=${allSessionsData.inactiveSessions.length}`);
  console.log(`session stale 阈值 = ${SESSION_STALE_MS / 1000}s`);
  console.log('');

  console.log('=== 各 session 状态 ===');
  for (const s of derived.sessions) {
    const flash = FLASHING_STATES.has(s.state) ? ' (闪烁)' : '';
    console.log(`  ${s.tool}·${s.project || '-'}: ${stateDesc(s.state)}${flash}`);
  }
  console.log('');
  console.log('tools:', derived.tools);
  console.log('activeNames:', derived.activeNames);
  console.log('anyRunning:', derived.anyRunning);
  console.log('worst:', derived.worst);
  console.log('title:', JSON.stringify(title));
  console.log('');
  console.log('=== tooltip ===');
  console.log(tooltip);
})();
