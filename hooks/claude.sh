#!/usr/bin/env bash
# Claude Code hook 接收端: 从 stdin 读 hook 事件 JSON, 写入 ~/.cache/claude_status_tips/status.json
# 通过 stdin 接收(Claude hook 协议), 增量更新状态文件, 保留其他工具的状态
set -euo pipefail

CACHE_DIR="${CST_CACHE_DIR:-$HOME/.cache/claude_status_tips}"
STATUS_FILE="$CACHE_DIR/status.json"
mkdir -p "$CACHE_DIR"

INPUT="$(cat)"

# 一次性解析所有字段 (单次 python3 调用, 输出 EVENT\0TOOL\0SUMMARY)
PARSED=$(
  echo "$INPUT" | python3 -c "
import json, sys
try:
  d = json.loads(sys.stdin.read())
  def get(obj, dotted):
    v = obj
    for k in dotted.split('.'):
      v = v.get(k) if isinstance(v, dict) else None
      if v is None: break
    return str(v).replace('\n', ' ')[:120] if v is not None else ''

  event = get(d, 'hook_event_name')
  tool = get(d, 'tool_name')
  ti = d.get('tool_input') or {}
  summary = ''
  for k in ('command', 'file_path', 'pattern', 'url'):
    val = ti.get(k)
    if val:
      summary = str(val).replace('\n', ' ')[:120]
      break
  if not summary and event == 'UserPromptSubmit':
    summary = get(d, 'prompt')
  sys.stdout.write(event + '\x00' + tool + '\x00' + summary)
except Exception:
  sys.stdout.write('\x00\x00')
" 2>/dev/null || printf '\0\0'
)
EVENT="$(echo "$PARSED" | cut -d$'\0' -f1)"
TOOL="$(echo "$PARSED" | cut -d$'\0' -f2)"
SUMMARY="$(echo "$PARSED" | cut -d$'\0' -f3)"

# 事件 -> 状态映射
case "$EVENT" in
  UserPromptSubmit)        STATE="awaiting-input" ;;
  PreToolUse)              STATE="working" ;;
  PostToolUse)             STATE="working" ;;
  PostToolUseFailure)      STATE="error" ;;
  PermissionRequest)       STATE="awaiting-confirmation" ;;
  Notification)            STATE="awaiting-confirmation" ;;
  Stop)                    STATE="awaiting-input" ;;
  SubagentStop)            STATE="working" ;;
  SessionStart)            STATE="working" ;;
  SessionEnd)              STATE="idle" ;;
  *)                       STATE="working" ;;
esac

NOW_MS=$(($(date +%s) * 1000))

# 用 python 安全合并(避免 jq 依赖)
python3 - <<EOF
import json, os, sys
path = "$STATUS_FILE"
data = {"version": 1, "claude": None, "opencode": None, "trae": None}
if os.path.exists(path):
    try:
        with open(path, "r", encoding="utf-8") as f:
            data = json.load(f)
        if not isinstance(data, dict):
            data = {"version": 1}
    except Exception:
        pass
data["version"] = 1
data["claude"] = {
    "state": "$STATE",
    "event": "$EVENT",
    "tool": "$TOOL",
    "summary": "$SUMMARY",
    "ts": $NOW_MS,
}
with open(path, "w", encoding="utf-8") as f:
    json.dump(data, f, ensure_ascii=False, indent=2)
EOF

# Claude hook 要求 exit 0 / 2, 0 = 允许通过
exit 0