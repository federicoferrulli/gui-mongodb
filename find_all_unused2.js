const fs = require('fs');

const jsFiles = [];
function walkDir(dir) {
  fs.readdirSync(dir).forEach(f => {
    let dirPath = dir + '/' + f;
    let isDirectory = fs.statSync(dirPath).isDirectory();
    if (isDirectory && !dirPath.includes('node_modules') && !dirPath.includes('.git')) {
        walkDir(dirPath);
    } else if (dirPath.endsWith('.js') || dirPath.endsWith('.html')) {
        jsFiles.push(dirPath);
    }
  });
}
walkDir('.');

const allContent = jsFiles.map(f => fs.readFileSync(f, 'utf8')).join('\n');

const utils = fs.readFileSync('public/js/utils.js', 'utf8');
const regex = /(?:export\s+)?(?:async\s+)?function\s+([a-zA-Z0-9_]+)/g;

let match;
while ((match = regex.exec(utils)) !== null) {
  const fn = match[1];
  const count = [...allContent.matchAll(new RegExp(`\\b${fn}\\b`, 'g'))].length;
  console.log(`${fn}: ${count}`);
}
