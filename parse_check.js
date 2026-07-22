const fs = require('fs');

const content = fs.readFileSync('public/js/utils.js', 'utf8');
const lines = content.split('\n');

for (let i = 0; i < lines.length; i++) {
  if (lines[i].includes('export function reorderById')) {
    console.log(`Found at line ${i + 1}`);
    for (let j = Math.max(0, i - 15); j < Math.min(lines.length, i + 5); j++) {
      console.log(`${j + 1}: ${lines[j]}`);
    }
    break;
  }
}
