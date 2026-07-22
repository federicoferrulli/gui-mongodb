const fs = require('fs');
const path = require('path');

function walkDir(dir, callback) {
  fs.readdirSync(dir).forEach(f => {
    let dirPath = path.join(dir, f);
    if (fs.statSync(dirPath).isDirectory()) {
      walkDir(dirPath, callback);
    } else if (dirPath.endsWith('.js')) {
      callback(dirPath);
    }
  });
}

const jsFiles = [];
walkDir('public/js', f => jsFiles.push(f));

const allImports = {};

jsFiles.forEach(file => {
  const content = fs.readFileSync(file, 'utf8');
  // Look for import { ... } from './...'
  const importRegex = /import\s+{([^}]+)}\s+from\s+['"]([^'"]+)['"]/g;
  let match;
  while ((match = importRegex.exec(content)) !== null) {
    const importedNames = match[1].split(',').map(s => s.trim());
    let source = match[2];
    // resolve source path relative to current file
    let sourcePath = path.join(path.dirname(file), source);
    if (!allImports[sourcePath]) allImports[sourcePath] = new Set();
    importedNames.forEach(n => {
      // handle 'as' aliases if any
      const name = n.split(' as ')[0].trim();
      allImports[sourcePath].add(name);
    });
  }
});

jsFiles.forEach(file => {
  const content = fs.readFileSync(file, 'utf8');
  const exportRegex = /export\s+(?:function|const|let|var|class)\s+([a-zA-Z0-9_]+)/g;
  let match;
  while ((match = exportRegex.exec(content)) !== null) {
    const exportName = match[1];
    // check if it's imported anywhere
    const isImported = allImports[file] && allImports[file].has(exportName);
    if (!isImported) {
      console.log(`Unused export: ${exportName} in ${file}`);
    }
  }
});
