// 生成托盘图标: 6 个状态 × 2 变体(filled / hollow) × 2 尺寸
// 颜色直接烘进 PNG(非 template),确保 macOS 也能看到颜色
const fs = require('fs');
const path = require('path');
const { PNG } = require('pngjs');

const OUT_DIR = path.join(__dirname, '..', 'assets');
fs.mkdirSync(OUT_DIR, { recursive: true });

/**
 * 绘制一个圆: filled=实心, hollow=圆环
 */
function makeCircle(size, [r, g, b], filled) {
  const png = new PNG({ width: size, height: size });
  const cx = size / 2;
  const cy = size / 2;
  const outerR = size * 0.42;   // 外半径
  const innerR = size * 0.30;   // 内半径(空心环的内边)
  const ringHalf = (outerR - innerR) / 2; // 环中线到外/内的距离

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const idx = (size * y + x) << 2;
      const dx = x + 0.5 - cx;
      const dy = y + 0.5 - cy;
      const dist = Math.sqrt(dx * dx + dy * dy);

      let a = 0;
      if (filled) {
        // 实心: 圆形内有 alpha
        if (dist <= outerR) a = 255;
      } else {
        // 圆环: 在 outerR ± ringHalf 范围内
        if (Math.abs(dist - (outerR + innerR) / 2) <= ringHalf) a = 255;
      }

      png.data[idx] = r;
      png.data[idx + 1] = g;
      png.data[idx + 2] = b;
      png.data[idx + 3] = a;
    }
  }
  return png;
}

// 状态定义
const STATES = [
  { name: 'gray',     color: [140, 140, 140], filled: true  }, // offline
  { name: 'yellow',   color: [230, 184,   0], filled: true  }, // running / confirm-on
  { name: 'yellowDim',color: [230, 184,   0], filled: false }, // confirm-off (flashing)
  { name: 'green',    color: [ 46, 168,  80], filled: true  }, // awaiting-input / working-on
  { name: 'greenDim', color: [ 46, 168,  80], filled: false }, // working-off (flashing)
  { name: 'blue',     color: [170,  85, 255], filled: true  }, // completed
  { name: 'red',      color: [231,  76,  60], filled: true  }, // error-on
  { name: 'redDim',   color: [231,  76,  60], filled: false }, // error-off (flashing)
];

function writePng(png, filename) {
  return new Promise((resolve, reject) => {
    const out = path.join(OUT_DIR, filename);
    const stream = png.pack().pipe(fs.createWriteStream(out));
    stream.on('finish', () => { console.log('wrote', out); resolve(); });
    stream.on('error', reject);
  });
}

(async () => {
  for (const state of STATES) {
    for (const size of [16, 32]) {
      const png = makeCircle(size, state.color, state.filled);
      const suffix = size === 32 ? '@2x' : '';
      await writePng(png, `tray-${state.name}${suffix}.png`);
    }
  }

  // 应用图标(打包用,大尺寸)
  await writePng(makeCircle(256, [46, 168, 80], true), 'icon.png');
  await writePng(makeCircle(512, [46, 168, 80], true), 'icon@2x.png');
})();
