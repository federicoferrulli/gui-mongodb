'use strict';

const assert = require('assert');
const path = require('path');
const fs = require('fs');
const VirtualJoinEngine = require('../db/VirtualJoinEngine');

console.log('--- Test Unitari CodeDB ---');

(async () => {
  // Test 1: VirtualJoinEngine check spec validation
  try {
    await VirtualJoinEngine.execute(null, null, null);
    assert.fail('Dovrebbe lanciare errore su spec nulla');
  } catch (err) {
    assert.strictEqual(err.message, 'Formato query Virtual Join non valido. Inserisci una struttura {"virtualJoin": ...}');
    console.log('  OK   VirtualJoinEngine spec null check passed');
  }

  // Test 2: Controllo Docker files
  const dockerfile = path.join(__dirname, '..', 'Dockerfile');
  assert(fs.existsSync(dockerfile), 'Dockerfile deve esistere');
  console.log('  OK   Dockerfile file check passed');

  const dockerCompose = path.join(__dirname, '..', 'docker-compose.yml');
  assert(fs.existsSync(dockerCompose), 'docker-compose.yml deve esistere');
  console.log('  OK   docker-compose.yml file check passed');

  console.log('\nTutti i test unitari superati con successo!');
})();
