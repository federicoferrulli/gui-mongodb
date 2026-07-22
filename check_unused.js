const fs = require('fs');

const fileFuncs = {
  'public/js/colltabs.js': ['switchCollTab', 'closeCollTab'],
  'public/js/connection.js': ['syncConnForm'],
  'public/js/dbtree.js': ['renderCollectionsList', 'loadCollections'],
  'public/js/details.js': ['renderDetails'],
  'public/js/exportimport.js': ['openImportModal'],
  'public/js/grid.js': ['explainQuery', 'deleteDoc', 'deleteSelectedDocs', 'deleteAllWithFilter', 'updateBulkDeleteUI'],
  'public/js/inlineEdit.js': ['buildEditor'],
  'public/js/insert.js': ['insertKindOf', 'insertInputFor', 'addInsertRow', 'insertRowValue', 'buildInsertDoc', 'selectInsertTab'],
  'public/js/live.js': ['togglePolling'],
  'public/js/schema-ops.js': ['openColumnModal'],
  'public/js/uml.js': ['renderUml'],
  'public/js/utils.js': ['ejsonKind', 'simplify', 'hideContextMenu'],
  'public/js/vault.js': ['checkVaultStatus', 'showVaultModal', 'hideVaultModal']
};

for (const [file, funcs] of Object.entries(fileFuncs)) {
  const content = fs.readFileSync(file, 'utf8');
  for (const fn of funcs) {
    const regex = new RegExp(`\\b${fn}\\b`, 'g');
    const matches = [...content.matchAll(regex)];
    // > 1 means it's used internally (1 is the definition itself)
    if (matches.length === 1) {
      console.log(`Completely unused function: ${fn} in ${file}`);
    } else {
      // maybe check if it's only exported but not called
      const calls = matches.filter(m => {
        // simple heuristic: check if next non-whitespace char is '('
        const idx = m.index + fn.length;
        return content.slice(idx).trim().startsWith('(') && !content.slice(0, m.index).trim().endsWith('function');
      });
      if (calls.length === 0) {
        console.log(`Function only referenced (no calls detected): ${fn} in ${file}`);
      }
    }
  }
}
