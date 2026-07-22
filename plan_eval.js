const fs = require('fs');
const content = fs.readFileSync('public/js/utils.js', 'utf8');

const regex = /export function reorderById\([^)]*\)\s*\{[\s\S]*?\n\}/;
const match = regex.exec(content);

if (match) {
    console.log('Match found:');
    console.log(match[0]);
} else {
    console.log('No match found');
}
