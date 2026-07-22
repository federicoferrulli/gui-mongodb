const fs = require('fs');

const file = 'public/js/utils.js';
const content = fs.readFileSync(file, 'utf8');
const lines = content.split('\n');
console.log(lines[209]); // export function reorderById...
console.log(lines[208]);
console.log(lines[207]);
