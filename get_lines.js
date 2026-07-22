const fs = require('fs');
const c = fs.readFileSync('public/js/utils.js', 'utf8').split('\n');
console.log("Lines 205-215:");
for (let i = 205; i <= 215; i++) {
  console.log(c[i-1]);
}
