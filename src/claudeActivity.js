// Claude Code 活动检测:
// 解析 ~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl 的最后一条记录
// 返回结构化的 lastEntry, 供 state.js 推导具体状态
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const os = require('os');
const { t } = require('./i18n');

const CLAUDE_HOME = path.join(os.homedir(), '.claude');
const PROJECTS_DIR = path.join(CLAUDE_HOME, 'projects');
const IDLE_THRESHOLD_MS = 30 * 1000;

// 需要用户确认的工具(默认权限)
const CONFIRMATION_TOOLS = new Set([
  'Bash', 'Edit', 'Write', 'WebFetch', 'WebSearch', 'NotebookEdit', 'KillBash',
]);

/**
 * cwd -> ~/.claude/projects 下的目录名
 *   /Users/foo/bar       -> -Users-foo-bar
 *   /Users/foo bar/baz   -> -Users-foo bar-baz (空格保留, / 变 -)
 * macOS 实测: 把 cwd 的每个 / 替换为 -, 最前面加 -
 */
function encodeCwdToProjectName(cwd) {
  if (!cwd) return null;
  return cwd.replace(/\//g, '-');
}

/**
 * 定位 session 文件
 * 优先级:
 *   1. hintSessionId + hintCwd -> ~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl
 *   2. 遍历所有 projects 下 mtime 最新的 jsonl(老逻辑)
 */
async function findLatestSession(hints = {}) {
  if (hints.hintSessionId && hints.hintCwd) {
    const projectName = encodeCwdToProjectName(hints.hintCwd);
    const file = path.join(PROJECTS_DIR, projectName, hints.hintSessionId + '.jsonl');
    try {
      const st = await fsp.stat(file);
      return { path: file, mtime: st.mtimeMs, source: 'hint' };
    } catch {}
  }

  try {
    const projects = await fsp.readdir(PROJECTS_DIR, { withFileTypes: true });
    const candidates = [];
    for (const proj of projects) {
      if (!proj.isDirectory()) continue;
      const dir = path.join(PROJECTS_DIR, proj.name);
      let files;
      try { files = await fsp.readdir(dir); } catch { continue; }
      for (const f of files) {
        if (!f.endsWith('.jsonl')) continue;
        const full = path.join(dir, f);
        try {
          const st = await fsp.stat(full);
          candidates.push({ path: full, mtime: st.mtimeMs });
        } catch {}
      }
    }
    if (candidates.length === 0) return null;
    candidates.sort((a, b) => b.mtime - a.mtime);
    return { ...candidates[0], source: 'mtime' };
  } catch (e) {
    if (e.code !== 'ENOENT') {
      console.error('[activity] findLatestSession:', e.message);
    }
    return null;
  }
}

function shortenPath(p) {
  if (!p) return '';
  if ([...p].length <= 32) return p;
  const chars = [...p];
  return '…' + chars.slice(-31).join('');
}

/**
 * 解析单行 JSON, 返回结构化的最后一条事件信息
 */
function parseLastEntry(line) {
  if (!line || !line.trim()) return null;
  let obj;
  try { obj = JSON.parse(line); } catch { return null; }

  const type = obj.type;
  const msg = obj.message;
  const content = msg && msg.content;

  if (type === 'assistant' && Array.isArray(content)) {
    for (let i = content.length - 1; i >= 0; i--) {
      const block = content[i];
      if (block && block.type === 'tool_use') {
        const toolName = block.name || 'tool';
        const input = block.input || {};
        let detail = '';
        if (toolName === 'Read' && input.file_path) {
          detail = ' ' + shortenPath(input.file_path);
        } else if ((toolName === 'Write' || toolName === 'Edit') && input.file_path) {
          detail = ' ' + shortenPath(input.file_path);
        } else if (toolName === 'Bash' && input.command) {
          detail = ' ' + String(input.command).slice(0, 30);
        } else if (toolName === 'Grep' && (input.pattern || input.query)) {
          detail = ' /' + (input.pattern || input.query) + '/';
        } else if (toolName === 'Glob' && input.pattern) {
          detail = ' ' + input.pattern;
        } else if ((toolName === 'Agent' || toolName === 'Task') && input.description) {
          detail = ' ' + input.description;
        }
        return {
          kind: 'tool_use',
          toolName,
          summary: (toolName + detail).trim(),
          requiresConfirmation: CONFIRMATION_TOOLS.has(toolName),
          rawType: type,
        };
      }
    }
    for (let i = content.length - 1; i >= 0; i--) {
      const block = content[i];
      if (block && block.type === 'text' && block.text) {
        return {
          kind: 'text',
          summary: block.text.slice(0, 60).replace(/\s+/g, ' ').trim(),
          rawType: type,
        };
      }
    }
    for (let i = content.length - 1; i >= 0; i--) {
      const block = content[i];
      if (block && block.type === 'thinking' && block.thinking) {
        return {
          kind: 'thinking',
          summary: '💭 ' + block.thinking.slice(0, 60).replace(/\s+/g, ' ').trim(),
          rawType: type,
        };
      }
    }
    return { kind: 'text', summary: t('summary.thinking'), rawType: type };
  }

  if (type === 'user' && Array.isArray(content)) {
    for (let i = content.length - 1; i >= 0; i--) {
      const block = content[i];
      if (block && block.type === 'tool_result') {
        const isError = block.is_error === true;
        let summary = isError ? t('summary.toolError') : t('summary.toolDone');
        if (typeof block.content === 'string') {
          summary = (isError ? '✗ ' : '✓ ') + block.content.slice(0, 40).replace(/\s+/g, ' ').trim();
        }
        return { kind: 'tool_result', toolName: undefined, summary, isError, rawType: type };
      }
    }
    for (let i = content.length - 1; i >= 0; i--) {
      const block = content[i];
      if (block && block.type === 'text' && block.text) {
        return { kind: 'user_text', summary: t('summary.userInput'), rawType: type };
      }
    }
    return { kind: 'user_text', summary: t('summary.userMessage'), rawType: type };
  }

  if (type === 'result') {
    const isError = obj.is_error === true || (obj.subtype && obj.subtype !== 'success');
    return { kind: 'result', summary: isError ? t('summary.runError') : t('summary.turnEnd'), isError, rawType: type };
  }

  if (type === 'system') {
    const subtype = obj.subtype || '';
    if (subtype === 'away_summary') {
      const c = typeof obj.content === 'string' ? obj.content : '';
      return { kind: 'system', subtype, summary: c.slice(0, 60).replace(/\s+/g, ' ').trim() || t('summary.recap'), rawType: type };
    }
    if (subtype === 'turn_duration') {
      return { kind: 'system', subtype, summary: 'turn_duration', rawType: type };
    }
    return { kind: 'system', summary: t('summary.systemMsg'), rawType: type };
  }

  if (type === 'attachment') {
    return { kind: 'attachment', summary: 'attachment', rawType: type };
  }

  return { kind: 'unknown', summary: type || 'unknown', rawType: type };
}

/**
 * 读取 session 最后几行, 推断活动状态
 * 优化: buffer 从 16KB 增大到 32KB, 避免大 attachment 占满 buffer 导致有效 entry 被截断
 */
async function readLatestActivity(hints = {}) {
  const session = await findLatestSession(hints);
  if (!session) {
    return { state: 'no-session', lastEntry: null, ageMs: Infinity, lastFile: null };
  }

  const ageMs = Date.now() - session.mtime;
  const READ_BUFFER_SIZE = 32 * 1024;  // 32KB

  let fd;
  try {
    fd = await fsp.open(session.path, 'r');
    const stat = await fd.stat();
    const readSize = Math.min(stat.size, READ_BUFFER_SIZE);
    const start = Math.max(0, stat.size - readSize);
    const buf = Buffer.alloc(readSize);
    await fd.read(buf, 0, readSize, start);
    const text = buf.toString('utf8');
    const lines = text.split('\n').filter(Boolean);
    for (let i = lines.length - 1; i >= 0; i--) {
      const entry = parseLastEntry(lines[i]);
      if (entry) {
        return {
          state: ageMs > IDLE_THRESHOLD_MS ? 'idle' : 'active',
          lastEntry: entry,
          ageMs,
          lastFile: session.path,
          sessionSource: session.source,
        };
      }
    }
  } catch (e) {
    console.error('[activity] readLatestActivity:', e.message);
  } finally {
    if (fd) await fd.close().catch(() => {});
  }
  return { state: 'idle', lastEntry: null, ageMs, lastFile: session.path };
}

module.exports = {
  readLatestActivity,
  findLatestSession,
  encodeCwdToProjectName,
  parseLastEntry,
  IDLE_THRESHOLD_MS,
  CONFIRMATION_TOOLS,
  PROJECTS_DIR,
};
