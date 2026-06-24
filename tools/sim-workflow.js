// 端到端模拟: 构造一个伪造的 Claude session JSONL, 模拟完整工作流
// 验证状态机会输出正确的状态序列
const fs = require('fs');
const path = require('path');
const os = require('os');
const { deriveClaudeState, STATES, STATE_DESC_EN } = require('../src/state');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-sim-'));
const projectDir = path.join(tmpDir, '.claude', 'projects', 'fake-project');
fs.mkdirSync(projectDir, { recursive: true });
const sessionFile = path.join(projectDir, 'sim.jsonl');

// 模拟场景: 用户提交消息 → Claude 思考 → 发出 tool_use(Bash) → 等待确认 → 工具执行 → Claude 总结
const events = [
  { type: 'user', message: { content: [{ type: 'text', text: '看看 src 目录' }] } },
  // Claude 思考 1.5s, 然后发出 tool_use
  { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'ls -la src/' } }] } },
  // 用户 5s 后批准(模拟), 工具执行
  { type: 'user', message: { content: [{ type: 'tool_result', content: 'total 24\ndrwxr-xr-x 5 user user 4096 Jun 18 14:00 .', is_error: false }] } },
  // Claude 接着总结
  { type: 'assistant', message: { content: [{ type: 'text', text: 'src 目录有 5 个文件...' }] } },
  // 30s 后没新动静
  // 5min 后(turn 结束)
  { type: 'system', subtype: 'turn_duration' },
];

// 写入文件
fs.writeFileSync(sessionFile, events.map(e => JSON.stringify(e)).join('\n') + '\n');

// 拿到 mtime,然后做时间旅行
const baseTime = Date.now();
const modTimes = [0, 1500, 6000, 7500, 60000, 600000].map(ms => baseTime - 600000 + ms);

// 强制设置文件 mtime
for (let i = 0; i < modTimes.length; i++) {
  // 每个事件写入后立即更新 mtime
  // 因为我们一次性写完, 这里手动覆盖 mtime
}

console.log('--- 模拟时间序列状态机输出 ---\n');

const scenarios = [
  { label: 'T+0s: 用户提交消息', ageMs: 0, lastEventIdx: 0 },
  { label: 'T+1.5s: Claude 思考后发出 tool_use(Bash)', ageMs: 1500, lastEventIdx: 1 },
  { label: 'T+5s: 等待用户确认 tool_use (5s 没响应)', ageMs: 5000, lastEventIdx: 1 },
  { label: 'T+10s: 等待用户确认 tool_use (10s)', ageMs: 10000, lastEventIdx: 1 },
  { label: 'T+15s: 工具执行完毕, 收到 tool_result', ageMs: 0, lastEventIdx: 2 },
  { label: 'T+17s: Claude 在写总结文本', ageMs: 2000, lastEventIdx: 3 },
  { label: 'T+45s: 总结完 30s, 等待用户', ageMs: 30000, lastEventIdx: 3 },
  { label: 'T+2min: 等待 90s, 进程还在', ageMs: 90000, lastEventIdx: 3 },
  { label: 'T+5min30s: turn 结束 30s', ageMs: 30000, lastEventIdx: 4 },
  { label: 'T+10min: turn 结束 5min, 进程在', ageMs: 300000, lastEventIdx: 4 },
];

for (const s of scenarios) {
  const lastEvent = events[s.lastEventIdx];
  const entry = {
    kind: lastEvent.type === 'user'
      ? (lastEvent.message.content[0].type === 'text' ? 'user_text' : 'tool_result')
      : lastEvent.type === 'assistant'
        ? (lastEvent.message.content[0].type === 'tool_use' ? 'tool_use' : 'text')
        : 'system',
    toolName: lastEvent.message && lastEvent.message.content[0].name,
    requiresConfirmation: lastEvent.message && lastEvent.message.content[0].name === 'Bash',
    isError: lastEvent.message && lastEvent.message.content[0].is_error,
    summary: 'sim',
  };
  if (entry.kind === 'tool_result' && lastEvent.message.content[0].is_error === false) {
    entry.isError = false;
  }
  const state = deriveClaudeState({ claude: true }, { lastEntry: entry, ageMs: s.ageMs });
  console.log(`  ${s.label.padEnd(50)} → ${state} (${STATE_DESC_EN[state]})`);
}

console.log('\n[done] 临时目录:', tmpDir);
