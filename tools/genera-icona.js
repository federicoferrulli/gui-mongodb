'use strict';
// Genera le icone dell'app: public/codedb.ico (favicon + collegamento Windows)
// e public/codedb.png (voce .desktop su Linux e icona PWA/UI).
const fs = require('fs');
const path = require('path');
const { generateTransparentLogo } = require('./genera-logo-trasparente');

function generateIconAssets() {
  const { squareBuf, side, resize, encodePNG } = generateTransparentLogo();
  const pub = path.join(__dirname, '..', 'public');

  const buf128 = resize(squareBuf, side, 128);
  const buf64  = resize(squareBuf, side, 64);

  const png128 = encodePNG(buf128, 128);
  const png64  = encodePNG(buf64, 64);

  // --- ICO (PNG 64x64 incapsulato) ---------------------------------------
  const S = 64;
  const ico = Buffer.alloc(6 + 16);
  ico.writeUInt16LE(0, 0); ico.writeUInt16LE(1, 2); ico.writeUInt16LE(1, 4); // header
  ico[6] = S; ico[7] = S;               // 64x64
  ico.writeUInt16LE(1, 10);             // planes
  ico.writeUInt16LE(32, 12);            // bpp
  ico.writeUInt32LE(png64.length, 14);  // dimensione
  ico.writeUInt32LE(22, 18);            // offset

  fs.writeFileSync(path.join(pub, 'codedb.ico'), Buffer.concat([ico, png64]));
  fs.writeFileSync(path.join(pub, 'codedb.png'), png128);
  console.log('Generati public/codedb.ico e public/codedb.png');
}

if (require.main === module) {
  generateIconAssets();
}

module.exports = { generateIconAssets };

