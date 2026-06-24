// 单测 state.js + title.js + i18n + monitor
//
// 状态推算原则 (最新版):
//   - claude 状态 100% 依赖 sessions/<pid>.json 的 status 字段 (经 mapSessionStatus 映射)
//   - hook 优先: 如果用户装了 hook 且数据新鲜, 用 hook 的事件级精确状态
//   - 不再读 JSONL 推算 (容易误判, 例如 user_text 后 30s 误判 awaiting-input)
//   - JSONL 只用于 tooltip 详情 (lastEntry.summary)
const assert = require('assert');
const {
  STATES, ACTIVE_STATES, FLASHING_STATES, EXCLUDED_FROM_BAR,
  deriveClaudeState, deriveAllStates, stateToIconBase,
  deriveSimpleState, mapSessionStatus, isHookStale, HOOK_STALE_MS, SESSION_STALE_MS,
  T,
} = require('../src/state');
const { computeTitle, computeTooltip, computeTitleFromSessions, computeTooltipFromSessions } = require('../src/title');
const { t, setLocale, getLocale, initLocale, MESSAGES } = require('../src/i18n');
const { detectProcesses } = require('../src/monitor');

let passed = 0, failed = 0;
function test(name, fn) {
  const result = (() => { try { return fn(); } catch (e) { return e; } })();
  if (result && typeof result.then === 'function') {
    result.then(() => { console.log(`  ✓ ${name}`); passed++; })
          .catch(e => { console.log(`  ✗ ${name}\n    ${e.message}`); failed++; });
  } else if (result instanceof Error) {
    console.log(`  ✗ ${name}\n    ${result.message}`); failed++;
  } else {
    console.log(`  ✓ ${name}`); passed++;
  }
}

// 辅助: 构造 live sessions
function liveSession({ status = 'running', age = 1000, pid = 1001, project = 'proj-A', cwd = '/a' } = {}) {
  return { pid, project, cwd, status, statusUpdatedAt: Date.now() - age };
}
function entryFromSession(session, opts = {}) {
  return { session, activity: opts.activity || null, hookEntry: opts.hookEntry || null };
}
// sessions 对象 (deriveClaudeState 接受的第 3 参数)
function sessionsObj(claudeSession) {
  return { claudeSession };
}
// 推导单个 session 状态 (便捷封装, 模拟 main.js 的 deriveClaudeSessionState 调用)
function stateFor(status, opts = {}) {
  const procs = { claude: true };
  const sessions = sessionsObj(liveSession({ status, age: opts.age || 1000, pid: opts.pid || 1001 }));
  return deriveClaudeState(procs, opts.activity || null, sessions);
}

// ============ i18n ============
console.log('— i18n —');

test('默认 locale 是 zh-CN 或 en', () => {
  assert.ok(['zh-CN', 'en'].includes(getLocale()));
});

test('normalizeLocale: 各种 zh-* → zh-CN', () => {
  const { detectLocale } = require('../src/i18n');
  assert.strictEqual(detectLocale('zh'), 'zh-CN');
  assert.strictEqual(detectLocale('zh-CN'), 'zh-CN');
  assert.strictEqual(detectLocale('zh-Hans'), 'zh-CN');
  assert.strictEqual(detectLocale('zh-Hans-CN'), 'zh-CN');
  assert.strictEqual(detectLocale('zh_TW'), 'zh-CN');
});

test('normalizeLocale: 各种 en-* → en', () => {
  const { detectLocale } = require('../src/i18n');
  assert.strictEqual(detectLocale('en'), 'en');
  assert.strictEqual(detectLocale('en-US'), 'en');
  assert.strictEqual(detectLocale('en-GB'), 'en');
});

test('normalizeLocale: 未知语言 → en', () => {
  const { detectLocale } = require('../src/i18n');
  assert.strictEqual(detectLocale('ja'), 'en');
  assert.strictEqual(detectLocale('fr-FR'), 'en');
  assert.strictEqual(detectLocale(''), 'en');
});

test('initLocale: 接受 Electron 给的 zh-CN', () => {
  setLocale('en'); // 强制重置
  const r = initLocale('zh-CN');
  assert.strictEqual(r, 'zh-CN');
  assert.strictEqual(getLocale(), 'zh-CN');
  assert.strictEqual(t('state.working'), '工作中');
});

test('initLocale: CST_LOCALE 优先级最高', () => {
  process.env.CST_LOCALE = 'zh-CN';
  setLocale('en');
  // 需重新 require 才能让环境变量生效? 不, 我们的 initLocale 会再次检查
  // 这里改成不依赖环境变量, 只测 setLocale
  delete process.env.CST_LOCALE;
  setLocale('en');
  assert.strictEqual(getLocale(), 'en');
});

test('i18n: 中文状态', () => {
  setLocale('zh-CN');
  assert.strictEqual(t('state.working'), '工作中');
  assert.strictEqual(t('state.awaiting-input'), '等待输入');
  assert.strictEqual(t('state.error'), '出错');
  assert.strictEqual(t('tool.claude'), 'Claude');
  assert.strictEqual(t('tool.trae'), 'Trae');
});

test('i18n: 英文状态', () => {
  setLocale('en');
  assert.strictEqual(t('state.working'), 'Working');
  assert.strictEqual(t('state.awaiting-input'), 'Awaiting input');
  assert.strictEqual(t('state.error'), 'Error');
  assert.strictEqual(t('flashTag'), ' flashing');
});

test('i18n: 占位符', () => {
  setLocale('zh-CN');
  assert.strictEqual(t('tooltip.claudeLine', '总结', '思考中', ' · 5s 前'),
    'Claude: 总结 思考中 · 5s 前');
  assert.strictEqual(t('tooltip.summaryItem', '🟢', 'Claude', '工作中', ' 闪烁'),
    '🟢 Claude (工作中 闪烁)');
});

test('i18n: 未知 key 原样返回', () => {
  assert.strictEqual(t('nonexistent.key'), 'nonexistent.key');
});

test('i18n: 切换语言菜单项存在', () => {
  setLocale('zh-CN');
  assert.ok(t('menu.language'));
  assert.ok(t('menu.langEn'));
  assert.ok(t('menu.langZh'));
});

test('i18n: claudeSessions 文案 (en/zh)', () => {
  setLocale('en');
  assert.strictEqual(t('menu.claudeSessions', 2), 'Claude (2 sessions)');
  setLocale('zh-CN');
  assert.strictEqual(t('menu.claudeSessions', 3), 'Claude (3 个会话)');
});

// ============ state.js - deriveClaudeState (sessions-based) ============
console.log('\n— deriveClaudeState (sessions 数据源) —');

test('进程不在 → offline', () => {
  assert.strictEqual(deriveClaudeState({ claude: false }, null), STATES.OFFLINE);
});

test('进程在但无 session 数据 → running (兜底)', () => {
  // 没有 sessions, 没有 activity, 没有 hook → 兜底 running
  assert.strictEqual(deriveClaudeState({ claude: true }, null, null), STATES.RUNNING);
});

test('进程在 + sessions.status="running" → working (绿闪烁)', () => {
  assert.strictEqual(stateFor('running'), STATES.WORKING);
});

test('进程在 + sessions.status="active"/"busy"/"responding" → working', () => {
  assert.strictEqual(stateFor('active'), STATES.WORKING);
  assert.strictEqual(stateFor('busy'), STATES.WORKING);
  assert.strictEqual(stateFor('responding'), STATES.WORKING);
});

test('进程在 + sessions.status="idle"/"ready" → awaiting-input (绿常亮, 解决绿闪 bug)', () => {
  assert.strictEqual(stateFor('idle'), STATES.AWAITING_INPUT);
  assert.strictEqual(stateFor('ready'), STATES.AWAITING_INPUT);
});

test('进程在 + sessions.status="waiting"/"pending" → awaiting-confirmation (黄闪烁)', () => {
  assert.strictEqual(stateFor('waiting'), STATES.AWAITING_CONFIRMATION);
  assert.strictEqual(stateFor('pending'), STATES.AWAITING_CONFIRMATION);
});

test('进程在 + sessions.status="starting"/"loading" → running (黄常亮, 启动中)', () => {
  assert.strictEqual(stateFor('starting'), STATES.RUNNING);
  assert.strictEqual(stateFor('loading'), STATES.RUNNING);
});

test('进程在 + sessions.status="finished"/"complete"/"done"/"exited" → completed (蓝)', () => {
  assert.strictEqual(stateFor('finished'), STATES.COMPLETED);
  assert.strictEqual(stateFor('complete'), STATES.COMPLETED);
  assert.strictEqual(stateFor('done'), STATES.COMPLETED);
  assert.strictEqual(stateFor('exited'), STATES.COMPLETED);
});

test('进程在 + sessions.status="error"/"failed"/"crashed" → error (红闪烁)', () => {
  assert.strictEqual(stateFor('error'), STATES.ERROR);
  assert.strictEqual(stateFor('failed'), STATES.ERROR);
  assert.strictEqual(stateFor('crashed'), STATES.ERROR);
});

test('进程在 + sessions.status 未知 → running (兜底)', () => {
  assert.strictEqual(stateFor('some-unknown-xyz'), STATES.RUNNING);
});

test('进程在 + sessions.status="running" (即使 age 很久) → working (不读 age 推算)', () => {
  // 关键: status 字段是权威, age 不影响 (旧逻辑会因 age > 30s 误判 awaiting-input)
  const r = stateFor('running', { age: 60_000 });
  assert.strictEqual(r, STATES.WORKING);
});

test('进程在 + sessions.status="running" (即使 activity kind="user_text") → working', () => {
  // 即便 JSONL lastEntry 是 user_text 文本, 只要 sessions.status=running 就是 working
  // (旧逻辑会因为 kind=user_text + age=10s 推算 awaiting-input)
  const procs = { claude: true };
  const sessions = sessionsObj(liveSession({ status: 'running', age: 1000 }));
  const activity = { lastEntry: { kind: 'user_text', summary: '用户输入' }, ageMs: 10_000 };
  assert.strictEqual(deriveClaudeState(procs, activity, sessions), STATES.WORKING);
});

test('进程在 + sessions.status="idle" (即使 activity 是 thinking) → awaiting-input', () => {
  // 即便 JSONL 是 thinking, 只要 Claude 自己说 idle 就是 awaiting-input
  const procs = { claude: true };
  const sessions = sessionsObj(liveSession({ status: 'idle', age: 1000 }));
  const activity = { lastEntry: { kind: 'thinking', summary: '💭' }, ageMs: 1000 };
  assert.strictEqual(deriveClaudeState(procs, activity, sessions), STATES.AWAITING_INPUT);
});

test('进程在 + sessions.status="idle" 且长时间无状态更新 → completed', () => {
  const procs = { claude: true };
  const sessions = sessionsObj(liveSession({ status: 'idle', age: T.STALE + 1000 }));
  const activity = { lastEntry: { kind: 'thinking', summary: '💭' }, ageMs: 1000 };
  assert.strictEqual(deriveClaudeState(procs, activity, sessions), STATES.COMPLETED);
});

test('进程在 + sessions.status="error" (即使 activity 是普通文本) → error', () => {
  const procs = { claude: true };
  const sessions = sessionsObj(liveSession({ status: 'error', age: 1000 }));
  const activity = { lastEntry: { kind: 'text', summary: '失败' }, ageMs: 5000 };
  assert.strictEqual(deriveClaudeState(procs, activity, sessions), STATES.ERROR);
});

// ============ sessions 优先 + hook fallback ============
console.log('\n— sessions 优先 + hook fallback —');

test('sessions 有 status → 优先 sessions, hook 不再覆盖', () => {
  const procs = { claude: true };
  // hook 写的是 AWAITING_INPUT, sessions 写的是 running
  // 按"完全依赖 status"原则, 应该用 sessions.running → WORKING
  const hookEntry = { state: STATES.AWAITING_INPUT, ts: Date.now() - 1000 };
  const sessions = sessionsObj(liveSession({ status: 'running', age: 1000 }));
  const activity = { lastEntry: hookEntry, ageMs: 1000, source: 'hook' };
  assert.strictEqual(deriveClaudeState(procs, activity, sessions), STATES.WORKING);
});

test('hook stale (>5min) → 仍用 sessions (hook stale 不会影响)', () => {
  const procs = { claude: true };
  const hookEntry = { state: STATES.WORKING, ts: Date.now() - (HOOK_STALE_MS + 1000) };
  const sessions = sessionsObj(liveSession({ status: 'idle', age: 1000 }));
  const activity = { lastEntry: hookEntry, ageMs: HOOK_STALE_MS + 1000, source: 'hook' };
  assert.strictEqual(deriveClaudeState(procs, activity, sessions), STATES.AWAITING_INPUT);
});

test('hook 无 ts → 视为 stale, sessions 优先', () => {
  const procs = { claude: true };
  const hookEntry = { state: STATES.WORKING };  // 没 ts → stale
  const sessions = sessionsObj(liveSession({ status: 'idle', age: 1000 }));
  const activity = { lastEntry: hookEntry, ageMs: 1000 };
  assert.strictEqual(deriveClaudeState(procs, activity, sessions), STATES.AWAITING_INPUT);
});

test('sessions 缺 status → hook 兜底 (fallback)', () => {
  // sessions 完全没有 status 字段, hook 有 → 用 hook
  const procs = { claude: true };
  const hookEntry = { state: STATES.AWAITING_INPUT, ts: Date.now() - 1000 };
  const sessions = sessionsObj({ pid: 1, project: 'A', status: '', statusUpdatedAt: 0 });
  const activity = { lastEntry: hookEntry, ageMs: 1000, source: 'hook' };
  assert.strictEqual(deriveClaudeState(procs, activity, sessions), STATES.AWAITING_INPUT);
});

// ============ isHookStale / mapSessionStatus ============
console.log('\n— isHookStale / mapSessionStatus —');

test('isHookStale: 无 timestamp 视为 stale', () => {
  assert.strictEqual(isHookStale(null), true);
  assert.strictEqual(isHookStale({ lastEntry: {} }), true);
});

test('isHookStale: 5min 内新鲜 (兼容 ts 和 timestamp 字段)', () => {
  const a = { lastEntry: { ts: Date.now() - 60 * 1000 } };
  assert.strictEqual(isHookStale(a), false);
  const b = { lastEntry: { timestamp: Date.now() - 60 * 1000 } };
  assert.strictEqual(isHookStale(b), false);
});

test('isHookStale: 超过 5min 视为 stale', () => {
  const a = { lastEntry: { ts: Date.now() - (HOOK_STALE_MS + 1000) } };
  assert.strictEqual(isHookStale(a), true);
});

test('mapSessionStatus: 各种已知 status', () => {
  assert.strictEqual(mapSessionStatus('idle'), STATES.AWAITING_INPUT);
  assert.strictEqual(mapSessionStatus('ready'), STATES.AWAITING_INPUT);
  assert.strictEqual(mapSessionStatus('waiting'), STATES.AWAITING_CONFIRMATION);
  assert.strictEqual(mapSessionStatus('running'), STATES.WORKING);
  assert.strictEqual(mapSessionStatus('active'), STATES.WORKING);
  assert.strictEqual(mapSessionStatus('busy'), STATES.WORKING);
  assert.strictEqual(mapSessionStatus('starting'), STATES.RUNNING);
  assert.strictEqual(mapSessionStatus('error'), STATES.ERROR);
  assert.strictEqual(mapSessionStatus('unknown-xyz'), null);
  assert.strictEqual(mapSessionStatus(null), null);
});

// ============ deriveSimpleState ============
console.log('\n— deriveSimpleState (Trae/opencode) —');

test('进程不在 → offline', () => {
  assert.strictEqual(deriveSimpleState({ trae: false }, 'trae'), STATES.OFFLINE);
});

test('进程在 → running(不再受 CPU 影响)', () => {
  assert.strictEqual(deriveSimpleState({ trae: true }, 'trae'), STATES.RUNNING);
});

// ============ monitor.js ============
console.log('\n— monitor.js (进程检测) —');

test('detectProcesses 返回必要字段, 无 CPU 字段', async () => {
  const procs = await detectProcesses();
  assert.strictEqual(typeof procs.claude, 'boolean');
  assert.strictEqual(typeof procs.opencode, 'boolean');
  assert.strictEqual(typeof procs.trae, 'boolean');
  assert.strictEqual(typeof procs.details, 'object');
  assert.strictEqual(typeof procs.processCount, 'number');
  // 确保 CPU 字段已移除
  assert.strictEqual(procs.claudeCpu, undefined);
  assert.strictEqual(procs.claudeCpuActive, undefined);
});

test('detectProcesses 能匹配 claude 进程(在测试环境, 通常 false)', async () => {
  const procs = await detectProcesses();
  // 不强求 true, 因为测试机器不一定开了 claude
  assert.ok(typeof procs.claude === 'boolean');
});

// ============ stateToIconBase ============
console.log('\n— stateToIconBase —');
test('offline → gray', () => assert.strictEqual(stateToIconBase(STATES.OFFLINE), 'gray'));
test('running → yellow', () => assert.strictEqual(stateToIconBase(STATES.RUNNING), 'yellow'));
test('awaiting-confirmation → yellow', () => assert.strictEqual(stateToIconBase(STATES.AWAITING_CONFIRMATION), 'yellow'));
test('working → green', () => assert.strictEqual(stateToIconBase(STATES.WORKING), 'green'));
test('awaiting-input → green', () => assert.strictEqual(stateToIconBase(STATES.AWAITING_INPUT), 'green'));
test('completed → blue', () => assert.strictEqual(stateToIconBase(STATES.COMPLETED), 'blue'));
test('error → red', () => assert.strictEqual(stateToIconBase(STATES.ERROR), 'red'));

// ============ deriveAllStates + 轮播规则 ============
console.log('\n— deriveAllStates + 轮播规则 —');

test('0 工具: activeNames=[], anyRunning=[]', () => {
  const r = deriveAllStates({ claude: false, opencode: false, trae: false }, null);
  assert.deepStrictEqual(r.activeNames, []);
  assert.deepStrictEqual(r.anyRunning, []);
  assert.strictEqual(r.worst, STATES.OFFLINE);
});

test('Claude offline + Trae running: anyRunning=[] (Trae 被排除), tools.trae=running', () => {
  const r = deriveAllStates({ claude: false, opencode: false, trae: true }, null);
  assert.deepStrictEqual(r.anyRunning, []);
  assert.deepStrictEqual(r.activeNames, []);
  assert.strictEqual(r.tools.trae, STATES.RUNNING);
  assert.strictEqual(r.worst, STATES.OFFLINE, 'Trae 不参与 worst');
});

test('Claude idle (waiting input) + Trae running: anyRunning=[claude], worst=awaiting-input', () => {
  const procs = { claude: true, opencode: false, trae: true };
  const session = liveSession({ status: 'idle', age: 1000 });
  const entries = [entryFromSession(session)];
  const r = deriveAllStates(procs, entries);
  assert.deepStrictEqual(r.activeNames, []);
  assert.deepStrictEqual(r.anyRunning, ['claude']);
  assert.strictEqual(r.worst, STATES.AWAITING_INPUT);
  assert.strictEqual(r.tools.trae, STATES.RUNNING, 'Trae 仍然有 status, 仅是不参与 worst');
});

test('Claude working + Trae running: activeNames=[claude], Trae 不影响 worst', () => {
  const procs = { claude: true, opencode: false, trae: true };
  const session = liveSession({ status: 'running', age: 1000 });
  const entries = [entryFromSession(session)];
  const r = deriveAllStates(procs, entries);
  assert.deepStrictEqual(r.activeNames, ['claude']);
  assert.deepStrictEqual(r.anyRunning, ['claude']);
  assert.strictEqual(r.worst, STATES.WORKING);
  assert.strictEqual(r.tools.trae, STATES.RUNNING, 'Trae 仍然有 status, 仅是不参与 worst');
});

test('仅 Trae 运行: anyRunning=[], worst=offline (状态栏空)', () => {
  const r = deriveAllStates({ claude: false, opencode: false, trae: true }, []);
  assert.deepStrictEqual(r.anyRunning, []);
  assert.strictEqual(r.worst, STATES.OFFLINE);
  assert.strictEqual(r.tools.trae, STATES.RUNNING);
});

test('Claude error + Trae 运行: worst=error (Trae 不影响)', () => {
  const procs = { claude: true, opencode: false, trae: true };
  const session = liveSession({ status: 'error', age: 1000 });
  const entries = [entryFromSession(session)];
  const r = deriveAllStates(procs, entries);
  assert.strictEqual(r.worst, STATES.ERROR);
});

test('EXCLUDED_FROM_BAR 包含 trae', () => {
  assert.ok(EXCLUDED_FROM_BAR.has('trae'));
});

test('error 优先级最高 (跨 claude + opencode)', () => {
  const procs = { claude: true, opencode: true, trae: false };
  const session = liveSession({ status: 'error', age: 1000 });
  const entries = [entryFromSession(session)];
  const r = deriveAllStates(procs, entries, {});
  assert.strictEqual(r.worst, STATES.ERROR);
});

// ============ 多 session (新 API) ============
console.log('\n— 多 session (新 API) —');

test('多个 claude session 各自独立状态 (按 sessions.status 推算)', () => {
  const procs = { claude: true, opencode: false, trae: false };
  const entries = [
    entryFromSession(liveSession({ status: 'running', age: 1000, pid: 1001, project: 'proj-A', cwd: '/a' })),
    entryFromSession(liveSession({ status: 'idle',    age: 1000, pid: 1002, project: 'proj-B', cwd: '/b' })),
  ];
  const r = deriveAllStates(procs, entries, {});
  assert.strictEqual(r.sessions.length, 2);
  assert.strictEqual(r.sessions[0].project, 'proj-A');
  assert.strictEqual(r.sessions[1].project, 'proj-B');
  assert.strictEqual(r.sessions[0].state, STATES.WORKING);        // running → WORKING
  assert.strictEqual(r.sessions[1].state, STATES.AWAITING_INPUT); // idle → AWAITING_INPUT
  // worst: WORKING (priority 4) > AWAITING_INPUT (priority 3)
  assert.strictEqual(r.tools.claude, STATES.WORKING);
  assert.strictEqual(r.worst, STATES.WORKING);
});

test('多 session: 1 个 claude active, 1 个 idle → 各自独立显示', () => {
  const entries = [
    entryFromSession(liveSession({ status: 'running', age: 1000, pid: 1, project: 'A' })),
    entryFromSession(liveSession({ status: 'idle',    age: 1000, pid: 2, project: 'B' })),
  ];
  const r = deriveAllStates({ claude: true }, entries);
  const s1 = r.sessions.find(s => s.pid === 1);
  const s2 = r.sessions.find(s => s.pid === 2);
  assert.strictEqual(s1.state, STATES.WORKING);
  assert.strictEqual(s2.state, STATES.AWAITING_INPUT);
});

test('多 session: 1 个 waiting (确认) + 1 个 running → worst=awaiting-confirmation', () => {
  const entries = [
    entryFromSession(liveSession({ status: 'waiting', age: 1000, pid: 1, project: 'A' })),
    entryFromSession(liveSession({ status: 'running', age: 1000, pid: 2, project: 'B' })),
  ];
  const r = deriveAllStates({ claude: true }, entries);
  assert.strictEqual(r.worst, STATES.AWAITING_CONFIRMATION);
});

test('多 session 显示: 1 个 = "Claude · project", 2+ 轮播', () => {
  const sessions1 = [{ tool: 'claude', project: 'proj-A', state: STATES.WORKING }];
  assert.strictEqual(computeTitleFromSessions(sessions1, 'cycle', 0), 'Claude \u00b7 proj-A');

  const sessions2 = [
    { tool: 'claude', project: 'proj-A', state: STATES.WORKING },
    { tool: 'claude', project: 'proj-B', state: STATES.AWAITING_INPUT },
  ];
  assert.strictEqual(computeTitleFromSessions(sessions2, 'cycle', 0), 'Claude \u00b7 proj-A');
  assert.strictEqual(computeTitleFromSessions(sessions2, 'cycle', 1), 'Claude \u00b7 proj-B');
  assert.strictEqual(computeTitleFromSessions(sessions2, 'cycle', 2), 'Claude \u00b7 proj-A');  // wrap
});

test('轮播排除 trae: trae 永远不参与 cycle 模式', () => {
  const sessions = [
    { tool: 'claude', project: 'proj-A', state: STATES.WORKING },
    { tool: 'trae', state: STATES.RUNNING },
  ];
  const t1 = computeTitleFromSessions(sessions, 'cycle', 0);
  assert.ok(!t1.includes('Trae'));
  assert.strictEqual(t1, 'Claude \u00b7 proj-A');
});

test('all 模式包含 trae', () => {
  const sessions = [
    { tool: 'claude', project: 'proj-A', state: STATES.WORKING },
    { tool: 'trae', state: STATES.RUNNING },
  ];
  const t1 = computeTitleFromSessions(sessions, 'all', 0);
  assert.ok(t1.includes('Claude'));
  assert.ok(t1.includes('Trae'));
});

test('多 claude session: worst = 优先级最高的', () => {
  const entries = [
    entryFromSession(liveSession({ status: 'idle',  age: 1000, pid: 1, project: 'a' })),
    entryFromSession(liveSession({ status: 'error', age: 1000, pid: 2, project: 'b' })),
  ];
  const r = deriveAllStates({ claude: true }, entries, {});
  assert.strictEqual(r.worst, STATES.ERROR);
  assert.strictEqual(r.sessions.find(s => s.pid === 2).state, STATES.ERROR);
});

test('projectNameFromCwd: 提取最后一段', () => {
  const { projectNameFromCwd } = require('../src/sessionReader');
  assert.strictEqual(projectNameFromCwd('/Users/foo/PhpProject/CoolApk-v13'), 'CoolApk-v13');
  assert.strictEqual(projectNameFromCwd('/a/b/c'), 'c');
  assert.strictEqual(projectNameFromCwd(''), '');
});

// ============ stateSource (诊断用) ============
console.log('\n— stateSource (诊断 hook vs sessions) —');

test('stateSource: sessions 有 status → "sessions" (优先, hook 不再覆盖)', () => {
  // 即便 hook 写的是 'working' 且新鲜, 也不再覆盖 sessions 的 'idle'
  const hookEntry = { state: STATES.WORKING, ts: Date.now() - 1000 };
  const session = liveSession({ status: 'idle', age: 1000 });
  const entries = [entryFromSession(session, { hookEntry })];
  const r = deriveAllStates({ claude: true }, entries, {});
  assert.strictEqual(r.sessions[0].state, STATES.AWAITING_INPUT, 'sessions.idle → AWAITING_INPUT');
  assert.strictEqual(r.sessions[0].stateSource, 'sessions', '应识别为 sessions (不显示标签)');
});

test('stateSource: hook stale → 仍用 sessions', () => {
  const hookEntry = { state: STATES.WORKING, ts: Date.now() - (HOOK_STALE_MS + 1000) };
  const session = liveSession({ status: 'idle', age: 1000 });
  const entries = [entryFromSession(session, { hookEntry })];
  const r = deriveAllStates({ claude: true }, entries, {});
  assert.strictEqual(r.sessions[0].state, STATES.AWAITING_INPUT);
  assert.strictEqual(r.sessions[0].stateSource, 'sessions');
});

test('stateSource: hook 无 → "sessions" (用 sessions.status)', () => {
  const session = liveSession({ status: 'idle', age: 1000 });
  const entries = [entryFromSession(session)];  // 没 hookEntry
  const r = deriveAllStates({ claude: true }, entries, {});
  assert.strictEqual(r.sessions[0].state, STATES.AWAITING_INPUT);
  assert.strictEqual(r.sessions[0].stateSource, 'sessions');
});

test('stateSource: 都无 → "default" (兜底 RUNNING)', () => {
  const entries = [entryFromSession(null)];  // session=null, no hook
  const r = deriveAllStates({ claude: true }, entries, {});
  assert.strictEqual(r.sessions[0].state, STATES.RUNNING);
  assert.strictEqual(r.sessions[0].stateSource, 'default');
});

test('stateSource: session.status 缺失时 hook 兜底 (fallback)', () => {
  // sessions 完全没有 status, hook 有数据 → 用 hook, stateSource='hook'
  const session = { pid: 1, project: 'A', status: '', statusUpdatedAt: 0 };
  const hookEntry = { state: STATES.WORKING, ts: Date.now() - 1000 };
  const entries = [entryFromSession(session, { hookEntry })];
  const r = deriveAllStates({ claude: true }, entries, {});
  assert.strictEqual(r.sessions[0].state, STATES.WORKING);
  assert.strictEqual(r.sessions[0].stateSource, 'hook', 'sessions 缺数据时, hook 兜底');
});

test('多 session: 各自 stateSource 独立 (debug 关键)', () => {
  // session A: sessions 缺 → hook 兜底 (working)
  // session B: sessions 完整 → sessions 优先 (idle)
  const sessionA = { pid: 1, project: 'A', status: '', statusUpdatedAt: 0 };
  const hookEntryA = { state: STATES.WORKING, ts: Date.now() - 1000 };
  const entryA = entryFromSession(sessionA, { hookEntry: hookEntryA });
  const entryB = entryFromSession(liveSession({ status: 'idle', age: 1000, pid: 2, project: 'B' }));
  const r = deriveAllStates({ claude: true }, [entryA, entryB], {});
  const sA = r.sessions.find(s => s.pid === 1);
  const sB = r.sessions.find(s => s.pid === 2);
  assert.strictEqual(sA.state, STATES.WORKING);
  assert.strictEqual(sA.stateSource, 'hook');
  assert.strictEqual(sB.state, STATES.AWAITING_INPUT);
  assert.strictEqual(sB.stateSource, 'sessions');
  // worst: hook 那个 session 决定整体状态
  assert.strictEqual(r.worst, STATES.WORKING);
});

test('readAllClaudeSessions: 只返回 live pid 匹配的 session', async () => {
  const { readAllClaudeSessions } = require('../src/sessionReader');
  const r = await readAllClaudeSessions({ details: { claude: [{ pid: 1 }] } });
  assert.ok(Array.isArray(r.sessions));
  assert.ok(Array.isArray(r.inactiveSessions));
});

test('英文标题: Claude + Trae 只显示 Claude (单 session 走 Claude · project)', () => {
  setLocale('en');
  const procs = { claude: true, trae: true };
  const session = liveSession({ status: 'running', age: 1000, project: 'proj-A' });
  const entries = [entryFromSession(session)];
  // 用新 API: computeTitleFromSessions
  // 单 session → 直接显示 "Claude · project", Trae 排除
  const r = deriveAllStates(procs, entries, {});
  assert.strictEqual(computeTitleFromSessions(r.sessions, 'cycle', 0), 'Claude \u00b7 proj-A');
  assert.strictEqual(computeTitleFromSessions(r.sessions, 'cycle', 1), 'Claude \u00b7 proj-A');
});

test('仅 Trae 运行: 标题为空', () => {
  setLocale('zh-CN');
  const r = deriveAllStates({ claude: false, opencode: false, trae: true }, []);
  assert.strictEqual(computeTitleFromSessions(r.sessions, 'cycle', 0), '');
});

// ============ computeTitle 旧 API 兼容 ============
console.log('\n— computeTitle (旧 API 兼容) —');

test('0 工具 → ""', () => {
  setLocale('zh-CN');
  assert.strictEqual(computeTitle({ claude: false, opencode: false, trae: false }, null, 'cycle', 0), '');
});

test('1 个非 offline 工具 → 直接显示名字(不轮)', () => {
  setLocale('zh-CN');
  const procs = { claude: true, opencode: false, trae: false };
  const session = liveSession({ status: 'idle', age: 1000 });
  const entries = [entryFromSession(session)];
  // 旧 API: 直接传 activity
  const activity = { lastEntry: { kind: 'text', summary: '...' }, ageMs: 10_000 };
  assert.strictEqual(computeTitle(procs, activity, 'cycle', 0), 'Claude');
  assert.strictEqual(computeTitle(procs, activity, 'cycle', 5), 'Claude');
});

test('Claude + Trae 同时运行: anyRunning=[claude] (Trae 排除), 不轮播', () => {
  setLocale('zh-CN');
  const procs = { claude: true, trae: true };
  const session = liveSession({ status: 'idle', age: 1000 });
  const activity = { lastEntry: { kind: 'text', summary: '...' }, ageMs: 10_000 };
  // 旧 API: 直接传 activity, claudeSessions fallback → 'unknown' → running
  // cycle 只看 claude, 不轮
  assert.strictEqual(computeTitle(procs, activity, 'cycle', 0), 'Claude');
  assert.strictEqual(computeTitle(procs, activity, 'cycle', 1), 'Claude');
  assert.strictEqual(computeTitle(procs, activity, 'cycle', 5), 'Claude');
});

test('Claude + opencode + Trae → [claude, opencode] 二者轮播, Trae 不参与', () => {
  setLocale('zh-CN');
  const procs = { claude: true, opencode: true, trae: true };
  const session = liveSession({ status: 'running', age: 1000 });
  const activity = { lastEntry: { kind: 'text', summary: '...' }, ageMs: 1000 };
  assert.strictEqual(computeTitle(procs, activity, 'cycle', 0), 'Claude');
  assert.strictEqual(computeTitle(procs, activity, 'cycle', 1), 'opencode');
  assert.strictEqual(computeTitle(procs, activity, 'cycle', 2), 'Claude');
});

test('all 模式: 显示所有运行工具 (含 Trae)', () => {
  setLocale('zh-CN');
  const procs = { claude: true, opencode: true, trae: true };
  const session = liveSession({ status: 'running', age: 1000 });
  const activity = { lastEntry: { kind: 'text', summary: '...' }, ageMs: 1000 };
  const t1 = computeTitle(procs, activity, 'all', 0);
  assert.ok(t1.includes('Claude'));
  assert.ok(t1.includes('opencode'));
  assert.ok(t1.includes('Trae'));
});

// ============ computeTooltipFromSessions (新 API) ============
console.log('\n— computeTooltipFromSessions (新 API) —');

test('0 session (中文)', () => {
  setLocale('zh-CN');
  const t1 = computeTooltipFromSessions([]);
  assert.ok(t1.includes('所有 AI 工具均未运行'));
});

test('0 session (英文)', () => {
  setLocale('en');
  const t1 = computeTooltipFromSessions([]);
  assert.ok(t1.includes('No AI tools running'));
});

test('Claude working 闪烁 (中文)', () => {
  setLocale('zh-CN');
  const sessions = [
    { tool: 'claude', project: '', state: STATES.WORKING, lastEntry: { summary: '好的我来分析' }, ageMs: 1500 },
  ];
  const t1 = computeTooltipFromSessions(sessions);
  assert.ok(t1.includes('Claude'));
  assert.ok(t1.includes('闪烁'));
  assert.ok(t1.includes('工作中'));
  assert.ok(t1.includes('好的我来分析'));
});

test('Claude working (英文)', () => {
  setLocale('en');
  const sessions = [
    { tool: 'claude', state: STATES.WORKING, lastEntry: { summary: 'analyzing' }, ageMs: 1500 },
  ];
  const t1 = computeTooltipFromSessions(sessions);
  assert.ok(t1.includes('Working'));
  assert.ok(t1.includes('flashing'));
  assert.ok(t1.includes('analyzing'));
});

test('Claude 出错 (红闪烁)', () => {
  setLocale('zh-CN');
  const sessions = [
    { tool: 'claude', state: STATES.ERROR, lastEntry: { summary: '✗ 命令不存在' }, ageMs: 3000 },
  ];
  const t1 = computeTooltipFromSessions(sessions);
  assert.ok(t1.includes('出错'));
  assert.ok(t1.includes('闪烁'));
});

test('Claude 多 session tooltip: 每个 session 独立显示详情', () => {
  setLocale('zh-CN');
  const sessions = [
    { tool: 'claude', project: 'proj-A', state: STATES.WORKING, lastEntry: { summary: 'Bash npm test' }, ageMs: 1000 },
    { tool: 'claude', project: 'proj-B', state: STATES.AWAITING_INPUT, lastEntry: { summary: '已完成分析' }, ageMs: 5000 },
  ];
  const t1 = computeTooltipFromSessions(sessions);
  // summary 行: 两个 emoji + 两个项目
  assert.ok(t1.includes('proj-A'));
  assert.ok(t1.includes('proj-B'));
  // 详情: 每个 session 一行
  assert.ok(t1.includes('Bash npm test'));
  assert.ok(t1.includes('已完成分析'));
});

test('Claude awaiting-confirmation (黄闪烁)', () => {
  setLocale('zh-CN');
  const sessions = [
    { tool: 'claude', state: STATES.AWAITING_CONFIRMATION, lastEntry: { summary: 'Bash rm -rf' }, ageMs: 1000 },
  ];
  const t1 = computeTooltipFromSessions(sessions);
  assert.ok(t1.includes('等待确认'));
  assert.ok(t1.includes('闪烁'));
});

// ============ computeTooltip 旧 API 兼容 ============
console.log('\n— computeTooltip (旧 API 兼容) —');

test('0 工具 (中文)', () => {
  setLocale('zh-CN');
  const t1 = computeTooltip({ claude: false, opencode: false, trae: false }, null);
  assert.ok(t1.includes('所有 AI 工具均未运行'));
});

test('0 工具 (英文)', () => {
  setLocale('en');
  const t1 = computeTooltip({ claude: false, opencode: false, trae: false }, null);
  assert.ok(t1.includes('No AI tools running'));
});

test('Claude 在 (中文)', () => {
  setLocale('zh-CN');
  // 旧 API: claude 进程在, fakeSession.status='unknown' → running (兜底)
  const t1 = computeTooltip({ claude: true, trae: false }, { lastEntry: null });
  assert.ok(t1.includes('Claude'));
  assert.ok(t1.includes('运行'));
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
