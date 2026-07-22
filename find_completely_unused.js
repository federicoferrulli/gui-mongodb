const fs = require('fs');
const path = require('path');

function walkDir(dir, callback) {
  fs.readdirSync(dir).forEach(f => {
    let dirPath = path.join(dir, f);
    let isDirectory = fs.statSync(dirPath).isDirectory();
    isDirectory ? walkDir(dirPath, callback) : callback(path.join(dir, f));
  });
}

const jsFiles = [];
walkDir('public/js', (filepath) => {
  if (filepath.endsWith('.js')) jsFiles.push(filepath);
});

const allContent = jsFiles.map(f => fs.readFileSync(f, 'utf8')).join('\n');

for (const file of jsFiles) {
  const content = fs.readFileSync(file, 'utf8');
  const matches = content.matchAll(/(?:export\s+)?(?:async\s+)?function\s+([a-zA-Z0-9_]+)/g);
  for (const match of matches) {
    const fn = match[1];
    const regex = new RegExp(`\\b${fn}\\b`, 'g');
    const globalCount = [...allContent.matchAll(regex)].length;
    // We expect at least 1 match for the declaration itself.
    if (globalCount === 1) {
      console.log(`Completely unused function: ${fn} in ${file}`);
    }
  }
}
