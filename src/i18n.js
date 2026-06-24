// 国际化: 支持 en / zh-CN
// 优先级:
//   1. CST_LOCALE 环境变量(en | zh-CN), 调试 / CI 用
//   2. Electron app.getLocale() (主进程初始化时注入)
//   3. 兜底: 'en'
//
// 用法:
//   const { t } = require('./i18n');
//   t('state.working')                  // '工作中' 或 'Working'
//   t('menu.refresh')                   // '刷新(立即检测)' 或 'Refresh'

const MESSAGES = {
  en: {
    state: {
      'offline':               'Idle',
      'running':               'Running',
      'awaiting-confirmation': 'Awaiting confirmation',
      'working':               'Working',
      'awaiting-input':        'Awaiting input',
      'completed':             'Completed',
      'error':                 'Error',
    },
    tool: {
      claude:   'Claude',
      opencode: 'opencode',
      trae:     'Trae',
    },
    menu: {
      refresh:    'Refresh (detect now)',
      openConfig: 'Open Claude config folder',
      quit:       'Quit',
      noTool:     'No tool running',
      stateItem:  '{0}: {1}',
      claudeSessions: 'Claude ({0} sessions)',
      language:   'Language',
      langEn:     'English',
      langZh:     '中文',
      hooks:                   'Hooks',
      hooksStatus:             'Hook status:',
      hooksTraeUnsupported:    '(not supported)',
      installClaudeHook:       'Install Claude hook',
      uninstallClaudeHook:     'Uninstall Claude hook',
      installOpencodePlugin:   'Install opencode plugin',
      uninstallOpencodePlugin: 'Uninstall opencode plugin',
      openStatusFile:          'Reveal status.json',
    },
    flashTag: ' flashing',
    summary: {
      thinking:           'Thinking',
      toolError:          'Tool execution error',
      toolDone:           'Tool execution completed',
      userInput:          'User input',
      userMessage:        'User message',
      runError:           'Run error',
      turnEnd:            'Turn ended',
      systemMsg:          'System message',
      recap:              'recap',
      unknown:            'unknown',
    },
    tooltip: {
      allOffline:      'No AI tools running',
      claudeNoSession: 'Claude: no session data',
      opencodeRunning: 'opencode: running',
      opencodeHook:    'opencode: {0}',
      traeRunning:     'Trae: running',
      claudeLine:      'Claude: {0} {1}{2}',
      ageStr:          ' \u00b7 {0}s ago',
      summaryItem:     '{0} {1} ({2}{3})',
    },
    dialog: {
      confirm:         'Confirm',
      cancel:          'Cancel',
      errorTitle:      'Error',
      installClaudeHookTitle:  'Install Claude hook',
      installClaudeHookMsg:    'Write hooks config into ~/.claude/settings.json?',
      installClaudeHookDetail: 'Will write to: {0}\nStatus file: {1}\nExisting settings will be backed up to settings.json.cst.bak.',
      uninstallClaudeHookTitle: 'Uninstall Claude hook',
      uninstallClaudeHookMsg:   'Remove CST hooks from ~/.claude/settings.json?',
      uninstallClaudeHookNote:  'Uninstalled. Note: Claude CLI loads settings.json into memory at startup — restart Claude for hooks to fully stop.',
      uninstallClaudeHookNoteShort: 'Restart Claude to fully stop hooks.',
      installOpencodeTitle:  'Install opencode plugin',
      installOpencodeMsg:    'Copy cst-status.js to opencode plugins folder?',
      installOpencodeDetail: 'Target: {0}',
      uninstallOpencodeTitle: 'Uninstall opencode plugin',
      uninstallOpencodeMsg:   'Delete the plugin file?',
    },
    title: {
      starting: 'ClaudePulse \u00b7 Starting...',
    },
  },
  'zh-CN': {
    state: {
      'offline':               '未运行',
      'running':               '运行中',
      'awaiting-confirmation': '等待确认',
      'working':               '工作中',
      'awaiting-input':        '等待输入',
      'completed':             '已完成',
      'error':                 '出错',
    },
    tool: {
      claude:   'Claude',
      opencode: 'opencode',
      trae:     'Trae',
    },
    menu: {
      refresh:    '刷新(立即检测)',
      openConfig: '打开 Claude 配置目录',
      quit:       '退出',
      noTool:     '无工具运行',
      stateItem:  '{0}: {1}',
      claudeSessions: 'Claude ({0} 个会话)',
      language:   '语言',
      langEn:     'English',
      langZh:     '中文',
      hooks:                   'Hooks',
      hooksStatus:             'Hook 状态:',
      hooksTraeUnsupported:    '(不支持)',
      installClaudeHook:       '启用 Claude Hook',
      uninstallClaudeHook:     '卸载 Claude Hook',
      installOpencodePlugin:   '启用 opencode 插件',
      uninstallOpencodePlugin: '卸载 opencode 插件',
      openStatusFile:          '查看 status.json',
    },
    flashTag: ' 闪烁',
    summary: {
      thinking:           '思考中',
      toolError:          '工具执行出错',
      toolDone:           '工具执行完毕',
      userInput:          '用户输入',
      userMessage:        '用户消息',
      runError:           '运行出错',
      turnEnd:            '本轮结束',
      systemMsg:          '系统消息',
      recap:              'recap',
      unknown:            'unknown',
    },
    tooltip: {
      allOffline:      '所有 AI 工具均未运行',
      claudeNoSession: 'Claude: 暂无会话数据',
      opencodeRunning: 'opencode: 运行中',
      opencodeHook:    'opencode: {0}',
      traeRunning:     'Trae: 运行中',
      claudeLine:      'Claude: {0} {1}{2}',
      ageStr:          ' \u00b7 {0}s 前',
      summaryItem:     '{0} {1} ({2}{3})',
    },
    dialog: {
      confirm:         '确认',
      cancel:          '取消',
      errorTitle:      '错误',
      installClaudeHookTitle:  '启用 Claude Hook',
      installClaudeHookMsg:    '将 hooks 配置写入 ~/.claude/settings.json?',
      installClaudeHookDetail: '将写入: {0}\n状态文件: {1}\n已有配置会备份为 settings.json.cst.bak。',
      uninstallClaudeHookTitle: '卸载 Claude Hook',
      uninstallClaudeHookMsg:   '从 ~/.claude/settings.json 移除 CST hooks?',
      uninstallClaudeHookNote:  '卸载完成。注意: Claude CLI 启动时会把 settings.json 加载到内存,需要重启 Claude 进程才能彻底停用 hook。',
      uninstallClaudeHookNoteShort: '请重启 Claude 进程以彻底停用 hook。',
      installOpencodeTitle:  '启用 opencode 插件',
      installOpencodeMsg:    '将 cst-status.js 复制到 opencode 插件目录?',
      installOpencodeDetail: '目标: {0}',
      uninstallOpencodeTitle: '卸载 opencode 插件',
      uninstallOpencodeMsg:   '删除插件文件?',
    },
    title: {
      starting: 'ClaudePulse \u00b7 启动中...',
    },
  },
};

/**
 * 把任意 locale 字符串归一化到我们支持的两种之一
 */
function normalizeLocale(raw) {
  if (!raw) return 'en';
  const s = String(raw).toLowerCase().replace(/_/g, '-').replace(/\..*$/, '');
  if (s.startsWith('zh')) return 'zh-CN';
  if (s.startsWith('en')) return 'en';
  return 'en';
}

let currentLocale = (() => {
  const env = process.env.CST_LOCALE;
  if (env && MESSAGES[env]) return env;
  const sysLocale = process.env.LC_ALL || process.env.LANG || '';
  return normalizeLocale(sysLocale);
})();

function getLocale() { return currentLocale; }

function setLocale(l) {
  if (MESSAGES[l]) currentLocale = l;
  return currentLocale;
}

function initLocale(electronLocale) {
  const env = process.env.CST_LOCALE;
  if (env && MESSAGES[env]) {
    currentLocale = env;
    return currentLocale;
  }
  currentLocale = normalizeLocale(electronLocale);
  return currentLocale;
}

function t(path, ...args) {
  const parts = path.split('.');
  let cur = MESSAGES[currentLocale];
  for (const p of parts) {
    if (cur == null) return path;
    cur = cur[p];
  }
  if (cur == null) return path;
  if (typeof cur !== 'string') return path;
  if (args.length === 0) return cur;
  return cur.replace(/\{(\d+)\}/g, (_, i) => {
    const v = args[Number(i)];
    return v == null ? '' : String(v);
  });
}

module.exports = { t, detectLocale: normalizeLocale, setLocale, getLocale, initLocale, MESSAGES };