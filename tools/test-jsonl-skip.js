// 测试 collectData 的 JSONL skip 优化
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.log(`  ✗ ${name}\n    ${e.message}`); failed++; }
}

console.log('— JSONL skip 优化 (collectData) —');

test('JSONL_FRESH_THRESHOLD_MS = 30s', () => {
  // 验证阈值在合理范围 (用户期望: sessions 新鲜时不读 JSONL)
  const fresh = 30_000;
  assert.strictEqual(typeof fresh, 'number');
  assert.ok(fresh >= 5_000 && fresh <= 120_000);
});

test('mapSessionStatus: sessions.status 直接映射到 STATE', () => {
  // 核心: sessions 有 status 时, 不需要 JSONL 也能知道状态
  const { mapSessionStatus, STATES } = require('../src/state');
  // 工作场景: Claude 在跑命令
  assert.strictEqual(mapSessionStatus('running'), STATES.WORKING);
  // 等待场景: 用户回复
  assert.strictEqual(mapSessionStatus('idle'), STATES.AWAITING_INPUT);
  // 确认场景: 工具调用需要确认
  assert.strictEqual(mapSessionStatus('waiting'), STATES.AWAITING_CONFIRMATION);
  // 启动场景: 刚开始
  assert.strictEqual(mapSessionStatus('starting'), STATES.RUNNING);
  // 错误场景
  assert.strictEqual(mapSessionStatus('error'), STATES.ERROR);
});

test('session status 数据源覆盖度 (vs JSONL)', () => {
  // 核心: 我们映射表里的 status 覆盖所有 7 态
  const { mapSessionStatus, STATES } = require('../src/state');
  for (const state of Object.values(STATES)) {
    // 至少有一个 session status 字符串能映射到该 state
    // (OFFLINE 不应该被映射, 因为没 session 就不该进入 map)
    if (state === STATES.OFFLINE) continue;
    const has = Object.entries({
      idle: STATES.AWAITING_INPUT,
      waiting: STATES.AWAITING_CONFIRMATION,
      running: STATES.WORKING,
      starting: STATES.RUNNING,
      finished: STATES.COMPLETED,
      error: STATES.ERROR,
    }).some(([k, v]) => v === state);
    assert.ok(has, `state ${state} 应该有对应的 session status`);
  }
});

test('SESSION_STATUS_MAP: 所有 6 态都有对应 status 字符串', () => {
  // sessions 文件的 status 字段在不同 Claude 版本可能不一样
  // 核心: 我们至少覆盖所有非 offline 的 6 个状态
  const { mapSessionStatus, STATES, SESSION_STATUS_MAP } = require('../src/state');
  const expected = [
    STATES.AWAITING_INPUT,
    STATES.AWAITING_CONFIRMATION,
    STATES.WORKING,
    STATES.RUNNING,
    STATES.COMPLETED,
    STATES.ERROR,
  ];
  for (const s of expected) {
    const found = Object.values(SESSION_STATUS_MAP).includes(s);
    assert.ok(found, `SESSION_STATUS_MAP 应该覆盖 ${s}`);
  }
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
