// Claude Status Tips - 主进程
const { app, Tray, Menu, nativeImage, dialog, shell } = require('electron');
const path = require('path');
const os = require('os');
const { detectProcesses } = require('./monitor');
const { readLatestActivity, encodeCwdToProjectName } = require('./claudeActivity');
const { readHookStatus } = require('./statusReader');
const { readAllClaudeSessions } = require('./sessionReader');
const watchers = require('./watchers');
const hookInstaller = require('./hookInstaller');
const {
  computeTitleFromSessions, computeTooltipFromSessions,
  toolDisplayName, stateDesc, flashTag, STATE_EMOJI,
} = require('./title');
const { STATES, FLASHING_STATES, EXCLUDED_FROM_BAR, stateToIconBase, deriveAllStates } = require('./state');
const { t, getLocale, setLocale, initLocale } = require('./i18n');

// ============ 可调配置 ============
const POLL_INTERVAL_MS = 2000;
const ROTATION_INTERVAL_MS = 2500;
const FLASH_INTERVAL_MS = 500;
const DISPLAY_MODE = 'cycle';
// ====================================

let tray = null;
let pollTimer = null;
let rotationTimer = null;
let flashTimer = null;
let watcherHandle = null;
let currentProcs = null;
let currentHooks = null;
let currentDerived = null;  // 最新 deriveAllStates 结果, 含 sessions 数组
let currentRotationIndex = 0;
let flashFrame = 0;
let runningCount = 0;

// 变更检测: 逐字段比较替代 JSON.stringify, 减少 GC 压力
let sigTools = null;
let sigSessions = null;
let sigHookUpdatedAt = 0;

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (tray) tray.displayBalloon && tray.displayBalloon({});
  });
}

if (process.platform === 'darwin' && app.dock) {
  app.dock.hide();
}

const iconCache = new Map();
function buildIconImage(iconName) {
  if (iconCache.has(iconName)) return iconCache.get(iconName);
  const file1x = path.join(__dirname, '..', 'assets', `tray-${iconName}.png`);
  const file2x = path.join(__dirname, '..', 'assets', `tray-${iconName}@2x.png`);
  const img = nativeImage.createFromPath(file1x);
  try {
    const img2x = nativeImage.createFromPath(file2x);
    if (!img2x.isEmpty()) {
      img.addRepresentation({ scaleFactor: 2.0, buffer: img2x.toPNG() });
    }
  } catch {}
  iconCache.set(iconName, img);
  return img;
}

function iconNameForState(state) {
  const base = stateToIconBase(state);
  if (FLASHING_STATES.has(state) && flashFrame === 1) {
    return base + 'Dim';
  }
  return base;
}

/**
 * 把 hook.claude 合并到 activity (state.js 从 activity.lastEntry.state 读 hook)
 */
function mergeHookIntoActivity(activity, hooks) {
  if (!hooks || !hooks.claude || !hooks.claude.lastEntry) return activity;
  return {
    state: 'ok',
    lastEntry: hooks.claude.lastEntry,
    ageMs: hooks.claude.ageMs,
    source: 'hook',
  };
}

function hookStatusLine() {
  const status = hookInstaller.checkAll();
  const parts = [];
  parts.push(`Claude Hook: ${status.claude.installed ? '✓' : '✗'}`);
  parts.push(`opencode Plugin: ${status.opencode.installed ? '✓' : '✗'}`);
  parts.push(`Trae: ${status.trae.supported ? '✓' : '✗ (不支持 hooks)'}`);
  return parts.join(' | ');
}

/**
 * 取出当前轮播到的 session 状态 (用于图标 / 闪烁 / 菜单)
 */
function getCurrentDisplayState() {
  if (!currentDerived) return STATES.OFFLINE;
  const visible = currentDerived.sessions.filter(s =>
    s.state !== STATES.OFFLINE && !EXCLUDED_FROM_BAR.has(s.tool));
  if (visible.length === 0) return STATES.OFFLINE;
  if (visible.length === 1) return visible[0].state;
  return visible[currentRotationIndex % visible.length].state;
}

/**
 * 闪烁指示符: 闪烁状态时, flashFrame=1 显示 ⚡, flashFrame=0 留空
 */
function flashIndicator(state) {
  if (!FLASHING_STATES.has(state)) return '';
  return flashFrame ? ' ⚡' : '   ';
}

function buildMenu() {
  const { tools, sessions: claudeSessions } = currentDerived || { tools: {}, sessions: [] };
  const lines = [];

  const claudeSessionsLive = (claudeSessions || []).filter(s => s.tool === 'claude' && s.state !== STATES.OFFLINE);
  for (const s of claudeSessionsLive) {
    const projectLabel = s.project ? `${toolDisplayName('claude')} · ${s.project}` : toolDisplayName('claude');
    const ageStr = s.session && s.session.statusUpdatedAt
      ? ` · ${Math.floor((Date.now() - s.session.statusUpdatedAt) / 1000)}s ago`
      : '';
    const sourceTag = s.stateSource && s.stateSource !== 'sessions' ? ` [${s.stateSource}]` : '';
    const flash = flashIndicator(s.state);
    const label = `${STATE_EMOJI[s.state] || ''}${flash} ${projectLabel} — ${stateDesc(s.state)}${flashTag(s.state)}${ageStr}${sourceTag}`.trim();
    lines.push({ label, enabled: false });
  }

  for (const [k, v] of Object.entries(tools || {})) {
    if (k === 'claude') continue;
    if (v === STATES.OFFLINE) continue;
    const desc = stateDesc(v) + flashTag(v);
    const flash = flashIndicator(v);
    lines.push({ label: `${STATE_EMOJI[v] || ''}${flash} ${t('menu.stateItem', toolDisplayName(k), desc)}`, enabled: false });
  }
  if (lines.length === 0) lines.push({ label: t('menu.noTool'), enabled: false });

  const cur = getLocale();
  const hookStatus = hookInstaller.checkAll();
  const claudeHookLabel = t(hookStatus.claude.installed ? 'menu.uninstallClaudeHook' : 'menu.installClaudeHook');
  const opencodeLabel = t(hookStatus.opencode.installed ? 'menu.uninstallOpencodePlugin' : 'menu.installOpencodePlugin');

  const items = [
    ...lines,
    { type: 'separator' },
    { label: t('menu.refresh'), click: () => tick(true) },
    { label: t('menu.openConfig'), click: () => { shell.openPath(path.join(app.getPath('home'), '.claude')); } },
    { type: 'separator' },
    {
      label: t('menu.hooks'),
      submenu: [
        { label: t('menu.hooksStatus'), enabled: false },
        { label: `Claude: ${hookStatus.claude.installed ? '✓' : '✗'}`, enabled: false },
        { label: `opencode: ${hookStatus.opencode.installed ? '✓' : '✗'}`, enabled: false },
        { label: `Trae: ✗ ${t('menu.hooksTraeUnsupported')}`, enabled: false },
        { type: 'separator' },
        { label: claudeHookLabel, click: () => toggleClaudeHook() },
        { label: opencodeLabel, click: () => toggleOpencodePlugin() },
        { type: 'separator' },
        { label: t('menu.openStatusFile'), click: () => {
          const p = path.join(app.getPath('home'), '.cache', 'claude_status_tips', 'status.json');
          shell.showItemInFolder(p);
        }},
      ],
    },
    {
      label: t('menu.language'),
      submenu: [
        { label: t('menu.langZh'), type: 'radio', checked: cur === 'zh-CN', click: () => switchLocale('zh-CN') },
        { label: t('menu.langEn'), type: 'radio', checked: cur === 'en', click: () => switchLocale('en') },
      ],
    },
    { type: 'separator' },
    { label: t('menu.quit'), click: () => app.quit() }
  ];
  return Menu.buildFromTemplate(items);
}

async function toggleClaudeHook() {
  const status = hookInstaller.checkAll().claude;
  try {
    if (status && status.installed) {
      const r = await dialog.showMessageBox({
        type: 'question', buttons: [t('dialog.confirm'), t('dialog.cancel')],
        defaultId: 1, cancelId: 1,
        title: t('dialog.uninstallClaudeHookTitle'), message: t('dialog.uninstallClaudeHookMsg'),
      });
      if (r.response === 0) {
        const removed = hookInstaller.uninstallClaudeHooks();
        console.log('[hook] Claude hooks uninstalled:', removed);
        await dialog.showMessageBox({
          type: 'info', buttons: [t('dialog.confirm')],
          title: t('dialog.uninstallClaudeHookTitle'),
          message: t('dialog.uninstallClaudeHookNoteShort'),
          detail: t('dialog.uninstallClaudeHookNote'),
        });
      }
    } else {
      const r = await dialog.showMessageBox({
        type: 'info', buttons: [t('dialog.confirm'), t('dialog.cancel')],
        defaultId: 0, cancelId: 1,
        title: t('dialog.installClaudeHookTitle'), message: t('dialog.installClaudeHookMsg'),
        detail: t('dialog.installClaudeHookDetail', hookInstaller.getPaths().claudeSettings, hookInstaller.getPaths().statusFile),
      });
      if (r.response === 0) {
        const inst = hookInstaller.installClaudeHooks();
        console.log('[hook] Claude hooks installed, backup:', inst.backup);
      }
    }
  } catch (e) {
    dialog.showErrorBox(t('dialog.errorTitle'), String(e && e.message || e));
    console.error('[hook] error:', e);
  }
  if (tray) tray.setContextMenu(buildMenu());
}

async function toggleOpencodePlugin() {
  const status = hookInstaller.checkOpencodePlugin();
  try {
    if (status.installed) {
      const r = await dialog.showMessageBox({
        type: 'question', buttons: [t('dialog.confirm'), t('dialog.cancel')],
        defaultId: 1, cancelId: 1,
        title: t('dialog.uninstallOpencodeTitle'), message: t('dialog.uninstallOpencodeMsg'),
      });
      if (r.response === 0) {
        hookInstaller.uninstallOpencodePlugin();
        console.log('[hook] opencode plugin uninstalled');
      }
    } else {
      const r = await dialog.showMessageBox({
        type: 'info', buttons: [t('dialog.confirm'), t('dialog.cancel')],
        defaultId: 0, cancelId: 1,
        title: t('dialog.installOpencodeTitle'), message: t('dialog.installOpencodeMsg'),
        detail: t('dialog.installOpencodeDetail', status.path),
      });
      if (r.response === 0) {
        hookInstaller.installOpencodePlugin();
        console.log('[hook] opencode plugin installed at', status.path);
      }
    }
  } catch (e) {
    dialog.showErrorBox(t('dialog.errorTitle'), String(e && e.message || e));
    console.error('[hook] error:', e);
  }
  if (tray) tray.setContextMenu(buildMenu());
}

function switchLocale(locale) {
  if (getLocale() === locale) return;
  setLocale(locale);
  updateTray();
  console.log(`[i18n] switched to ${getLocale()}`);
}

function updateTray() {
  if (!tray || !currentProcs || !currentDerived) return;
  const { sessions } = currentDerived;
  const displayState = getCurrentDisplayState();
  tray.setTitle(computeTitleFromSessions(sessions, DISPLAY_MODE, currentRotationIndex));
  tray.setImage(buildIconImage(iconNameForState(displayState)));
  tray.setToolTip(computeTooltipFromSessions(sessions, currentHooks));
  tray.setContextMenu(buildMenu());
}

const JSONL_FRESH_THRESHOLD_MS = 30_000;

async function collectData() {
  const procs = await detectProcesses();
  const allSessionsData = await readAllClaudeSessions(procs);
  const hooks = await readHookStatus();

  const now = Date.now();
  const needsJsonl = allSessionsData.sessions.map((s) => {
    if (!s.status) return true;
    const age = now - (s.statusUpdatedAt || 0);
    return age >= JSONL_FRESH_THRESHOLD_MS;
  });

  const claudeSessionEntries = await Promise.all(
    allSessionsData.sessions.map(async (session, i) => {
      const hookEntry = hooks.claude && hooks.claude.lastEntry ? hooks.claude.lastEntry : null;
      if (hookEntry && hookEntry.state && hookEntry.ts && (now - hookEntry.ts) < JSONL_FRESH_THRESHOLD_MS) {
        return { session, activity: null, hookEntry, jsonlSkipped: true };
      }
      if (!needsJsonl[i]) {
        return { session, activity: null, hookEntry, jsonlSkipped: true };
      }
      const hints = {};
      if (session.sessionId) hints.hintSessionId = session.sessionId;
      if (session.cwd)        hints.hintCwd      = session.cwd;
      const activity = await readLatestActivity(hints);
      return { session, activity, hookEntry, jsonlSkipped: false };
    })
  );

  // 修复: 空数组不视为 "skipped" (every 对空数组返回 true 是误报)
  const jsonlSkipped = claudeSessionEntries.length > 0 &&
    claudeSessionEntries.every((e) => e.jsonlSkipped);

  if (jsonlSkipped) {
    console.log('[collect] jsonl skipped:', claudeSessionEntries.map(e => ({
      pid: e.session && e.session.pid,
      project: e.session && e.session.project,
      skipReason: e.hookEntry && e.hookEntry.ts && (Date.now() - e.hookEntry.ts < JSONL_FRESH_THRESHOLD_MS)
        ? 'hook-fresh' : 'sessions-fresh',
    })));
  }

  return { procs, claudeSessionEntries, hooks, jsonlSkipped };
}

/**
 * 逐字段比较替代 JSON.stringify, 减少每 2 秒一次的序列化开销
 */
function hasStateChanged(derived, data) {
  const newTools = derived.tools;
  const newSessions = derived.sessions;
  const newHookUpdatedAt = data.hooks && data.hooks.updatedAt || 0;

  if (sigTools === null || !shallowEqual(newTools, sigTools)) return true;
  if (newHookUpdatedAt !== sigHookUpdatedAt) return true;
  if (!sigSessions || newSessions.length !== sigSessions.length) return true;
  for (let i = 0; i < newSessions.length; i++) {
    const a = newSessions[i], b = sigSessions[i];
    if (a.tool !== b.tool || a.pid !== b.pid || a.project !== b.project ||
        a.state !== b.state || a.ageMs !== b.ageMs) return true;
  }
  return false;
}

function shallowEqual(a, b) {
  const ka = Object.keys(a), kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  for (const k of ka) { if (a[k] !== b[k]) return false; }
  return true;
}

function saveStateSig(derived, data) {
  sigTools = { ...derived.tools };
  sigSessions = derived.sessions.map(s => ({
    tool: s.tool, pid: s.pid, project: s.project, state: s.state, ageMs: s.ageMs,
  }));
  sigHookUpdatedAt = data.hooks && data.hooks.updatedAt || 0;
}

function applyState(derived, data, forceLog, fromWatcher) {
  const changed = hasStateChanged(derived, data);

  if (changed) {
    saveStateSig(derived, data);
    currentProcs = data.procs;
    currentDerived = derived;
    currentHooks = data.hooks;
    const visibleSessions = derived.sessions.filter(s =>
      s.state !== STATES.OFFLINE && !EXCLUDED_FROM_BAR.has(s.tool));
    if (visibleSessions.length !== runningCount) {
      currentRotationIndex = 0;
      runningCount = visibleSessions.length;
    }
  }

  if (changed || forceLog) {
    updateTray();
  }

  if (watcherHandle && data.claudeSessionEntries) {
    for (const e of data.claudeSessionEntries) {
      if (e.session && e.session.sessionId && e.session.cwd) {
        const projectName = encodeCwdToProjectName(e.session.cwd);
        const jsonlPath = path.join(os.homedir(), '.claude', 'projects', projectName, `${e.session.sessionId}.jsonl`);
        watcherHandle.refreshJsonl(jsonlPath);
      }
    }
  }

  if (forceLog) {
    console.log('[status]', {
      tools: derived.tools,
      sessions: derived.sessions.map(s => ({ tool: s.tool, pid: s.pid, project: s.project, state: s.state })),
      activeNames: derived.activeNames,
      anyRunning: derived.anyRunning,
      worst: derived.worst,
      title: computeTitleFromSessions(derived.sessions, DISPLAY_MODE, currentRotationIndex),
      fromWatcher,
    });
    console.log(hookStatusLine());
  }
}

async function tick(forceLog = false, fromWatcher = false) {
  let data;
  try {
    data = await collectData();
  } catch (e) {
    console.error('[tick] error:', e);
    return;
  }
  const derived = deriveAllStates(data.procs, data.claudeSessionEntries, data.hooks);
  applyState(derived, data, forceLog, fromWatcher);
}

function startPolling() {
  if (pollTimer) clearInterval(pollTimer);
  console.log(`[poll] start, interval=${POLL_INTERVAL_MS}ms`);
  pollTimer = setInterval(() => tick(), POLL_INTERVAL_MS);
  tick(true);
}

function startRotation() {
  if (rotationTimer) clearInterval(rotationTimer);
  console.log(`[rotation] start, interval=${ROTATION_INTERVAL_MS}ms, mode=${DISPLAY_MODE}`);
  rotationTimer = setInterval(() => {
    try {
      if (!currentDerived) return;
      const visibleSessions = currentDerived.sessions.filter(s =>
        s.state !== STATES.OFFLINE && !EXCLUDED_FROM_BAR.has(s.tool));
      if (visibleSessions.length > 1) {
        currentRotationIndex = (currentRotationIndex + 1) % visibleSessions.length;
        if (tray) {
          tray.setTitle(computeTitleFromSessions(currentDerived.sessions, DISPLAY_MODE, currentRotationIndex));
          const displayState = getCurrentDisplayState();
          tray.setImage(buildIconImage(iconNameForState(displayState)));
          tray.setToolTip(computeTooltipFromSessions(currentDerived.sessions, currentHooks));
        }
      }
    } catch (e) {
      console.error('[rotation] error:', e);
    }
  }, ROTATION_INTERVAL_MS);
}

function startFlash() {
  if (flashTimer) clearInterval(flashTimer);
  console.log(`[flash] start, interval=${FLASH_INTERVAL_MS}ms`);
  flashTimer = setInterval(() => {
    try {
      if (!tray || !currentDerived) return;
      const displayState = getCurrentDisplayState();
      if (!FLASHING_STATES.has(displayState)) {
        flashFrame = 0;
        return;
      }
      flashFrame = 1 - flashFrame;
      tray.setImage(buildIconImage(iconNameForState(displayState)));
      tray.setContextMenu(buildMenu());
    } catch (e) {
      console.error('[flash] error:', e);
    }
  }, FLASH_INTERVAL_MS);
}

function startWatchers() {
  if (watcherHandle) return;
  watcherHandle = watchers.start((changedKey) => {
    tick(false, true);
  });
  console.log('[watcher] started');
}

app.whenReady().then(() => {
  hookInstaller.setHomeDir(app.getPath('home'));
  const detected = initLocale(app.getLocale());
  console.log(`[i18n] locale = ${detected} (system: ${app.getLocale()})`);

  const initialImg = buildIconImage('gray');
  tray = new Tray(initialImg);
  tray.setToolTip(t('title.starting'));
  tray.on('click', () => {
    if (process.platform !== 'darwin') {
      tray.popUpContextMenu();
    }
  });
  startPolling();
  startRotation();
  startFlash();
  startWatchers();
});

app.on('window-all-closed', (e) => {
  e.preventDefault?.();
});

app.on('will-quit', () => {
  if (pollTimer) clearInterval(pollTimer);
  if (rotationTimer) clearInterval(rotationTimer);
  if (flashTimer) clearInterval(flashTimer);
  if (watcherHandle) { watcherHandle.stop(); watcherHandle = null; }
});
