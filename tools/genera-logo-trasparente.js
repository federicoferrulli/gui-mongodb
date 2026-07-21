'use strict';
// Genera public/logo.png: logo database con sfondo TRASPARENTE per il README.
// Dimensione 256x256 per alta risoluzione, nessuna dipendenza esterna (solo node/zlib).
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const S = 256;
const px = Buffer.alloc(S * S * 4); // Inizializzato a 0 = trasparente (RGBA 0,0,0,0)

const BLUE = [0x00, 0x7a, 0xcc, 255]; // Accento blu #007acc
const LIGHT_BLUE = [0x38, 0xbd, 0xf8, 255]; // Azzurro brillante
const WHITE = [255, 255, 255, 255];

function set(x, y, c) {
  if (x < 0 || y < 0 || x >= S || y >= S) return;
  const i = (y * S + x) * 4;
  px[i] = c[0]; px[i + 1] = c[1]; px[i + 2] = c[2]; px[i + 3] = c[3];
}

// Parametri del cilindro database (scalati su 256x256)
const CX = 128, RX = 90, RY = 36, TOP = 50, BOT = 206;
const inEllipse = (x, y, cy, rx = RX, ry = RY) => ((x - CX) / rx) ** 2 + ((y - cy) / ry) ** 2 <= 1;

// 1. Disegna il corpo principale del cilindro in blu (#007acc)
for (let y = 0; y < S; y++) {
  for (let x = 0; x < S; x++) {
    const body = Math.abs(x - CX) <= RX && y >= TOP && y <= BOT;
    if (body || inEllipse(x, y, TOP) || inEllipse(x, y, BOT)) {
      set(x, y, BLUE);
    }
  }
}

// 2. Disegna il "coperchio" superiore in azzurro chiaro per dare profondità 3D
for (let y = 0; y < S; y++) {
  for (let x = 0; x < S; x++) {
    if (inEllipse(x, y, TOP, RX - 3, RY - 3)) {
      set(x, y, LIGHT_BLUE);
    }
  }
}

// 3. Linee di separazione dei 3 livelli del cilindro (in bianco/trasparente scanalato)
const Y_LEVELS = [98, 150];
for (const cy of Y_LEVELS) {
  for (let y = Math.floor(cy - RY); y <= Math.ceil(cy + RY); y++) {
    for (let x = 0; x < S; x++) {
      if (y >= TOP) {
        const v = ((x - CX) / RX) ** 2 + ((y - cy) / RY) ** 2;
        // Bordo dell'ellisse di separazione
        if (v <= 1 && v >= 0.78 && y > cy) {
          set(x, y, WHITE);
        }
      }
    }
  }
}

// --- Generazione PNG ---------------------------------------------------
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
ihdr[8] = 8; ihdr[9] = 6; // 8-bit RGBA

const raw = Buffer.alloc(S * (S * 4 + 1));
for (let y = 0; y < S; y++) {
  raw[y * (S * 4 + 1)] = 0; // Filter: none
  px.copy(raw, y * (S * 4 + 1) + 1, y * S * 4, (y + 1) * S * 4);
}

const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
  chunk('IHDR', ihdr),
  chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
]);

const logoPath = path.join(__dirname, '..', 'public', 'logo.png');
fs.writeFileSync(logoPath, png);
console.log('Generato public/logo.png con sfondo TRASPARENTE.');
