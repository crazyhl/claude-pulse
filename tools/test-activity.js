// 测试 claudeActivity.js 的 JSONL 行解析 (parseLastEntry)
const assert = require('assert');
const { parseLastEntry } = require('../src/claudeActivity');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.log(`  ✗ ${name}\n    ${e.message}`); failed++; }
}

console.log('— parseLastEntry (JSONL 行解析) —');

test('assistant + tool_use: Bash 命令提取', () => {
  const r = parseLastEntry(JSON.stringify({
    type: 'assistant',
    message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'npm test' } }] },
  }));
  assert.strictEqual(r.kind, 'tool_use');
  assert.strictEqual(r.toolName, 'Bash');
  assert.strictEqual(r.summary, 'Bash npm test');
  assert.strictEqual(r.requiresConfirmation, true);
});

test('assistant + tool_use: Write 文件路径', () => {
  const r = parseLastEntry(JSON.stringify({
    type: 'assistant',
    message: { content: [{ type: 'tool_use', name: 'Write', input: { file_path: '/Users/foo/bar.md' } }] },
  }));
  assert.strictEqual(r.kind, 'tool_use');
  assert.strictEqual(r.summary.includes('Write'), true);
  assert.strictEqual(r.summary.includes('bar.md'), true);
});

test('assistant + text: 提取文本', () => {
  const r = parseLastEntry(JSON.stringify({
    type: 'assistant',
    message: { content: [{ type: 'text', text: '好的我来分析' }] },
  }));
  assert.strictEqual(r.kind, 'text');
  assert.strictEqual(r.summary, '好的我来分析');
});

test('assistant + thinking (Extended Thinking) → thinking', () => {
  const r = parseLastEntry(JSON.stringify({
    type: 'assistant',
    message: { content: [{ type: 'thinking', thinking: '现在目录已创建, 我可以写入文档了。' }] },
  }));
  assert.strictEqual(r.kind, 'thinking');
  assert.strictEqual(r.summary.startsWith('💭'), true);
  assert.strictEqual(r.summary.includes('目录已创建'), true);
});

test('assistant + tool_use + thinking: tool_use 优先', () => {
  // 实测中, Claude 在 thinking 之后才决定 tool_use, 最后一条是 tool_use
  const r = parseLastEntry(JSON.stringify({
    type: 'assistant',
    message: { content: [
      { type: 'thinking', thinking: '让我想想' },
      { type: 'tool_use', name: 'Write', input: { file_path: '/tmp/x.md' } },
    ] },
  }));
  assert.strictEqual(r.kind, 'tool_use', 'tool_use 应优先于 thinking');
});

test('assistant + thinking + text: text 优先', () => {
  // 实测: Extended Thinking 模式下, assistant content 里同时有 thinking 和 text
  const r = parseLastEntry(JSON.stringify({
    type: 'assistant',
    message: { content: [
      { type: 'thinking', thinking: '...' },
      { type: 'text', text: '以下是结果' },
    ] },
  }));
  assert.strictEqual(r.kind, 'text', 'text 应优先于 thinking');
});

test('user + tool_result: 提取内容', () => {
  const r = parseLastEntry(JSON.stringify({
    type: 'user',
    message: { content: [{ type: 'tool_result', content: 'all good', is_error: false }] },
  }));
  assert.strictEqual(r.kind, 'tool_result');
  assert.strictEqual(r.isError, false);
  assert.strictEqual(r.summary.includes('all good'), true);
});

test('user + tool_result: 错误', () => {
  const r = parseLastEntry(JSON.stringify({
    type: 'user',
    message: { content: [{ type: 'tool_result', content: 'fail', is_error: true }] },
  }));
  assert.strictEqual(r.kind, 'tool_result');
  assert.strictEqual(r.isError, true);
});

test('system + away_summary: 摘要', () => {
  const r = parseLastEntry(JSON.stringify({
    type: 'system',
    subtype: 'away_summary',
    content: '你让我整理了...',
  }));
  assert.strictEqual(r.kind, 'system');
  assert.strictEqual(r.subtype, 'away_summary');
});

test('attachment: 历史 hook payload', () => {
  const r = parseLastEntry(JSON.stringify({
    type: 'attachment',
    attachment: { hookName: 'PreToolUse:Write' },
  }));
  assert.strictEqual(r.kind, 'attachment');
});

test('空行 / 非法 JSON: null', () => {
  assert.strictEqual(parseLastEntry(''), null);
  assert.strictEqual(parseLastEntry(null), null);
  assert.strictEqual(parseLastEntry('not json'), null);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
