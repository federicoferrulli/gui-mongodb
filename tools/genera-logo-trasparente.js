'use strict';
// Genera public/logo.png (256x256) rimuovendo lo sfondo bianco esterno dal logo originale.
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

function generateTransparentLogo() {
  const masterPath = path.join(__dirname, 'master-logo.png');
  if (!fs.existsSync(masterPath)) {
    console.error('File non trovato:', masterPath);
    return;
  }
  const buf = fs.readFileSync(masterPath);

  let pos = 8;
  let width = 0, height = 0;
  const idatChunks = [];
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString('ascii', pos + 4, pos + 8);
    const data = buf.slice(pos + 8, pos + 8 + len);
    pos += 12 + len;
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
    } else if (type === 'IDAT') {
      idatChunks.push(data);
    }
  }

  const rawScanlines = zlib.inflateSync(Buffer.concat(idatChunks));

  function paethPredictor(a, b, c) {
    const p = a + b - c;
    const pa = Math.abs(p - a);
    const pb = Math.abs(p - b);
    const pc = Math.abs(p - c);
    if (pa <= pb && pa <= pc) return a;
    if (pb <= pc) return b;
    return c;
  }

  const bpp = 4;
  const stride = width * bpp;
  const pixels = Buffer.alloc(width * height * bpp);

  for (let y = 0; y < height; y++) {
    const filterType = rawScanlines[y * (stride + 1)];
    const lineOffset = y * (stride + 1) + 1;
    const outOffset = y * stride;
    for (let x = 0; x < stride; x++) {
      const rawVal = rawScanlines[lineOffset + x];
      const a = (x >= bpp) ? pixels[outOffset + x - bpp] : 0;
      const b = (y > 0) ? pixels[(y - 1) * stride + x] : 0;
      const c = (x >= bpp && y > 0) ? pixels[(y - 1) * stride + x - bpp] : 0;
      let reconstructed = 0;
      if (filterType === 0) reconstructed = rawVal;
      else if (filterType === 1) reconstructed = (rawVal + a) & 0xff;
      else if (filterType === 2) reconstructed = (rawVal + b) & 0xff;
      else if (filterType === 3) reconstructed = (rawVal + Math.floor((a + b) / 2)) & 0xff;
      else if (filterType === 4) reconstructed = (rawVal + paethPredictor(a, b, c)) & 0xff;
      pixels[outOffset + x] = reconstructed;
    }
  }

  const visited = new Uint8Array(width * height);
  const queue = [];

  function isWhite(x, y) {
    const i = (y * width + x) * 4;
    return pixels[i] >= 235 && pixels[i+1] >= 235 && pixels[i+2] >= 235;
  }

  for (let x = 0; x < width; x++) {
    if (isWhite(x, 0)) { visited[0 * width + x] = 1; queue.push(x, 0); }
    if (isWhite(x, height - 1)) { visited[(height - 1) * width + x] = 1; queue.push(x, height - 1); }
  }
  for (let y = 0; y < height; y++) {
    if (!visited[y * width + 0] && isWhite(0, y)) { visited[y * width + 0] = 1; queue.push(0, y); }
    if (!visited[y * width + (width - 1)] && isWhite(width - 1, y)) { visited[y * width + (width - 1)] = 1; queue.push(width - 1, y); }
  }

  let head = 0;
  const dx = [1, -1, 0, 0, 1, -1, 1, -1];
  const dy = [0, 0, 1, -1, 1, 1, -1, -1];

  while (head < queue.length) {
    const cx = queue[head++];
    const cy = queue[head++];
    for (let i = 0; i < 4; i++) {
      const nx = cx + dx[i];
      const ny = cy + dy[i];
      if (nx >= 0 && nx < width && ny >= 0 && ny < height) {
        const idx = ny * width + nx;
        if (!visited[idx] && isWhite(nx, ny)) {
          visited[idx] = 1;
          queue.push(nx, ny);
        }
      }
    }
  }

  const outBuf = Buffer.alloc(width * height * 4);
  pixels.copy(outBuf);

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = y * width + x;
      const i = idx * 4;
      if (visited[idx]) {
        let hasLogoNeighbor = false;
        for (let k = 0; k < 8; k++) {
          const nx = x + dx[k];
          const ny = y + dy[k];
          if (nx >= 0 && nx < width && ny >= 0 && ny < height) {
            if (!visited[ny * width + nx]) {
              hasLogoNeighbor = true;
              break;
            }
          }
        }

        if (!hasLogoNeighbor) {
          outBuf[i + 3] = 0;
        } else {
          const r = pixels[i], g = pixels[i+1], b = pixels[i+2];
          const minC = Math.min(r, g, b);
          const alpha = Math.max(0, Math.min(255, Math.round(255 * (255 - minC) / 50)));
          outBuf[i + 3] = alpha;
          if (alpha > 0) {
            const aNorm = alpha / 255;
            outBuf[i] = Math.max(0, Math.min(255, Math.round((r - 255 * (1 - aNorm)) / aNorm)));
            outBuf[i + 1] = Math.max(0, Math.min(255, Math.round((g - 255 * (1 - aNorm)) / aNorm)));
            outBuf[i + 2] = Math.max(0, Math.min(255, Math.round((b - 255 * (1 - aNorm)) / aNorm)));
          }
        }
      } else {
        outBuf[i + 3] = 255;
      }
    }
  }

  const minX = 347, maxX = 676;
  const minY = 115, maxY = 444;
  const cropW = maxX - minX + 1;
  const cropH = maxY - minY + 1;
  const padding = 10;
  const side = cropW + padding * 2;

  const squareBuf = Buffer.alloc(side * side * 4);

  for (let y = 0; y < cropH; y++) {
    const srcY = minY + y;
    const dstY = padding + y;
    for (let x = 0; x < cropW; x++) {
      const srcX = minX + x;
      const dstX = padding + x;
      const srcIdx = (srcY * width + srcX) * 4;
      const dstIdx = (dstY * side + dstX) * 4;
      outBuf.copy(squareBuf, dstIdx, srcIdx, srcIdx + 4);
    }
  }

  function resize(srcBuf, srcSize, dstSize) {
    const dstBuf = Buffer.alloc(dstSize * dstSize * 4);
    const scale = srcSize / dstSize;
    for (let dy = 0; dy < dstSize; dy++) {
      for (let dx = 0; dx < dstSize; dx++) {
        const gx = (dx + 0.5) * scale - 0.5;
        const gy = (dy + 0.5) * scale - 0.5;
        const gxi = Math.max(0, Math.min(srcSize - 2, Math.floor(gx)));
        const gyi = Math.max(0, Math.min(srcSize - 2, Math.floor(gy)));
        const fx = gx - gxi;
        const fy = gy - gyi;
        const dstIdx = (dy * dstSize + dx) * 4;

        for (let c = 0; c < 4; c++) {
          const c00 = srcBuf[(gyi * srcSize + gxi) * 4 + c];
          const c10 = srcBuf[(gyi * srcSize + gxi + 1) * 4 + c];
          const c01 = srcBuf[((gyi + 1) * srcSize + gxi) * 4 + c];
          const c11 = srcBuf[((gyi + 1) * srcSize + gxi + 1) * 4 + c];
          const top = c00 + fx * (c10 - c00);
          const bot = c01 + fx * (c11 - c01);
          const val = top + fy * (bot - top);
          dstBuf[dstIdx + c] = Math.max(0, Math.min(255, Math.round(val)));
        }
      }
    }
    return dstBuf;
  }

  const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = (c & 1) ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c >>> 0;
    }
    return t;
  })();
  function crc32(b) {
    let c = 0xFFFFFFFF;
    for (const x of b) c = CRC_TABLE[(c ^ x) & 0xFF] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
  }
  function chunk(type, data) {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
    return Buffer.concat([len, td, crc]);
  }

  function encodePNG(rgbaBuf, S) {
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(S, 0); ihdr.writeUInt32BE(S, 4);
    ihdr[8] = 8; ihdr[9] = 6;
    const raw = Buffer.alloc(S * (S * 4 + 1));
    for (let y = 0; y < S; y++) {
      raw[y * (S * 4 + 1)] = 0;
      rgbaBuf.copy(raw, y * (S * 4 + 1) + 1, y * S * 4, (y + 1) * S * 4);
    }
    return Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
      chunk('IHDR', ihdr),
      chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
      chunk('IEND', Buffer.alloc(0)),
    ]);
  }

  const buf256 = resize(squareBuf, side, 256);
  const png256 = encodePNG(buf256, 256);

  const logoPath = path.join(__dirname, '..', 'public', 'logo.png');
  fs.writeFileSync(logoPath, png256);
  console.log('Generato public/logo.png con sfondo TRASPARENTE.');

  return { squareBuf, side, resize, encodePNG };
}

if (require.main === module) {
  generateTransparentLogo();
}

module.exports = { generateTransparentLogo };

