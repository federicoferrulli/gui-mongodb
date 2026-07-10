'use strict';
// Genera le icone dell'app: public/codedb.ico (favicon + collegamento Windows)
// e public/codedb.png (voce .desktop su Linux). Cilindro database bianco su
// quadrato blu #007acc (accento VSCode), 64x64. Nessuna dipendenza esterna.
// Uso: node tools/genera-icona.js
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const S = 64;
const px = Buffer.alloc(S * S * 4); // RGBA

const BLUE = [0x00, 0x7a, 0xcc, 255];
const WHITE = [255, 255, 255, 255];

function set(x, y, c) {
  if (x < 0 || y < 0 || x >= S || y >= S) return;
  const i = (y * S + x) * 4;
  px[i] = c[0]; px[i + 1] = c[1]; px[i + 2] = c[2]; px[i + 3] = c[3];
}

// Sfondo: quadrato con angoli arrotondati (raggio 12).
const R = 12;
for (let y = 0; y < S; y++) {
  for (let x = 0; x < S; x++) {
    const cx = x < R ? R : (x >= S - R ? S - 1 - R : x);
    const cy = y < R ? R : (y >= S - R ? S - 1 - R : y);
    if ((x - cx) ** 2 + (y - cy) ** 2 <= R * R) set(x, y, BLUE);
  }
}

// Cilindro: corpo pieno bianco tra le due ellissi, poi bande blu di separazione.
const CX = 32, RX = 15, RY = 6.5, TOP = 19, BOT = 44;
const inEllipse = (x, y, cy) => ((x - CX) / RX) ** 2 + ((y - cy) / RY) ** 2 <= 1;
for (let y = 0; y < S; y++) {
  for (let x = 0; x < S; x++) {
    const body = Math.abs(x - CX) <= RX && y >= TOP && y <= BOT;
    if (body || inEllipse(x, y, TOP) || inEllipse(x, y, BOT)) set(x, y, WHITE);
  }
}
// Ellisse superiore ribassata in blu per dare il bordo del "coperchio".
for (let y = 0; y < S; y++) {
  for (let x = 0; x < S; x++) {
    if (inEllipse(x, y, TOP + 3.5) && !inEllipse(x, y, TOP + 1) && y > TOP + 3) set(x, y, BLUE);
  }
}
// Due archi di separazione (solo metà inferiore dell'ellisse).
for (const cy of [29, 37.5]) {
  for (let y = Math.floor(cy); y < cy + RY + 1; y++) {
    for (let x = 0; x < S; x++) {
      const v = ((x - CX) / RX) ** 2 + ((y - cy) / RY) ** 2;
      if (v <= 1 && v >= 0.62) set(x, y, BLUE);
    }
  }
}

// --- PNG ---------------------------------------------------------------
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xFFFFFFFF;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(S, 0); ihdr.writeUInt32BE(S, 4);
ihdr[8] = 8; ihdr[9] = 6; // 8 bit, RGBA
const raw = Buffer.alloc(S * (S * 4 + 1));
for (let y = 0; y < S; y++) {
  raw[y * (S * 4 + 1)] = 0; // filtro none
  px.copy(raw, y * (S * 4 + 1) + 1, y * S * 4, (y + 1) * S * 4);
}
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
  chunk('IHDR', ihdr),
  chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
]);

// --- ICO (PNG incapsulato) ----------------------------------------------
const ico = Buffer.alloc(6 + 16);
ico.writeUInt16LE(0, 0); ico.writeUInt16LE(1, 2); ico.writeUInt16LE(1, 4); // header
ico[6] = S; ico[7] = S;               // 64x64
ico.writeUInt16LE(1, 10);             // planes
ico.writeUInt16LE(32, 12);            // bpp
ico.writeUInt32LE(png.length, 14);    // dimensione
ico.writeUInt32LE(22, 18);            // offset

const pub = path.join(__dirname, '..', 'public');
fs.writeFileSync(path.join(pub, 'codedb.ico'), Buffer.concat([ico, png]));
fs.writeFileSync(path.join(pub, 'codedb.png'), png);
console.log('Generati public/codedb.ico e public/codedb.png');
