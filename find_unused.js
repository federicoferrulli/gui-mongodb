const fs = require('fs');
const content = fs.readFileSync('public/js/utils.js', 'utf8');

const matches = content.matchAll(/(?:export\s+)?function\s+([a-zA-Z0-9_]+)/g);
for (const match of matches) {
  const fn = match[1];
  const count = content.split(fn).length - 1;
  console.log(`${fn}: ${count}`);
}
