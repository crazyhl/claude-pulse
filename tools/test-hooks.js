// 测试 hookInstaller + statusReader
// 使用临时 HOME 目录, 不污染用户的真实 ~/.claude / ~/.config
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// 用临时目录替代 $HOME
const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'cst-test-'));
process.env.HOME = tmpHome;
process.env.USERPROFILE = tmpHome; // Windows fallback

// mock electron (hookInstaller 用 app.getPath('home'))
require.cache[require.resolve('electron')] = {
  exports: { app: { getPath: () => tmpHome } },
};

const hookInstaller = require('../src/hookInstaller');
const { readHookStatusSync, adaptEntry } = require('../src/statusReader');
const { STATES, deriveAllStates } = require('../src/state');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.log(`  ✗ ${name}\n    ${e.message}\n${e.stack}`); failed++; }
}

console.log(`(using tmp HOME = ${tmpHome})\n`);

// ============ statusReader ============
console.log('— statusReader —');

test('readHookStatusSync: 不存在的文件返回空', () => {
  const r = readHookStatusSync(path.join(tmpHome, 'nonexistent.json'));
  assert.strictEqual(r.exists, false);
  assert.strictEqual(r.claude, null);
});

test('adaptEntry: working → STATES.WORKING', () => {
  const a = adaptEntry({
    state: 'working', event: 'PreToolUse', tool: 'Bash',
    summary: 'npm test', ts: Date.now(),
  });
  assert.ok(a);
  assert.strictEqual(a.lastEntry.state, STATES.WORKING);
  assert.strictEqual(a.lastEntry.kind, 'tool_use');
  assert.strictEqual(a.lastEntry.toolName, 'Bash');
});

test('adaptEntry: error → STATES.ERROR', () => {
  const a = adaptEntry({
    state: 'error', event: 'PostToolUseFailure', tool: 'Bash', ts: Date.now(),
  });
  assert.strictEqual(a.lastEntry.state, STATES.ERROR);
  assert.strictEqual(a.lastEntry.isError, true);
});

test('adaptEntry: awaiting-confirmation → STATES.AWAITING_CONFIRMATION', () => {
  const a = adaptEntry({
    state: 'awaiting-confirmation', event: 'Notification', ts: Date.now(),
  });
  assert.strictEqual(a.lastEntry.state, STATES.AWAITING_CONFIRMATION);
  assert.strictEqual(a.lastEntry.requiresConfirmation, true);
});

test('adaptEntry: 未知 state → null', () => {
  const a = adaptEntry({ state: 'foo', ts: Date.now() });
  assert.strictEqual(a, null);
});

test('readHookStatusSync: 正常读取', () => {
  const file = path.join(tmpHome, 'status.json');
  fs.writeFileSync(file, JSON.stringify({
    claude: { state: 'working', event: 'PreToolUse', tool: 'Bash', summary: 'npm test', ts: Date.now() },
    opencode: { state: 'awaiting-input', event: 'session.idle', ts: Date.now() },
    trae: null,
  }));
  const r = readHookStatusSync(file);
  assert.strictEqual(r.exists, true);
  assert.ok(r.claude);
  assert.strictEqual(r.claude.lastEntry.state, STATES.WORKING);
  assert.strictEqual(r.claude.source, 'claude-hook');
  assert.ok(r.opencode);
  assert.strictEqual(r.opencode.lastEntry.state, STATES.AWAITING_INPUT);
  assert.strictEqual(r.trae, null);
});

// ============ hookInstaller ============
console.log('\n— hookInstaller (Claude) —');

test('checkClaudeHooks: settings 不存在 → installed=false', () => {
  const r = hookInstaller.checkClaudeHooks();
  assert.strictEqual(r.installed, false);
  assert.strictEqual(r.settingsExists, false);
});

test('installClaudeHooks: 全新安装', () => {
  const r = hookInstaller.installClaudeHooks();
  assert.strictEqual(r.ok, true);
  const chk = hookInstaller.checkClaudeHooks();
  assert.strictEqual(chk.installed, true);
  assert.strictEqual(chk.settingsExists, true);
});

test('installClaudeHooks: 重复安装幂等', () => {
  // 第二次调用应该不重复添加
  const before = JSON.parse(fs.readFileSync(path.join(tmpHome, '.claude/settings.json'), 'utf-8'));
  hookInstaller.installClaudeHooks();
  const after = JSON.parse(fs.readFileSync(path.join(tmpHome, '.claude/settings.json'), 'utf-8'));
  // hooks 段应该没多
  assert.strictEqual(
    JSON.stringify(before.hooks),
    JSON.stringify(after.hooks),
    'hooks 配置应该保持不变'
  );
});

test('installClaudeHooks: 合并已有配置(保留用户 hooks)', () => {
  // 模拟已有用户的 hook
  const userHookPath = path.join(tmpHome, '.claude/settings.json');
  const userSettings = {
    model: 'claude-3-5-sonnet',
    hooks: {
      Stop: [
        {
          matcher: '',
          hooks: [{ type: 'command', command: 'bash /Users/foo/stop-script.sh' }],
        },
      ],
    },
  };
  fs.writeFileSync(userHookPath, JSON.stringify(userSettings, null, 2));

  // 卸载 CST 后重新装
  hookInstaller.uninstallClaudeHooks();
  hookInstaller.installClaudeHooks();

  const after = JSON.parse(fs.readFileSync(userHookPath, 'utf-8'));
  assert.strictEqual(after.model, 'claude-3-5-sonnet', '用户其他配置保留');
  assert.ok(Array.isArray(after.hooks.Stop), 'Stop 段保留');
  // Stop 段应该同时有用户的 hook 和 CST 的 hook
  const stopHooks = after.hooks.Stop.flatMap(g => g.hooks || []);
  assert.ok(stopHooks.some(h => h.command.includes('stop-script.sh')), '用户 hook 保留');
  assert.ok(stopHooks.some(h => h.command.includes('claude_status_tips')), 'CST hook 注入');
});

test('uninstallClaudeHooks: 只移除 CST, 保留用户其他 hook', () => {
  hookInstaller.uninstallClaudeHooks();
  const after = JSON.parse(fs.readFileSync(path.join(tmpHome, '.claude/settings.json'), 'utf-8'));
  assert.ok(Array.isArray(after.hooks.Stop), 'Stop 段还在');
  const stopHooks = after.hooks.Stop.flatMap(g => g.hooks || []);
  assert.ok(stopHooks.some(h => h.command.includes('stop-script.sh')), '用户 hook 保留');
  assert.ok(!stopHooks.some(h => h.command.includes('claude_status_tips')), 'CST hook 移除');
});

test('checkClaudeHooks: 备份文件被清理', () => {
  const bak = path.join(tmpHome, '.claude/settings.json.cst.bak');
  assert.ok(!fs.existsSync(bak), '卸载后应删除备份');
});

test('uninstallClaudeHooks: 同时清理 status.json 残留 (Claude 进程不重启前 hook 仍可能继续写)', () => {
  // 重新安装, 然后写一个 status.json, 模拟 hook 仍在跑
  hookInstaller.installClaudeHooks();
  const statusFile = path.join(tmpHome, '.cache/claude_status_tips/status.json');
  fs.mkdirSync(path.dirname(statusFile), { recursive: true });
  fs.writeFileSync(statusFile, JSON.stringify({
    claude: { state: 'working', event: 'PreToolUse', ts: Date.now() },
  }));
  assert.ok(fs.existsSync(statusFile), 'status.json 已写入');
  // 卸载应同时删除 status.json
  const r = hookInstaller.uninstallClaudeHooks();
  assert.strictEqual(r.ok, true);
  assert.ok(!fs.existsSync(statusFile), '卸载应删除 status.json');
});

test('uninstallClaudeHooks: 报告移除数量', () => {
  hookInstaller.installClaudeHooks();
  // 9 个事件 = 9 个 hook 命令被添加
  const r = hookInstaller.uninstallClaudeHooks();
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.removed, true);
  assert.ok(r.removedCount >= 9, '移除数量应 >= 9');
});

// 回归测试: 防止 main.js 把 checkAll().installed (undefined) 误用
test('checkAll 返回值结构: 顶层没有 installed, 需要 .claude.installed', () => {
  const all = hookInstaller.checkAll();
  // checkAll 是 {claude: {...}, opencode: {...}, trae: {...}}, 顶层没有 installed
  assert.strictEqual(all.installed, undefined, 'checkAll 顶层没有 installed, 这是 main.js 的旧 bug 触发点');
  assert.strictEqual(typeof all.claude, 'object');
  assert.strictEqual(typeof all.claude.installed, 'boolean');
  assert.strictEqual(typeof all.opencode, 'object');
  assert.strictEqual(typeof all.opencode.installed, 'boolean');
});

console.log('\n— hookInstaller (opencode) —');

test('checkOpencodePlugin: 未安装 → false', () => {
  const r = hookInstaller.checkOpencodePlugin();
  assert.strictEqual(r.installed, false);
});

test('installOpencodePlugin: 复制到 ~/.config/opencode/plugins/', () => {
  const r = hookInstaller.installOpencodePlugin();
  assert.strictEqual(r.ok, true);
  assert.ok(fs.existsSync(r.path));
  const chk = hookInstaller.checkOpencodePlugin();
  assert.strictEqual(chk.installed, true);
});

test('uninstallOpencodePlugin: 删除文件', () => {
  const r = hookInstaller.uninstallOpencodePlugin();
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.removed, true);
  assert.strictEqual(hookInstaller.checkOpencodePlugin().installed, false);
});

console.log('\n— end-to-end (hook status → state) —');

test('hook status + 进程在 → state 正确映射 (走 hook 优先路径)', () => {
  const file = path.join(tmpHome, '.cache/claude_status_tips/status.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({
    claude: { state: 'working', event: 'PreToolUse', tool: 'Bash', summary: 'npm test', ts: Date.now() },
    opencode: null, trae: null,
  }));

  const procs = { claude: true, opencode: false, trae: false };
  const hooks = readHookStatusSync(file);
  // 走新 API: hook 直接挂到 entry.hookEntry (claude 状态 100% 依赖 hook, 不需要 sessions/activity)
  const entries = [{ session: null, activity: null, hookEntry: hooks.claude.lastEntry }];
  const r = deriveAllStates(procs, entries, hooks);
  assert.strictEqual(r.tools.claude, STATES.WORKING);
  assert.strictEqual(r.worst, STATES.WORKING);
});

test('hook status idle (SessionEnd) → awaiting-input (Claude 进程还在, 等输入)', () => {
  const file = path.join(tmpHome, '.cache/claude_status_tips/status.json');
  fs.writeFileSync(file, JSON.stringify({
    claude: { state: 'idle', event: 'SessionEnd', ts: Date.now() },
    opencode: null, trae: null,
  }));
  const procs = { claude: true, opencode: false, trae: false };
  const hooks = readHookStatusSync(file);
  // 走新 API: hook 直接挂到 entry.hookEntry
  const entries = [{ session: null, activity: null, hookEntry: hooks.claude.lastEntry }];
  const r = deriveAllStates(procs, entries, hooks);
  // idle + 进程在 → AWAITING_INPUT (绿常亮), 不是 OFFLINE
  assert.strictEqual(r.tools.claude, STATES.AWAITING_INPUT);
});

// 清理
fs.rmSync(tmpHome, { recursive: true, force: true });

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
