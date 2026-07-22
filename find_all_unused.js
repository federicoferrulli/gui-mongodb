const fs = require('fs');

const utils = fs.readFileSync('public/js/utils.js', 'utf8');
const regex = /(?:export\s+)?(?:async\s+)?function\s+([a-zA-Z0-9_]+)/g;

let match;
const funcs = [];
while ((match = regex.exec(utils)) !== null) {
  funcs.push(match[1]);
}

const child_process = require('child_process');

funcs.forEach(fn => {
  const out = child_process.execSync(`grep -rnw "${fn}" . || true`).toString();
  const lines = out.trim().split('\n').filter(l => l.length > 0);

  // if lines only contain occurrences in utils.js where it's defined
  const nonDef = lines.filter(l => !l.includes('public/js/utils.js:') || (l.includes('public/js/utils.js:') && !l.includes(`function ${fn}`)));

  if (nonDef.length === 0) {
    console.log(`COMPLETELY UNUSED: ${fn}`);
  }
});
