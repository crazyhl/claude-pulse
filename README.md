# ClaudePulse

A cross-platform system tray status indicator for Claude Code, Trae, and opencode with real-time multi-session monitoring.

一个跨平台的系统托盘 / 菜单栏小工具,**根据 Claude / opencode / Trae 的实际工作状态,用不同颜色 + 闪烁/常亮来表达**。

![platform](https://img.shields.io/badge/platform-macOS%20%7C%20Windows%20%7C%20Linux-blue)

## 状态机(状态 → 颜色 → 动画)

| 状态 | 颜色 | 动画 | 含义 |
| --- | --- | --- | --- |
| `offline` | 灰 | 常亮 | 进程未运行 |
| `running` | 黄 | 常亮 | 进程在,但无活动(待命) |
| `awaiting-confirmation` | 黄 | **闪烁** | Claude 发出 `Bash/Edit/Write` 等需确认的工具,正等用户批准 |
| `working` | 绿 | **闪烁** | Claude 正在思考 / 执行工具 / 处理工具结果 |
| `awaiting-input` | 绿 | 常亮 | 上一轮结束(3-30s 无活动),等用户输入 |
| `completed` | 蓝 | 常亮 | 长时间空闲(> 5min) |
| `error` | 红 | **闪烁** | `tool_result.is_error == true` / 顶层 result 报错 |

**判断"是否在执行指令"的标准: `working` 或 `awaiting-confirmation` 即视为"任务在跑"。**

## 轮播规则(标题文字)

- **0 个非 offline 工具**: 标题为空(只显示图标)
- **0 个 active + 1 个非 offline**: 显示该工具名(不轮)
- **0 个 active + 2+ 个非 offline**: 显示第一个非 offline(不轮——只要任务没在跑就不轮)
- **1 个 active**: 显示该工具名(不轮)
- **2+ 个 active**: 2.5s 切换一次(轮播)

> 满足你的需求"程序开启不滚动,只有多个程序的任务都在运行才交替显示"。

## 状态检测(Claude Code)

- **进程层**: `ps-list` 检测 `claude` 进程
- **活动层**: 解析 `~/.claude/projects/*/*.jsonl` 的最后一条记录
  - `assistant` + `tool_use`(`Read/Glob/Grep` 不需确认): working
  - `assistant` + `tool_use`(`Bash/Edit/Write` 等): < 3s 视为 working, 3-60s 视为 awaiting-confirmation
  - `assistant` + `text`: working(生成中)
  - `user` + `tool_result`: working(刚收到, 正在处理)
  - `tool_result.is_error == true`: error
  - 长时间无更新: completed

## 跨平台行为

| 平台 | 图标风格 | 备注 |
| --- | --- | --- |
| macOS | 彩色 PNG(直接看到颜色) | `app.dock.hide()` 隐藏 dock 图标 |
| Windows | 彩色 PNG | 系统托盘(`System Tray`) |
| Linux | 彩色 PNG | 需要 `libappindicator3-1` 之类的运行时 |

闪烁实现: 500ms 切换 `filled` ↔ `hollow`(空心)图标变体,纯前端无需任何动画库。

## 目录结构

```
claude-status-tips/
├── package.json
├── src/
│   ├── main.js            # Electron 主进程: 托盘 + 闪烁定时器 + 轮播调度
│   ├── state.js           # 纯函数: process + activity → 7 状态
│   ├── title.js           # 纯函数: 状态 → 标题 / tooltip
│   ├── monitor.js         # 跨平台进程检测(ps-list)
│   └── claudeActivity.js  # Claude Code session JSONL 解析
├── tools/
│   ├── gen-icons.js       # 图标生成(pngjs): 5 色 × 2 变体 × 2 尺寸
│   ├── smoke.js           # 模块自测(monitor + claudeActivity)
│   └── test-title.js      # state.js + title.js 单元测试
├── assets/                # 生成的图标(8 种状态 × 2 尺寸 = 16 文件)
└── README.md
```

## 安装与启动

```bash
npm install    # postinstall 自动跑 gen-icons 生成图标
npm start
```

## 调试

```bash
# 跑 state + title 的纯函数单测
npm test

# 不开托盘,只跑检测逻辑
node tools/smoke.js

# 启动托盘 + 详细日志
npm start
# 进程内 stdout:
#   [poll] start, interval=2000ms
#   [rotation] start, interval=2500ms, mode=cycle
#   [flash] start, interval=500ms
#   [status] { tools: {...}, activeNames: [...], worst: '...', title: '...' }
```

## 调节

修改 [src/main.js](file:///Users/haoliang/Documents/trae_projects/claude_status_tips/src/main.js) 顶部的常量:

```js
const POLL_INTERVAL_MS = 2000;    // 状态检测间隔
const ROTATION_INTERVAL_MS = 2500;// 轮播切换间隔
const FLASH_INTERVAL_MS = 500;    // 闪烁切换间隔
const DISPLAY_MODE = 'cycle';     // 'cycle' | 'all'
```

阈值定义在 [src/state.js](file:///Users/haoliang/Documents/trae_projects/claude_status_tips/src/state.js) 的 `T`:

```js
const T = {
  ACTIVE:          3_000,    // < 3s 视为"刚刚在做事"
  RECENT:         30_000,    // < 30s 算"最近活动过"
  STALE:         300_000,    // > 5min 算"长时无活动"
  CONFIRM_TIMEOUT: 60_000,   // 60s 还没结果视为确认超时
};
```

## 后续可扩展

- [ ] opencode / Trae 的细粒度活动检测(目前只检测进程存在)
- [ ] macOS 系统通知(任务完成 / 出错时)
- [ ] 状态历史 / 时间统计
- [ ] `electron-builder` 打包 `.dmg` / `.exe` / `.AppImage`

## License

MIT
