// 文件监听: 当 hook status.json / sessions/<pid>.json / JSONL 变更时, 立即触发回调
// 让 hook 事件能实时反映到状态栏, 不用等 2s 轮询
//
// 监听 3 类文件:
//   1. ~/.cache/claude_status_tips/status.json (hook 写入)
//   2. ~/.claude/sessions/*.json (Claude 进程维护)
//   3. ~/.claude/projects/<cwd>/<sessionId>.jsonl (Claude 进程写入 JSONL)
//
// 实现细节:
//   - 用 fs.watch (FSEvents on macOS) 监听目录/文件, 实时性远高于 fs.watchFile
//   - debounce 250ms, 防止 hook 连续写触发多次回调
//   - 文件被替换 (rename) 时自动重新监听

const fs = require('fs');
const path = require('path');
const os = require('os');

const STATUS_DIR = path.join(os.homedir(), '.cache', 'claude_status_tips');
const STATUS_FILE = path.join(STATUS_DIR, 'status.json');
const SESSIONS_DIR = path.join(os.homedir(), '.claude', 'sessions');
const PROJECTS_DIR = path.join(os.homedir(), '.claude', 'projects');
const DEBOUNCE_MS = 250;

function log(...args) {
  console.log('[watcher]', ...args);
}

/**
 * 防抖: 同一文件连续多次触发合并为一次回调
 */
function debouncePerKey(fn, wait) {
  const timers = new Map();
  return (key, ...args) => {
    if (timers.has(key)) clearTimeout(timers.get(key));
    timers.set(key, setTimeout(() => {
      timers.delete(key);
      fn(key, ...args);
    }, wait));
  };
}

/**
 * 启动所有 watcher
 * @param {() => void} onChange 任意文件变更时调用 (debounced)
 * @returns {{ stop: () => void, refreshJsonl: (filePath: string) => void }}
 */
function start(onChange) {
  const handlers = [];   // fs.watch 返回的 watcher (用于 stop)
  const jsonlWatchers = new Map();  // 文件路径 → watcher

  const fire = debouncePerKey((key) => {
    log('change detected:', key);
    try { onChange(key); } catch (e) { console.error('[watcher] onChange error:', e); }
  }, DEBOUNCE_MS);

  // 确保 status.json 的目录存在
  try { fs.mkdirSync(STATUS_DIR, { recursive: true }); } catch {}

  // 1. 监听 status.json 所在目录 (比 watchFile 更可靠: 能捕获新建/替换)
  //    fs.watch 用 FSEvents (macOS) / inotify (Linux), 实时性远高于 watchFile 的 poll
  try {
    const w = fs.watch(STATUS_DIR, { persistent: false }, (eventType, filename) => {
      if (filename && filename === 'status.json') {
        fire('status.json');
      }
    });
    handlers.push(w);
    log('watching dir', STATUS_DIR, '(for status.json)');
  } catch (e) {
    log('cannot watch status dir:', e.message);
  }

  // 2. 监听 ~/.claude/sessions 目录 (Claude 进程维护)
  try {
    if (!fs.existsSync(SESSIONS_DIR)) fs.mkdirSync(SESSIONS_DIR, { recursive: true });
    const w = fs.watch(SESSIONS_DIR, { persistent: false }, (eventType, filename) => {
      if (filename && filename.endsWith('.json')) fire('sessions/' + filename);
    });
    handlers.push(w);
    log('watching dir', SESSIONS_DIR);
  } catch (e) {
    log('cannot watch sessions dir:', e.message);
  }

  // 3. ~/.claude/projects 下的 JSONL 由 refreshJsonl() 显式监听具体文件

  /**
   * 显式监听指定的 JSONL 文件 (Claude 当前活跃 session)
   */
  function watchJsonlFile(filePath) {
    if (!filePath || jsonlWatchers.has(filePath)) return;
    try {
      if (!fs.existsSync(filePath)) return;
      const w = fs.watch(filePath, { persistent: false }, (eventType) => {
        fire(filePath);
      });
      jsonlWatchers.set(filePath, w);
      log('watching jsonl', filePath);
    } catch (e) {
      log('cannot watch jsonl:', filePath, e.message);
    }
  }

  function refreshJsonl(filePath) {
    if (!filePath) return;
    if (jsonlWatchers.has(filePath)) return;
    watchJsonlFile(filePath);
    fire(filePath);
  }

  function stop() {
    for (const w of handlers) { try { w.close(); } catch {} }
    for (const w of jsonlWatchers.values()) { try { w.close(); } catch {} }
    handlers.length = 0;
    jsonlWatchers.clear();
    log('stopped');
  }

  return { stop, refreshJsonl };
}

module.exports = {
  start,
  STATUS_FILE,
  SESSIONS_DIR,
  PROJECTS_DIR,
};
