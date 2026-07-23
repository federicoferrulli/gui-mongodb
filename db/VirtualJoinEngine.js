'use strict';

const EJSON = require('bson').EJSON;

/**
 * Motore per Virtual JOINs e Aggregazioni Cross-Database (MySQL <-> MongoDB)
 */
class VirtualJoinEngine {
  /**
   * Esegue una query virtual join cross-database
   * @param {Object} spec Specifica del Virtual Join
   * @param {DbStrategy} strategyA Istanza della prima strategia
   * @param {DbStrategy} strategyB Istanza della seconda strategia
   * @returns {Promise<Array>} Risultato del merge in memoria
   */
  static async execute(spec, strategyA, strategyB) {
    if (!spec || !spec.virtualJoin) {
      throw new Error('Formato query Virtual Join non valido. Inserisci una struttura {"virtualJoin": ...}');
    }

    const vj = spec.virtualJoin;
    const { sourceA, sourceB, on, as = 'joined_data', maxPayloadSize = 1000 } = vj;

    if (!sourceA || !sourceB || !on || !on.leftKey || !on.rightKey) {
      throw new Error('Definizione Virtual Join incompleta: specificare sourceA, sourceB, on.leftKey e on.rightKey.');
    }

    // Fetching dati Sorgente A (SQL o MongoDB)
    let rowsA = [];
    if (sourceA.dbType === 'mysql' || strategyA.type === 'mysql') {
      const sql = sourceA.query || `SELECT * FROM \`${sourceA.table}\` LIMIT ${maxPayloadSize}`;
      const resA = await strategyA.collectionAggregate(sourceA.db, sourceA.table, { pipeline: sql });
      rowsA = resA.docs || [];
    } else {
      const pipelineStr = typeof sourceA.query === 'string' ? sourceA.query : JSON.stringify(sourceA.query || []);
      const resA = await strategyA.collectionAggregate(sourceA.db, sourceA.collection, { pipeline: pipelineStr });
      rowsA = resA.docs || [];
    }

    if (!rowsA.length) return [];

    // Estrazione chiavi per la query guidata sulla Sorgente B (Batch In-Memory Lookup)
    const joinKeys = new Set();
    rowsA.forEach((row) => {
      const val = row[on.leftKey];
      if (val !== undefined && val !== null) {
        joinKeys.add(String(val));
      }
    });

    if (joinKeys.size === 0) return rowsA;

    // Fetching dati Sorgente B
    let rowsB = [];
    const keysArray = Array.from(joinKeys);

    if (sourceB.dbType === 'mongodb' || strategyB.type === 'mongodb') {
      // Per MongoDB: pipeline $match $in
      const oidsOrKeys = keysArray.map((k) => {
        if (/^[0-9a-fA-F]{24}$/.test(k)) {
          try { return { $oid: k }; } catch { return k; }
        }
        return k;
      });
      const matchPipeline = [
        { $match: { [on.rightKey]: { $in: oidsOrKeys } } },
        { $limit: maxPayloadSize }
      ];
      const resB = await strategyB.collectionAggregate(sourceB.db, sourceB.collection, { pipeline: JSON.stringify(matchPipeline) });
      rowsB = resB.docs || [];
    } else {
      // Per MySQL: WHERE rightKey IN (...)
      const escapedKeys = keysArray.map((k) => `'${String(k).replace(/'/g, "\\'")}'`).join(',');
      const sql = `SELECT * FROM \`${sourceB.table}\` WHERE \`${on.rightKey}\` IN (${escapedKeys}) LIMIT ${maxPayloadSize}`;
      const resB = await strategyB.collectionAggregate(sourceB.db, sourceB.table, { pipeline: sql });
      rowsB = resB.docs || [];
    }

    // Indicizzazione Sorgente B in una Map in-memory per O(1) lookup
    const mapB = new Map();
    rowsB.forEach((bDoc) => {
      const bKeyVal = bDoc[on.rightKey];
      let bKeyStr = String(bKeyVal);
      if (bKeyVal && typeof bKeyVal === 'object' && bKeyVal.$oid) {
        bKeyStr = bKeyVal.$oid;
      }
      mapB.set(bKeyStr, bDoc);
    });

    // Merge in memoria
    const mergedResults = rowsA.map((aDoc) => {
      const aKeyVal = aDoc[on.leftKey];
      let aKeyStr = String(aKeyVal);
      if (aKeyVal && typeof aKeyVal === 'object' && aKeyVal.$oid) {
        aKeyStr = aKeyVal.$oid;
      }

      const matchB = mapB.get(aKeyStr) || null;
      return {
        ...aDoc,
        [as]: matchB
      };
    });

    return mergedResults;
  }
}

module.exports = VirtualJoinEngine;
