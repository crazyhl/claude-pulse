// 调试: 查看 JSONL 末尾的实际内容
const fs = require('fs');
const path = require('path');
const os = require('os');

const dir = path.join(os.homedir(), '.claude', 'projects');
const files = fs.readdirSync(dir, { withFileTypes: true })
  .filter(d => d.isDirectory())
  .map(d => path.join(dir, d.name));

let latest = null, latestMtime = 0;
for (const d of files) {
  for (const f of fs.readdirSync(d)) {
    if (!f.endsWith('.jsonl')) continue;
    const p = path.join(d, f);
    const st = fs.statSync(p);
    if (st.mtimeMs > latestMtime) { latestMtime = st.mtimeMs; latest = p; }
  }
}

console.log('最新文件:', latest);
console.log('mtime:', new Date(latestMtime).toISOString());
console.log('ageMs:', Date.now() - latestMtime);
console.log('size:', fs.statSync(latest).size, 'bytes');
console.log('');

// 读最后 4KB
const size = fs.statSync(latest).size;
const buf = Buffer.alloc(Math.min(size, 4096));
const fd = fs.openSync(latest, 'r');
fs.readSync(fd, buf, 0, buf.length, size - buf.length);
fs.closeSync(fd);

const text = buf.toString('utf8');
const lines = text.split('\n').filter(Boolean);

console.log(`=== 最后 ${lines.length} 条 ===`);
for (let i = lines.length - 8; i < lines.length; i++) {
  if (i < 0) continue;
  const line = lines[i];
  let obj;
  try { obj = JSON.parse(line); } catch { console.log(`[${i}] PARSE ERR`); continue; }
  const t = obj.type;
  const msg = obj.message;
  const content = msg && msg.content;
  const ageMs = latestMtime + 0; // 粗略
  if (t === 'user' && Array.isArray(content)) {
    for (const b of content.slice(-2)) {
      if (b.type === 'tool_result') {
        console.log(`  [${i}] user:tool_result is_error=${b.is_error} content=${String(b.content).slice(0,80).replace(/\s+/g,' ')}`);
      } else if (b.type === 'text') {
        console.log(`  [${i}] user:text ${JSON.stringify((b.text||'').slice(0,60))}`);
      }
    }
  } else if (t === 'assistant' && Array.isArray(content)) {
    for (const b of content.slice(-2)) {
      if (b.type === 'tool_use') {
        console.log(`  [${i}] assistant:tool_use name=${b.name} input_keys=[${Object.keys(b.input||{}).join(',')}]`);
      } else if (b.type === 'text') {
        console.log(`  [${i}] assistant:text ${JSON.stringify((b.text||'').slice(0,60))}`);
      }
    }
  } else if (t === 'system') {
    console.log(`  [${i}] system subtype=${obj.subtype}`);
  } else if (t === 'result') {
    console.log(`  [${i}] result subtype=${obj.subtype} is_error=${obj.is_error}`);
  } else {
    console.log(`  [${i}] type=${t}`);
  }
}
