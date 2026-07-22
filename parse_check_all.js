const fs = require('fs');

const jsFiles = [];
function walkDir(dir) {
  fs.readdirSync(dir).forEach(f => {
    let dirPath = dir + '/' + f;
    let isDirectory = fs.statSync(dirPath).isDirectory();
    isDirectory ? walkDir(dirPath) : (dirPath.endsWith('.js') && jsFiles.push(dirPath));
  });
}
walkDir('.');

for (const file of jsFiles) {
  if (file.includes('node_modules')) continue;
  const content = fs.readFileSync(file, 'utf8');
  if (content.includes('return { db: p[0], coll: p[1] }')) {
    console.log(`Found db: p[0] in ${file}`);
  }
}
