'use strict';

const MongoDbStrategy = require('./MongoDbStrategy');
const MySqlStrategy = require('./MySqlStrategy');

const STRATEGIES = {
  mongodb: MongoDbStrategy,
  mysql: MySqlStrategy,
};

// Istanzia la strategia per il tipo di database richiesto.
// dbType assente = 'mongodb', per retrocompatibilità con le connessioni
// salvate prima dell'introduzione del campo.
function getStrategy(dbType) {
  const key = String(dbType || 'mongodb').trim().toLowerCase();
  const Strategy = STRATEGIES[key];
  if (!Strategy) throw new Error(`Tipo di database non supportato: "${dbType}"`);
  return new Strategy();
}

module.exports = { getStrategy, SUPPORTED_TYPES: Object.keys(STRATEGIES) };
