'use strict';

const assert = require('assert');
const path = require('path');
const fs = require('fs');
const VirtualJoinEngine = require('../db/VirtualJoinEngine');

console.log('--- Test Unitari CodeDB ---');

// Test 1: VirtualJoinEngine check spec validation
(async () => {
  try {
    await VirtualJoinEngine.execute(null, null, null);
    assert.fail('Dovrebbe lanciare errore su spec nulla');
  } catch (err) {
    assert.strictEqual(err.message, 'Formato query Virtual Join non valido. Inserisci una struttura {"virtualJoin": ...}');
    console.log('  OK   VirtualJoinEngine spec null check passed');
  }

  try {
    await VirtualJoinEngine.execute({ virtualJoin: {} }, null, null);
    assert.fail('Dovrebbe lanciare errore su spec incompleta');
  } catch (err) {
    assert.strictEqual(err.message, 'Definizione Virtual Join incompleta: specificare sourceA, sourceB, on.leftKey e on.rightKey.');
    console.log('  OK   VirtualJoinEngine spec incomplete check passed');
  }

  // Test 2: Controllo presenza bin/codedb.js e electron-main.js
  const binFile = path.join(__dirname, '..', 'bin', 'codedb.js');
  assert(fs.existsSync(binFile), 'bin/codedb.js deve esistere');
  console.log('  OK   bin/codedb.js file check passed');

  const electronFile = path.join(__dirname, '..', 'electron-main.js');
  assert(fs.existsSync(electronFile), 'electron-main.js deve esistere');
  console.log('  OK   electron-main.js file check passed');

  console.log('\nTutti i test unitari superati con successo!');
})();
