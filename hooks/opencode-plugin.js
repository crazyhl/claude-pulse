#!/usr/bin/env node
// opencode plugin: 监听 tool.execute.before / after / event,
// 把状态写入 ~/.cache/claude_status_tips/status.json
// 放在 ~/.config/opencode/plugins/cst-status.js (全局)
// 或 .opencode/plugins/cst-status.js (项目)

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const CACHE_DIR = process.env.CST_CACHE_DIR || path.join(os.homedir(), '.cache', 'claude_status_tips');
const STATUS_FILE = path.join(CACHE_DIR, 'status.json');

function readStatus() {
  try {
    if (fs.existsSync(STATUS_FILE)) {
      const data = JSON.parse(fs.readFileSync(STATUS_FILE, 'utf-8'));
      if (data && typeof data === 'object') return data;
    }
  } catch {}
  return { version: 1, claude: null, opencode: null, trae: null };
}

function writeStatus(patch) {
  try {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    const cur = readStatus();
    const next = { ...cur, ...patch, version: 1 };
    fs.writeFileSync(STATUS_FILE, JSON.stringify(next, null, 2));
  } catch (e) {
    console.error('[cst-status] write failed:', e.message);
  }
}

const SUMMARY_MAX = 120;
function summarize(tool, args) {
  if (!args || typeof args !== 'object') return tool || '';
  const candidates = ['command', 'filePath', 'pattern', 'url', 'prompt', 'description', 'query'];
  for (const k of candidates) {
    const v = args[k];
    if (typeof v === 'string' && v.length > 0) {
      return String(v).replace(/\n/g, ' ').slice(0, SUMMARY_MAX);
    }
  }
  return tool || '';
}

const CstStatusPlugin = async ({ client }) => {
  return {
    'tool.execute.before': async (input, output) => {
      const tool = input.tool || '';
      const args = output && output.args ? output.args : {};
      writeStatus({
        opencode: {
          state: 'working',
          event: 'tool.execute.before',
          tool,
          summary: summarize(tool, args),
          ts: Date.now(),
        },
      });
    },
    'tool.execute.after': async (input, output) => {
      const tool = input.tool || '';
      const args = output && output.args ? output.args : {};
      const isError = output && (output.error || output.metadata?.error);
      writeStatus({
        opencode: {
          state: isError ? 'error' : 'working',
          event: 'tool.execute.after',
          tool,
          summary: summarize(tool, args),
          ts: Date.now(),
        },
      });
    },
    event: async ({ event }) => {
      const type = event?.type || '';
      if (type === 'session.idle' || type === 'session.end') {
        writeStatus({
          opencode: {
            state: 'awaiting-input',
            event: type,
            tool: '',
            summary: '',
            ts: Date.now(),
          },
        });
      } else if (type === 'session.start' || type === 'session.compacted') {
        writeStatus({
          opencode: {
            state: 'working',
            event: type,
            tool: '',
            summary: '',
            ts: Date.now(),
          },
        });
      }
    },
  };
};

// opencode plugin 可以用 default export
module.exports = CstStatusPlugin;
// 也支持 named export, 兼容某些 loader
module.exports.CstStatusPlugin = CstStatusPlugin;
module.exports.default = CstStatusPlugin;