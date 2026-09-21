// 生成 Prompt Vault 应用图标（纯 Node，无依赖）
// 输出：icons/icon.png（256）、icons/128x128.png、icons/32x32.png、icons/icon.ico
const zlib = require('zlib');
const fs = require('fs');
const path = require('path');

/* ── PNG 构造 ── */
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const tb = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([tb, data])));
  return Buffer.concat([len, tb, data, crc]);
}
function makePNG(size, pixelFn) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6; // 8-bit RGBA
  const raw = Buffer.alloc(size * (1 + size * 4));
  let o = 0;
  for (let y = 0; y < size; y++) {
    raw[o++] = 0;
    for (let x = 0; x < size; x++) {
      const [r, g, b, a] = pixelFn(x, y);
      raw[o++] = r; raw[o++] = g; raw[o++] = b; raw[o++] = a;
    }
  }
  const idat = zlib.deflateSync(raw);
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}
function makeICO(png) {
  const h = Buffer.alloc(22);
  h.writeUInt16LE(0, 0); h.writeUInt16LE(1, 2); h.writeUInt16LE(1, 4); // ICONDIR
  h[6] = 0; h[7] = 0;    // 256x256
  h[8] = 0; h[9] = 0;
  h.writeUInt16LE(1, 10); h.writeUInt16LE(32, 12);
  h.writeUInt32LE(png.length, 14); h.writeUInt32LE(22, 18);
  return Buffer.concat([h, png]);
}

/* ── 绘制：蓝紫渐变 + 白色卡片 + 星芒品牌符号 ── */
function pixelFnFactory(S) {
  // 颜色
  // 与 Chrome 插件视觉统一：蓝色背景 + 品牌蓝符号。
  const c1 = [37, 99, 235], c2 = [59, 130, 246]; // 渐变两端
  const cardCol = [255, 255, 255];
  const lineCol = [69, 102, 230];
  const pad = S * 0.22;
  const cardX0 = pad, cardY0 = pad, cardX1 = S - pad, cardY1 = S - pad;
  const radius = S * 0.12;
  const inRoundRect = (x, y) => {
    const cx = Math.max(cardX0 + radius, Math.min(x, cardX1 - radius));
    const cy = Math.max(cardY0 + radius, Math.min(y, cardY1 - radius));
    const dx = x - cx, dy = y - cy;
    const d2 = dx * dx + dy * dy;
    return x >= cardX0 && x <= cardX1 && y >= cardY0 && y <= cardY1
      && (d2 <= radius * radius || (x >= cardX0 + radius && x <= cardX1 - radius) || (y >= cardY0 + radius && y <= cardY1 - radius));
  };
  const starCx = S * 0.50, starCy = S * 0.36;
  const inStar = (x, y) => {
    const dx = Math.abs(x - starCx), dy = Math.abs(y - starCy);
    return (dx < S * 0.045 && dy < S * 0.18) || (dy < S * 0.045 && dx < S * 0.18)
      || (Math.abs(dx - dy) < S * 0.035 && dx < S * 0.13);
  };
  const lw = Math.max(1, S * 0.035);
  const gap = S * 0.07;
  const lx = cardX0 + S * 0.14, ly0 = cardY0 + S * 0.58;
  const lines = [[S * 0.52, ly0], [S * 0.42, ly0 + gap], [S * 0.48, ly0 + 2 * gap]];
  const inLine = (x, y) => lines.some(([w, yTop]) => x >= lx && x <= lx + w && y >= yTop && y <= yTop + lw);

  return (x, y) => {
    const t = (x + y) / (2 * S);
    const bg = [
      Math.round(c1[0] + (c2[0] - c1[0]) * t),
      Math.round(c1[1] + (c2[1] - c1[1]) * t),
      Math.round(c1[2] + (c2[2] - c1[2]) * t),
    ];
    if (inStar(x, y)) return [...lineCol, 255];
    if (inLine(x, y)) return [...lineCol, 255];
    if (inRoundRect(x, y)) return [...cardCol, 240];
    return [...bg, 255];
  };
}

/* ── 输出 ── */
const outDir = path.join(__dirname, '..', 'src-tauri', 'icons');
fs.mkdirSync(outDir, { recursive: true });

for (const size of [256, 128, 32, 16]) {
  const png = makePNG(size, pixelFnFactory(size));
  const name = size === 256 ? 'icon.png' : `${size}x${size}.png`;
  fs.writeFileSync(path.join(outDir, name), png);
  console.log('created:', name, png.length, 'bytes');
}
const iconPng = makePNG(256, pixelFnFactory(256));
fs.writeFileSync(path.join(outDir, 'icon.ico'), makeICO(iconPng));
console.log('created: icon.ico', 22 + iconPng.length, 'bytes');
