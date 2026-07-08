'use strict';

/* ---------------------------------------------------------------------------
 * Strategy Pattern: interfaccia comune a tutti i DBMS supportati.
 *
 * Ogni metodo riceve dati "grezzi" dal payload socket e ritorna l'oggetto da
 * unire alla risposta { ok: true, ... }; in caso di problema lancia un Error
 * con il messaggio (in italiano) da mostrare all'utente.
 * ------------------------------------------------------------------------- */

function unsupported() {
  return new Error('Operazione non supportata da questo tipo di database.');
}

class DbStrategy {
  /** Identificatore del tipo di database (es. 'mongodb', 'mysql'). */
  get type() { return 'unknown'; }

  /** Apre la connessione; lancia se le credenziali o l'host non sono validi. */
  async connect(_cfg) { throw unsupported(); }

  /** Chiude la connessione e libera le risorse (watch incluso). */
  async disconnect() { throw unsupported(); }

  /** @returns {Promise<Array<{name: string, sizeOnDisk: number}>>} */
  async listDatabases() { throw unsupported(); }

  /**
   * Cerca database e collection in base a una stringa.
   * @returns {Promise<Array<{name: string, collections: Array<{name: string, count?: number}>}>>}
   */
  async search(_query) { throw unsupported(); }

  async createDatabase(_db, _firstColl) { throw unsupported(); }
  async renameDatabase(_db, _newName) { throw unsupported(); }
  async dropDatabase(_db) { throw unsupported(); }

  /** @returns {Promise<Array<{name: string, type: string, count: number|null}>>} */
  async listCollections(_db) { throw unsupported(); }

  /** payload.columns (solo SQL): [{ name, type, nullable, default, autoIncrement, primaryKey }] */
  async createCollection(_db, _name, _payload) { throw unsupported(); }
  async renameCollection(_db, _coll, _newName) { throw unsupported(); }
  async dropCollection(_db, _coll) { throw unsupported(); }

  /**
   * Gestione delle colonne/campi: per i database SQL agisce sullo schema
   * (ALTER TABLE), per quelli a documenti sui campi di tutti i documenti.
   */
  async addColumn(_db, _coll, _column) { throw unsupported(); }
  async alterColumn(_db, _coll, _payload) { throw unsupported(); }
  async dropColumn(_db, _coll, _name) { throw unsupported(); }

  /** payload: { fields: '{"campo": 1}', name?, unique? } */
  async createIndex(_db, _coll, _payload) { throw unsupported(); }
  async dropIndex(_db, _coll, _name) { throw unsupported(); }

  /** @returns {Promise<{stats, indexes, fields, sampled}>} */
  async collectionStats(_db, _coll) { throw unsupported(); }

  /** @returns {Promise<{collections, relations}>} per la vista UML. */
  async dbSchema(_db) { throw unsupported(); }

  /** @returns {Promise<{docs, columns, total, skip, limit}>} */
  async collectionFind(_db, _coll, _payload) { throw unsupported(); }

  /** Pipeline di aggregazione (MongoDB) o query SQL libera (MySQL). */
  async collectionAggregate(_db, _coll, _payload) { throw unsupported(); }

  async docInsert(_db, _coll, _payload) { throw unsupported(); }
  async docUpdate(_db, _coll, _payload) { throw unsupported(); }
  async docReplace(_db, _coll, _payload) { throw unsupported(); }
  async docDelete(_db, _coll, _payload) { throw unsupported(); }
  async collectionDeleteMany(_db, _coll, _payload) { throw unsupported(); }

  /**
   * Esporta un blocco di documenti/righe come righe di testo già formattate
   * (paginato con skip/limit): { lines, count, total, header? }.
   */
  async collectionExport(_db, _coll, _payload) { throw unsupported(); }

  /**
   * Importa un blocco di documenti/righe (payload.docs = array in Extended
   * JSON serializzato) e riporta il conteggio: { inserted, failed, errors }.
   */
  async collectionImport(_db, _coll, _payload) { throw unsupported(); }

  /**
   * Aggiornamenti in tempo reale: handlers = { onChange, onUnavailable }.
   * I DBMS senza change stream lasciano l'implementazione di default.
   */
  watch(_db, _coll, _handlers) {
    throw new Error('Gli aggiornamenti in tempo reale non sono supportati da questo tipo di database.');
  }

  unwatch() { /* niente da fermare di default */ }

  /**
   * Aggiornamenti in tempo reale sullo schema (database/collection creati,
   * rinominati o eliminati): handlers = { onChange, onUnavailable }.
   * I DBMS senza change stream degradano subito segnalando onUnavailable:
   * il frontend ripiega su un polling della sidebar.
   */
  watchSchema(handlers) { handlers.onUnavailable(); }

  unwatchSchema() { /* niente da fermare di default */ }
}

/* ---------------------------------------------------------------------------
 * Euristiche condivise per le relazioni del diagramma UML
 * ------------------------------------------------------------------------- */

function singular(s) {
  if (s.endsWith('ies')) return s.slice(0, -3) + 'y';
  if (s.endsWith('s') && !s.endsWith('ss')) return s.slice(0, -1);
  return s;
}

// Euristica per l'UML: un campo "user_id" / "userId" / "user_ids" (oppure di
// tipo ObjectId con nome corrispondente a una collection, anche al plurale)
// viene considerato un riferimento verso quella collection/tabella.
function detectRelations(collections) {
  const byName = new Map();
  for (const c of collections) {
    const low = c.name.toLowerCase();
    byName.set(low, c.name);
    byName.set(singular(low), c.name);
  }
  const resolve = (base) => byName.get(base) || byName.get(base + 's') || byName.get(singular(base));

  const relations = [];
  for (const c of collections) {
    for (const f of c.fields) {
      if (f.name === '_id') continue;
      const low = f.name.toLowerCase();
      const m = low.match(/^(.+?)_?ids?$/);
      if (!m && !f.types.includes('objectId')) continue;
      const base = m ? m[1] : low;
      const target = resolve(base);
      if (!target || target === c.name) continue;
      relations.push({
        from: c.name,
        field: f.name,
        to: target,
        many: f.types.includes('array') || /ids$/.test(low),
      });
    }
  }
  return relations;
}

DbStrategy.detectRelations = detectRelations;
DbStrategy.singular = singular;

module.exports = DbStrategy;
