// 安装/卸载 Claude Code hooks 和 opencode plugin
// Claude: 合并到 ~/.claude/settings.json (hooks 段)
// opencode: 复制到 ~/.config/opencode/plugins/cst-status.js
// 状态文件路径: ~/.cache/claude_status_tips/status.json
const fs = require('fs');
const os = require('os');
const path = require('path');

const CST_MARKER = 'claude_status_tips/hooks/claude.sh';
const PLUGIN_FILENAME = 'cst-status.js';

// 可注入的 home 目录 (默认 os.homedir, Electron 主进程可覆盖)
let _homeDir = os.homedir();
function homeDir() { return _homeDir; }
function setHomeDir(dir) { if (dir) _homeDir = dir; }

function getPaths() {
  const home = homeDir();
  return {
    home,
    claudeSettings: path.join(home, '.claude', 'settings.json'),
    claudeSettingsBak: path.join(home, '.claude', 'settings.json.cst.bak'),
    cacheDir: path.join(home, '.cache', 'claude_status_tips'),
    statusFile: path.join(home, '.cache', 'claude_status_tips', 'status.json'),
    claudeHookSrc: path.join(__dirname, '..', 'hooks', 'claude.sh'),
    opencodePluginSrc: path.join(__dirname, '..', 'hooks', 'opencode-plugin.js'),
    opencodePluginDst: path.join(home, '.config', 'opencode', 'plugins', PLUGIN_FILENAME),
  };
}

/**
 * 把当前激活的 hook 命令路径生成出来
 * 优先使用 app 路径(开发时是项目根 hooks/claude.sh)
 */
function getClaudeHookCommand() {
  const { claudeHookSrc } = getPaths();
  // 用 bash 显式调, 兼容 Unix/macOS
  return `bash "${claudeHookSrc}"`;
}

// ====== Claude hooks ======

/**
 * @returns {{
 *   installed: boolean,         // 我们的 hook 是否已安装
 *   settingsExists: boolean,
 *   raw: any,                   // 现有 settings.json 内容(可能无效)
 *   error?: string,
 * }}
 */
function checkClaudeHooks() {
  const { claudeSettings } = getPaths();
  const result = { installed: false, settingsExists: false, raw: null };
  if (!fs.existsSync(claudeSettings)) return result;
  result.settingsExists = true;
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(claudeSettings, 'utf-8'));
  } catch (e) {
    return { ...result, error: `settings.json 解析失败: ${e.message}` };
  }
  result.raw = raw;
  result.installed = detectOurHook(raw);
  return result;
}

function detectOurHook(raw) {
  if (!raw || typeof raw !== 'object' || !raw.hooks) return false;
  const cmd = getClaudeHookCommand();
  for (const eventName of Object.keys(raw.hooks)) {
    const arr = raw.hooks[eventName];
    if (!Array.isArray(arr)) continue;
    for (const group of arr) {
      const hooks = group && group.hooks;
      if (!Array.isArray(hooks)) continue;
      for (const h of hooks) {
        if (h && typeof h.command === 'string' && h.command.includes(CST_MARKER)) {
          return true;
        }
      }
    }
  }
  return false;
}

// 我们要注册的事件(覆盖 Claude 全流程)
const CLAUDE_HOOK_EVENTS = [
  'PreToolUse',
  'PostToolUse',
  'PostToolUseFailure',
  'UserPromptSubmit',
  'PermissionRequest',
  'Notification',
  'Stop',
  'SubagentStop',
  'SessionStart',
  'SessionEnd',
];

/**
 * 安装 Claude hook, 合并到已有 settings.json (保留用户配置)
 */
function installClaudeHooks() {
  const paths = getPaths();
  fs.mkdirSync(path.dirname(paths.claudeSettings), { recursive: true });

  let raw = {};
  if (fs.existsSync(paths.claudeSettings)) {
    // 备份
    try {
      fs.copyFileSync(paths.claudeSettings, paths.claudeSettingsBak);
    } catch {}
    try {
      raw = JSON.parse(fs.readFileSync(paths.claudeSettings, 'utf-8'));
    } catch (e) {
      throw new Error(`settings.json 解析失败, 请手动备份后删除: ${e.message}`);
    }
    if (!raw || typeof raw !== 'object') raw = {};
  }

  if (!raw.hooks || typeof raw.hooks !== 'object') raw.hooks = {};

  const cmd = getClaudeHookCommand();
  for (const ev of CLAUDE_HOOK_EVENTS) {
    if (!Array.isArray(raw.hooks[ev])) raw.hooks[ev] = [];
    // 避免重复
    const exists = raw.hooks[ev].some((group) =>
      group && Array.isArray(group.hooks) &&
      group.hooks.some((h) => h && typeof h.command === 'string' && h.command.includes(CST_MARKER))
    );
    if (exists) continue;
    raw.hooks[ev].push({
      matcher: '',
      hooks: [{ type: 'command', command: cmd }],
    });
  }

  fs.writeFileSync(paths.claudeSettings, JSON.stringify(raw, null, 2));
  return { ok: true, backup: paths.claudeSettingsBak };
}

/**
 * 移除 Claude hook (只移除我们的, 保留用户其他 hook)
 * 同时清理 status.json —— 防止已启动的 Claude 进程继续写
 * 注: Claude CLI 启动时把 settings.json 加载到内存,
 *     卸载后必须重启 Claude 进程才能彻底停用 hook
 */
function uninstallClaudeHooks() {
  const { claudeSettings, claudeSettingsBak, statusFile } = getPaths();
  if (!fs.existsSync(claudeSettings)) {
    // settings 没有, 顺手清理 status.json 残留
    removeStatusFile(statusFile);
    return { ok: true, removed: false };
  }
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(claudeSettings, 'utf-8'));
  } catch (e) {
    return { ok: false, error: e.message };
  }
  if (!raw || !raw.hooks) {
    removeStatusFile(statusFile);
    return { ok: true, removed: false };
  }

  let removedCount = 0;
  for (const ev of Object.keys(raw.hooks)) {
    const arr = raw.hooks[ev];
    if (!Array.isArray(arr)) continue;
    raw.hooks[ev] = arr
      .map((group) => {
        if (!group || !Array.isArray(group.hooks)) return group;
        const filtered = group.hooks.filter(
          (h) => !(h && typeof h.command === 'string' && h.command.includes(CST_MARKER))
        );
        removedCount += group.hooks.length - filtered.length;
        return { ...group, hooks: filtered };
      })
      .filter((group) => group.hooks && group.hooks.length > 0);
    if (raw.hooks[ev].length === 0) delete raw.hooks[ev];
  }
  if (Object.keys(raw.hooks).length === 0) delete raw.hooks;

  fs.writeFileSync(claudeSettings, JSON.stringify(raw, null, 2));
  // 备份不再需要, 清理
  if (fs.existsSync(claudeSettingsBak)) {
    try { fs.unlinkSync(claudeSettingsBak); } catch {}
  }
  // 清理 status.json 残留 (Claude 进程不重启前 hook 仍可能继续写, 这里先清空)
  removeStatusFile(statusFile);
  return { ok: true, removed: removedCount > 0, removedCount };
}

function removeStatusFile(statusFile) {
  if (statusFile && fs.existsSync(statusFile)) {
    try { fs.unlinkSync(statusFile); } catch {}
  }
}

// ====== opencode plugin ======

function checkOpencodePlugin() {
  const { opencodePluginDst } = getPaths();
  return { installed: fs.existsSync(opencodePluginDst), path: opencodePluginDst };
}

function installOpencodePlugin() {
  const paths = getPaths();
  fs.mkdirSync(path.dirname(paths.opencodePluginDst), { recursive: true });
  fs.copyFileSync(paths.opencodePluginSrc, paths.opencodePluginDst);
  return { ok: true, path: paths.opencodePluginDst };
}

function uninstallOpencodePlugin() {
  const { opencodePluginDst } = getPaths();
  if (fs.existsSync(opencodePluginDst)) {
    fs.unlinkSync(opencodePluginDst);
    return { ok: true, removed: true };
  }
  return { ok: true, removed: false };
}

// ====== 总体 ======

function checkAll() {
  return {
    claude: checkClaudeHooks(),
    opencode: checkOpencodePlugin(),
    trae: { installed: false, supported: false, note: 'Trae IDE 当前不支持 lifecycle hooks' },
  };
}

module.exports = {
  getPaths,
  setHomeDir,
  checkClaudeHooks,
  installClaudeHooks,
  uninstallClaudeHooks,
  checkOpencodePlugin,
  installOpencodePlugin,
  uninstallOpencodePlugin,
  checkAll,
  CLAUDE_HOOK_EVENTS,
  CST_MARKER,
};