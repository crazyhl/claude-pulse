#!/usr/bin/env python3
"""测试 hooks/claude.sh 处理多种 Claude Code hook 事件"""
import json
import os
import shutil
import subprocess
import sys
import tempfile

HOOK = os.path.join(os.path.dirname(__file__), '..', 'hooks', 'claude.sh')

cases = [
    ('PreToolUse (Bash)',
     {'hook_event_name': 'PreToolUse', 'tool_name': 'Bash', 'tool_input': {'command': 'npm test'}},
     'working', 'Bash', 'npm test'),
    ('PostToolUse',
     {'hook_event_name': 'PostToolUse', 'tool_name': 'Read', 'tool_input': {'file_path': '/tmp/foo.ts'}},
     'working', 'Read', '/tmp/foo.ts'),
    ('PostToolUseFailure',
     {'hook_event_name': 'PostToolUseFailure', 'tool_name': 'Bash', 'tool_input': {'command': 'rm -rf /'}},
     'error', 'Bash', 'rm -rf /'),
    ('UserPromptSubmit',
     {'hook_event_name': 'UserPromptSubmit', 'prompt': '帮我看看这个 bug'},
     'awaiting-input', '', '帮我看看这个 bug'),
    ('Notification(permission)',
     {'hook_event_name': 'Notification', 'notification_type': 'permission_prompt'},
     'awaiting-confirmation', '', ''),
    ('Stop',
     {'hook_event_name': 'Stop'},
     'awaiting-input', '', ''),
    ('SessionEnd',
     {'hook_event_name': 'SessionEnd'},
     'idle', '', ''),
    ('PreToolUse (Edit)',
     {'hook_event_name': 'PreToolUse', 'tool_name': 'Edit', 'tool_input': {'file_path': 'src/main.js'}},
     'working', 'Edit', 'src/main.js'),
]

tmp = tempfile.mkdtemp(prefix='cst-hook-')
cache = os.path.join(tmp, '.cache', 'claude_status_tips')
os.makedirs(cache, exist_ok=True)
status_file = os.path.join(cache, 'status.json')

failed = 0
for label, event, exp_state, exp_tool, exp_summary in cases:
    # 清空旧 status
    if os.path.exists(status_file):
        os.remove(status_file)
    # 喂入 hook
    p = subprocess.run(['bash', HOOK], input=json.dumps(event), capture_output=True, text=True,
                       env={**os.environ, 'HOME': tmp})
    if p.returncode != 0:
        print(f'  ✗ {label}: hook exit {p.returncode}: {p.stderr[:200]}')
        failed += 1
        continue
    if not os.path.exists(status_file):
        print(f'  ✗ {label}: status.json 未生成')
        failed += 1
        continue
    with open(status_file) as f:
        data = json.load(f)
    actual_state = data['claude']['state']
    actual_tool = data['claude']['tool']
    actual_summary = data['claude']['summary']
    ok = (actual_state == exp_state and actual_tool == exp_tool and actual_summary == exp_summary)
    mark = '✓' if ok else '✗'
    if not ok:
        failed += 1
    print(f'  {mark} {label}')
    if not ok:
        print(f'      expected: state={exp_state} tool={exp_tool!r} summary={exp_summary!r}')
        print(f'      actual:   state={actual_state} tool={actual_tool!r} summary={actual_summary!r}')

shutil.rmtree(tmp)
print(f'\n{len(cases) - failed}/{len(cases)} passed')
sys.exit(0 if failed == 0 else 1)