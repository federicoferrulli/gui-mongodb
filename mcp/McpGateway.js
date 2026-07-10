'use strict';

/* ---------------------------------------------------------------------------
 * Gateway MCP (Model Context Protocol): espone le operazioni di sola lettura
 * del progetto come "tools" per i client AI (Claude, Cursor, IDE...).
 *
 * Trasporto: Streamable HTTP dell'SDK ufficiale, montato sull'app Express
 * esistente (POST/GET/DELETE su /mcp). È il successore del doppio endpoint
 * SSE (/mcp/sse + /mcp/messages), deprecato dal protocollo 2025-03-26.
 *
 * Sessioni: ogni client MCP ha la propria sessione (header mcp-session-id,
 * un McpServer + transport dedicati) con una Map<connection_id, sessione DB>
 * analoga alla Map<tabId, sessione> dei socket: connect_database apre una
 * strategia via establishConnection (stesse connessioni salvate della UI,
 * tunnel SSH compreso) e restituisce un connection_id valido solo dentro
 * quella sessione MCP. L'AI non vede mai credenziali: si connette per nome.
 * ------------------------------------------------------------------------- */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const { z } = require('zod');
const { EJSON } = require('bson');
const { McpServer, ResourceTemplate } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StreamableHTTPServerTransport } = require('@modelcontextprotocol/sdk/server/streamableHttp.js');
const { isInitializeRequest } = require('@modelcontextprotocol/sdk/types.js');

const MCP_PATH = '/mcp';
const MAX_MCP_SESSIONS = 32;                 // client MCP contemporanei
const MCP_SESSION_TTL_MS = 30 * 60 * 1000;   // sessioni inattive chiuse dopo 30'
const SWEEP_INTERVAL_MS = 60 * 1000;

function errMsg(err) {
  return (err && err.message) || String(err);
}

/* ---------------------------------------------------------------------------
 * Guardie di sola lettura (Fase 1 della roadmap MCP)
 * ------------------------------------------------------------------------- */

// Primo token ammesso per l'SQL: statement di sola lettura. La whitelist da
// sola non basta (es. EXPLAIN ANALYZE esegue davvero lo statement, una CTE
// può contenere DML): per questo la query viene comunque eseguita dentro una
// transazione READ ONLY (vedi flag readOnly di MySqlStrategy).
const SQL_READONLY_START = /^[\s(]*(select|with|show|describe|desc|explain|table|values)\b/i;
// INTO OUTFILE/DUMPFILE scrive file sul server: non è coperto dalla
// transazione READ ONLY, va bloccato a monte.
const SQL_FORBIDDEN = /\binto\s+(outfile|dumpfile)\b/i;

function assertReadOnlySql(sql) {
  const text = String(sql || '');
  if (!SQL_READONLY_START.test(text)) {
    throw new Error('In modalità MCP sono ammesse solo query di lettura (SELECT, WITH, SHOW, DESCRIBE, EXPLAIN, TABLE, VALUES).');
  }
  if (SQL_FORBIDDEN.test(text)) {
    throw new Error('INTO OUTFILE/DUMPFILE non è ammesso in modalità MCP.');
  }
}

/* Fase 3: guardie del tool di scrittura (execute_write). Via SQL solo DML
 * esplicito, niente DDL (i drop di database/collection passano dalle
 * operation dedicate drop_database/drop_collection, valide per entrambi i
 * dbType); UPDATE e DELETE devono avere una clausola WHERE. */
const SQL_WRITE_START = /^\s*(insert|update|delete|replace)\b/i;
const SQL_NEEDS_WHERE = /^\s*(update|delete)\b/i;

function assertWriteSql(sql) {
  const text = String(sql || '');
  if (!SQL_WRITE_START.test(text)) {
    throw new Error('execute_write ammette solo INSERT, UPDATE, DELETE o REPLACE (niente DDL).');
  }
  if (SQL_NEEDS_WHERE.test(text) && !/\bwhere\b/i.test(text)) {
    throw new Error('UPDATE e DELETE senza clausola WHERE non sono ammessi: specifica sempre le righe interessate.');
  }
}

// Parse di un oggetto EJSON che deve esistere e non essere vuoto (filtri e
// $set delle scritture: mai operare "su tutto" per omissione).
function parseNonEmptyObject(text, label) {
  let obj;
  try {
    obj = EJSON.parse(String(text || ''), { relaxed: false });
  } catch (err) {
    throw new Error(`${label} non valido: ${errMsg(err)}`);
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj) || !Object.keys(obj).length) {
    throw new Error(`${label} mancante o vuoto: specifica un oggetto esplicito.`);
  }
  return obj;
}

// Pipeline MongoDB: $out e $merge sono gli unici stage che scrivono e sono
// ammessi solo al livello superiore della pipeline (mai nei sub-pipeline di
// $lookup/$facet/$unionWith), quindi basta controllare gli stage top-level.
function assertReadOnlyPipeline(pipelineText) {
  let stages;
  try {
    stages = EJSON.parse(String(pipelineText || '[]'), { relaxed: false });
  } catch (err) {
    throw new Error(`Pipeline non valida: ${errMsg(err)}`);
  }
  if (!Array.isArray(stages)) return; // "deve essere un array": lo segnala la strategia
  for (const stage of stages) {
    if (stage && typeof stage === 'object' && ('$out' in stage || '$merge' in stage)) {
      throw new Error('Gli stage $out e $merge non sono ammessi in modalità MCP (sola lettura).');
    }
  }
}

/* ---------------------------------------------------------------------------
 * Audit log delle scritture (Fase 3): una riga JSON per evento in
 * mcp-audit.log nella root del progetto (file in .gitignore).
 * ------------------------------------------------------------------------- */

const AUDIT_FILE = path.join(__dirname, '..', 'mcp-audit.log');

function audit(entry) {
  const line = JSON.stringify({ ts: new Date().toISOString(), ...entry });
  fs.appendFile(AUDIT_FILE, line + '\n', () => { /* l'audit non deve mai bloccare */ });
}

/* ---------------------------------------------------------------------------
 * Resource "schema": diagramma UML (Mermaid) + dizionario dati in markdown,
 * generati al momento della lettura così da non essere mai obsoleti.
 * ------------------------------------------------------------------------- */

// Identificatore compatibile con la sintassi erDiagram di Mermaid.
function mermaidId(name) {
  return String(name || '').replace(/[^A-Za-z0-9_]/g, '_') || '_';
}

function renderSchemaMarkdown(db, schema) {
  const lines = [`# Schema di \`${db}\``, '', '## Diagramma UML (Mermaid)', '', '```mermaid', 'erDiagram'];
  for (const c of schema.collections) {
    lines.push(`  ${mermaidId(c.name)} {`);
    for (const f of c.fields) {
      lines.push(`    ${mermaidId(f.types.join('_'))} ${mermaidId(f.name)}`);
    }
    lines.push('  }');
  }
  for (const r of schema.relations) {
    lines.push(`  ${mermaidId(r.from)} ${r.many ? '}o--o{' : '}o--||'} ${mermaidId(r.to)} : "${r.field}"`);
  }
  lines.push('```', '', '## Dizionario dati', '');
  for (const c of schema.collections) {
    lines.push(`### ${c.name}`, '', '| Campo | Tipi | Presenza % |', '| --- | --- | --- |');
    for (const f of c.fields) {
      lines.push(`| ${f.name} | ${f.types.join(', ')} | ${f.presence} |`);
    }
    lines.push('');
  }
  if (schema.relations.length) {
    lines.push('## Relazioni', '');
    for (const r of schema.relations) {
      lines.push(`- \`${r.from}.${r.field}\` → \`${r.to}\`${r.many ? ' (uno-a-molti)' : ''}`);
    }
    lines.push('');
  }
  return lines.join('\n');
}

/* ---------------------------------------------------------------------------
 * Definizione di tools, prompts e resources su un McpServer legato a una
 * sessione MCP
 * ------------------------------------------------------------------------- */

function jsonResult(obj) {
  return { content: [{ type: 'text', text: JSON.stringify(obj, null, 2) }] };
}

// I tool non lanciano mai verso il protocollo: un errore diventa un risultato
// con isError, così il modello lo legge e può correggersi.
function errorResult(err) {
  return { isError: true, content: [{ type: 'text', text: `Errore: ${errMsg(err)}` }] };
}

function buildMcpServer(session, deps) {
  const server = new McpServer(
    { name: 'gui-mongodb-mcp', version: require('../package.json').version },
    {
      instructions:
        'Gateway di sola lettura verso i database (MongoDB e MySQL) gestiti da Mongo Web GUI. ' +
        'Flusso tipico: list_saved_connections → connect_database → get_databases_and_collections ' +
        '→ get_schema → execute_query. Chiudi le connessioni con disconnect_database quando hai finito. ' +
        'La risorsa schema://{connection_id}/{db} fornisce UML Mermaid e dizionario dati sempre aggiornati; ' +
        'i prompt genera-report ed esplora-database guidano i flussi ricorrenti.',
    }
  );

  const tool = (name, config, handler) => {
    server.registerTool(name, config, async (args = {}) => {
      try {
        return await handler(args);
      } catch (err) {
        return errorResult(err);
      }
    });
  };

  const requireDbSession = (connectionId) => {
    const sess = session.dbSessions.get(String(connectionId || ''));
    if (!sess) throw new Error('connection_id sconosciuto o connessione già chiusa: apri prima una connessione con connect_database.');
    return sess;
  };

  tool('list_saved_connections', {
    title: 'Connessioni salvate',
    description:
      'Elenca le connessioni salvate in connections.ini: nome, tipo di database (mongodb o mysql), ' +
      'etichetta host e cartella. Le credenziali non vengono mai esposte. ' +
      'Usa il nome restituito come parametro "saved" di connect_database.',
    inputSchema: {},
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, async () => {
    const connections = Object.entries(deps.loadConnections())
      .map(([name, c]) => ({
        name,
        dbType: deps.connDbType(c),
        label: deps.connLabel(c),
        folder: c.folder || '',
        // Scritture consentite solo con readOnly=false esplicito nel .ini.
        readOnly: String(c.readOnly || '').trim().toLowerCase() !== 'false',
      }));
    return jsonResult({ connections });
  });

  tool('connect_database', {
    title: 'Apri connessione',
    description:
      'Apre una connessione a una delle connessioni salvate (indicata per nome) e restituisce il ' +
      'connection_id da usare nelle altre chiamate, il dbType (mongodb o mysql) e l\'elenco dei database. ' +
      'Le credenziali e gli eventuali tunnel SSH restano gestiti dal server.',
    inputSchema: {
      saved: z.string().describe('Nome della connessione salvata (vedi list_saved_connections)'),
    },
    annotations: { openWorldHint: false },
  }, async ({ saved }) => {
    if (session.dbSessions.size >= deps.maxDbSessions) {
      throw new Error(`Raggiunto il limite di ${deps.maxDbSessions} connessioni per questa sessione MCP: chiudine una con disconnect_database.`);
    }
    if (!deps.tryAcquireGlobalSession()) {
      throw new Error('Raggiunto il limite globale di connessioni al database: riprova più tardi.');
    }
    let conn;
    try {
      conn = await deps.establishConnection({ saved: String(saved || '') });
    } catch (err) {
      deps.releaseGlobalSession();
      throw err;
    }
    const connectionId = crypto.randomUUID();
    // writesAllowed valutato al momento della connessione: serve readOnly=false
    // esplicito nella connessione salvata (default: sola lettura).
    const writesAllowed = String(conn.effective.readOnly || '').trim().toLowerCase() === 'false';
    session.dbSessions.set(connectionId, {
      strategy: conn.strategy,
      tunnel: conn.tunnel,
      dbType: conn.dbType,
      name: String(saved || ''),
      writesAllowed,
    });
    let databases = [];
    try { databases = await conn.strategy.listDatabases(); } catch { /* la lista è facoltativa */ }
    return jsonResult({ connection_id: connectionId, dbType: conn.dbType, label: deps.connLabel(conn.effective), writable: writesAllowed, databases });
  });

  tool('disconnect_database', {
    title: 'Chiudi connessione',
    description: 'Chiude una connessione aperta con connect_database e libera le risorse (client/pool e tunnel SSH).',
    inputSchema: {
      connection_id: z.string(),
    },
    annotations: { openWorldHint: false },
  }, async ({ connection_id }) => {
    const sess = requireDbSession(connection_id);
    session.dbSessions.delete(String(connection_id));
    deps.releaseGlobalSession();
    await deps.teardownConnection(sess);
    return jsonResult({ disconnected: true });
  });

  tool('get_databases_and_collections', {
    title: 'Topologia',
    description:
      'Esplora la topologia della connessione: senza "db" elenca i database (nome e dimensione su disco); ' +
      'con "db" elenca le collection/tabelle di quel database (nome, tipo, conteggio stimato dei documenti/righe).',
    inputSchema: {
      connection_id: z.string(),
      db: z.string().optional().describe('Nome del database di cui elencare le collection/tabelle'),
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, async ({ connection_id, db }) => {
    const sess = requireDbSession(connection_id);
    const dbName = String(db || '').trim();
    if (dbName) {
      return jsonResult({ db: dbName, collections: await sess.strategy.listCollections(dbName) });
    }
    return jsonResult({ databases: await sess.strategy.listDatabases() });
  });

  tool('get_schema', {
    title: 'Schema del database',
    description:
      'Restituisce lo schema di un database: per ogni collection/tabella i campi con tipi e presenza % ' +
      '(MongoDB: dedotti da un campione; MySQL: colonne reali), più le relazioni tra collection/tabelle ' +
      '(foreign key dichiarate e euristiche di denominazione). Consultalo prima di scrivere query su dati che non conosci.',
    inputSchema: {
      connection_id: z.string(),
      db: z.string().describe('Nome del database'),
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, async ({ connection_id, db }) => {
    const sess = requireDbSession(connection_id);
    return jsonResult(await sess.strategy.dbSchema(String(db || '').trim()));
  });

  tool('execute_query', {
    title: 'Esegui query (sola lettura)',
    description:
      'Esegue una query di sola lettura e restituisce { docs, columns, total, skip, limit } ' +
      '(documenti/righe in Extended JSON: ObjectId = {"$oid": ...}, date = {"$date": ...}). ' +
      'Su MongoDB usa "collection" con "filter"/"sort"/"projection" (find) oppure "pipeline" (aggregazione, senza $out/$merge). ' +
      'Su MySQL usa solo "sql" con uno statement SELECT/SHOW/DESCRIBE/EXPLAIN/WITH, eseguito in una transazione READ ONLY. ' +
      'Mantieni "limit" basso e usa "projection" o SELECT mirate per non sprecare contesto.',
    inputSchema: {
      connection_id: z.string(),
      db: z.string().describe('Database (MySQL: schema) su cui eseguire la query'),
      collection: z.string().optional().describe('Solo MongoDB: collection su cui eseguire find o pipeline'),
      filter: z.string().optional().describe('Solo MongoDB: filtro find in Extended JSON, es. {"age":{"$gt":30}} o {"_id":{"$oid":"..."}}'),
      sort: z.string().optional().describe('Solo MongoDB: ordinamento in Extended JSON, es. {"age":-1}'),
      projection: z.string().optional().describe('Solo MongoDB: proiezione dei campi, es. {"name":1,"age":1}'),
      skip: z.coerce.number().int().min(0).optional().describe('Solo MongoDB find: offset per la paginazione (default 0)'),
      limit: z.coerce.number().int().min(1).max(500).optional().describe('Solo MongoDB find: numero massimo di documenti (default 50, max 500)'),
      pipeline: z.string().optional().describe('Solo MongoDB: pipeline di aggregazione in Extended JSON (array di stage); $out e $merge sono vietati'),
      sql: z.string().optional().describe('Solo MySQL: query SQL di sola lettura (SELECT, WITH, SHOW, DESCRIBE, EXPLAIN); includi una LIMIT'),
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, async (args) => {
    const sess = requireDbSession(args.connection_id);
    const db = String(args.db || '').trim();
    if (!db) throw new Error('Parametro "db" mancante.');

    if (sess.dbType === 'mysql') {
      const sql = String(args.sql || '').trim();
      if (!sql) throw new Error('Per MySQL usa il parametro "sql" con una query di sola lettura (gli altri parametri valgono solo per MongoDB).');
      assertReadOnlySql(sql);
      return jsonResult(await sess.strategy.collectionAggregate(db, null, { pipeline: sql, readOnly: true }));
    }

    if (args.sql && String(args.sql).trim()) {
      throw new Error('Il parametro "sql" vale solo per MySQL: su MongoDB usa "filter" (find) oppure "pipeline" (aggregazione).');
    }
    const coll = String(args.collection || '').trim();
    if (!coll) throw new Error('Parametro "collection" mancante.');
    if (args.pipeline && String(args.pipeline).trim()) {
      assertReadOnlyPipeline(args.pipeline);
      return jsonResult(await sess.strategy.collectionAggregate(db, coll, { pipeline: args.pipeline }));
    }
    return jsonResult(await sess.strategy.collectionFind(db, coll, {
      filter: args.filter,
      sort: args.sort,
      projection: args.projection,
      skip: args.skip,
      limit: args.limit == null ? 50 : args.limit,
    }));
  });

  // --- Fase 3: scritture con conferma esplicita (human-in-the-loop) -----------
  // Primo passo: execute_write senza confirm_token valida l'operazione e
  // restituisce anteprima + token monouso (5 minuti). Secondo passo: la stessa
  // chiamata con confirm_token esegue l'operazione registrata. Il token è la
  // conferma: va richiesto all'utente umano, mai autogenerato dall'AI.

  const CONFIRM_TTL_MS = 5 * 60 * 1000;

  const sweepPendingWrites = () => {
    const now = Date.now();
    for (const [token, p] of session.pendingWrites) {
      if (p.expiresAt <= now) session.pendingWrites.delete(token);
    }
  };

  // Valida gli argomenti e costruisce l'operazione di scrittura: { summary,
  // exec }. exec viene eseguita solo alla conferma.
  const buildWriteOp = (sess, args, db) => {
    // Drop di collection/tabelle e database: valgono per entrambi i dbType
    // (le strategie proteggono già i db/schemi di sistema).
    const dropOp = String(args.operation || '').trim().toLowerCase();
    if (dropOp === 'drop_collection') {
      const coll = String(args.collection || '').trim();
      if (!coll) throw new Error('Parametro "collection" mancante per drop_collection.');
      return {
        summary: { dbType: sess.dbType, db, collection: coll, operation: dropOp },
        exec: async () => { await sess.strategy.dropCollection(db, coll); return { dropped: `${db}.${coll}` }; },
      };
    }
    if (dropOp === 'drop_database') {
      return {
        summary: { dbType: sess.dbType, db, operation: dropOp },
        exec: async () => { await sess.strategy.dropDatabase(db); return { dropped: db }; },
      };
    }
    if (sess.dbType === 'mysql') {
      const sql = String(args.sql || '').trim();
      if (!sql) throw new Error('Per MySQL usa il parametro "sql" con uno statement INSERT/UPDATE/DELETE/REPLACE.');
      assertWriteSql(sql);
      return {
        summary: { dbType: 'mysql', db, sql },
        exec: () => sess.strategy.collectionAggregate(db, null, { pipeline: sql }),
      };
    }
    if (args.sql && String(args.sql).trim()) {
      throw new Error('Il parametro "sql" vale solo per MySQL: su MongoDB usa "operation" con "doc"/"filter"/"set".');
    }
    const coll = String(args.collection || '').trim();
    if (!coll) throw new Error('Parametro "collection" mancante.');
    const operation = String(args.operation || '').trim().toLowerCase();
    if (operation === 'insert') {
      if (!String(args.doc || '').trim()) throw new Error('Parametro "doc" mancante per l\'insert.');
      return {
        summary: { dbType: 'mongodb', db, collection: coll, operation, doc: args.doc },
        exec: () => sess.strategy.docInsert(db, coll, { doc: args.doc }),
      };
    }
    if (operation === 'update') {
      parseNonEmptyObject(args.filter, 'Filtro');
      parseNonEmptyObject(args.set, 'Oggetto "set"');
      return {
        summary: { dbType: 'mongodb', db, collection: coll, operation, filter: args.filter, set: args.set },
        exec: () => sess.strategy.collectionUpdateMany(db, coll, { filter: args.filter, set: args.set }),
      };
    }
    if (operation === 'delete') {
      parseNonEmptyObject(args.filter, 'Filtro');
      return {
        summary: { dbType: 'mongodb', db, collection: coll, operation, filter: args.filter },
        exec: () => sess.strategy.collectionDeleteMany(db, coll, { filter: args.filter }),
      };
    }
    throw new Error('Parametro "operation" mancante o non valido: usa "insert", "update", "delete", "drop_collection" o "drop_database" (per il DML su MySQL usa "sql").');
  };

  tool('execute_write', {
    title: 'Esegui scrittura (con conferma)',
    description:
      'Esegue una scrittura sul database in due passaggi. Funziona solo su connessioni salvate con readOnly=false ' +
      'esplicito in connections.ini (default: sola lettura). ' +
      'Primo passo: chiama SENZA confirm_token per ottenere l\'anteprima dell\'operazione e un token di conferma. ' +
      'Mostra l\'anteprima all\'utente umano e chiedi la sua approvazione esplicita: solo dopo richiama con confirm_token. ' +
      'NON confermare mai di tua iniziativa. Il token scade dopo 5 minuti ed è monouso. ' +
      'MongoDB: "operation" (insert|update|delete) con "doc" (insert) o "filter"+"set" (update) o "filter" (delete), in Extended JSON; ' +
      'filtri vuoti rifiutati. MySQL: "sql" con INSERT/UPDATE/DELETE/REPLACE; UPDATE/DELETE richiedono WHERE. ' +
      'Su entrambi i dbType "operation" ammette anche "drop_collection" (elimina la collection/tabella indicata) e ' +
      '"drop_database" (elimina l\'intero database "db"); i db di sistema sono protetti. Nessun altro DDL è ammesso. ' +
      'Ogni richiesta ed esecuzione viene registrata in un audit log sul server.',
    inputSchema: {
      connection_id: z.string(),
      db: z.string().describe('Database (MySQL: schema) su cui operare'),
      collection: z.string().optional().describe('Collection/tabella su cui operare (per MongoDB e per drop_collection)'),
      operation: z.enum(['insert', 'update', 'delete', 'drop_collection', 'drop_database']).optional().describe('Tipo di scrittura: insert/update/delete solo MongoDB; drop_collection e drop_database per entrambi i dbType'),
      doc: z.string().optional().describe('Solo MongoDB insert: documento in Extended JSON'),
      filter: z.string().optional().describe('Solo MongoDB update/delete: filtro esplicito in Extended JSON (mai vuoto)'),
      set: z.string().optional().describe('Solo MongoDB update: campi da aggiornare ($set) in Extended JSON'),
      sql: z.string().optional().describe('Solo MySQL: statement INSERT/UPDATE/DELETE/REPLACE (UPDATE/DELETE con WHERE)'),
      confirm_token: z.string().optional().describe('Token restituito dal primo passo, da inviare solo dopo la conferma esplicita dell\'utente umano'),
    },
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
  }, async (args) => {
    const sess = requireDbSession(args.connection_id);
    if (!sess.writesAllowed) {
      throw new Error(`La connessione "${sess.name}" è in sola lettura: per abilitare le scritture imposta readOnly=false nella sua sezione di connections.ini, oppure usa il tool set_connection_read_only (richiede la conferma esplicita dell'utente umano) e poi riconnettiti.`);
    }
    const db = String(args.db || '').trim();
    if (!db) throw new Error('Parametro "db" mancante.');
    sweepPendingWrites();

    const auditBase = { sessionId: session.id, connection: sess.name, dbType: sess.dbType };

    // Secondo passo: esecuzione dell'operazione registrata col token.
    const token = String(args.confirm_token || '').trim();
    if (token) {
      const pending = session.pendingWrites.get(token);
      if (!pending || pending.kind !== 'write' || pending.connectionId !== String(args.connection_id)) {
        throw new Error('confirm_token sconosciuto, scaduto o di un\'altra connessione: ripeti la richiesta senza token.');
      }
      session.pendingWrites.delete(token); // monouso
      try {
        const result = await pending.exec();
        audit({ ...auditBase, event: 'executed', ...pending.summary, result });
        return jsonResult({ executed: true, ...pending.summary, result });
      } catch (err) {
        audit({ ...auditBase, event: 'failed', ...pending.summary, error: errMsg(err) });
        throw err;
      }
    }

    // Primo passo: validazione, anteprima e token di conferma.
    const op = buildWriteOp(sess, args, db);

    // Stima best-effort dell'impatto: documenti interessati per update/delete
    // (solo MongoDB) e drop_collection, numero di collection per drop_database.
    let affectedEstimate;
    if (op.summary.operation === 'update' || op.summary.operation === 'delete') {
      try {
        const probe = await sess.strategy.collectionFind(db, op.summary.collection, { filter: op.summary.filter, limit: 1 });
        affectedEstimate = probe.total;
      } catch { /* la stima è facoltativa */ }
    } else if (op.summary.operation === 'drop_collection') {
      try {
        const probe = await sess.strategy.collectionFind(db, op.summary.collection, { limit: 1 });
        affectedEstimate = probe.total;
      } catch { /* la stima è facoltativa */ }
    } else if (op.summary.operation === 'drop_database') {
      try {
        affectedEstimate = (await sess.strategy.listCollections(db)).length;
      } catch { /* la stima è facoltativa */ }
    }

    const confirmToken = crypto.randomUUID();
    session.pendingWrites.set(confirmToken, {
      kind: 'write',
      connectionId: String(args.connection_id),
      exec: op.exec,
      summary: op.summary,
      expiresAt: Date.now() + CONFIRM_TTL_MS,
    });
    audit({ ...auditBase, event: 'requested', ...op.summary, affectedEstimate });
    return jsonResult({
      requires_confirmation: true,
      confirm_token: confirmToken,
      expires_in_seconds: CONFIRM_TTL_MS / 1000,
      preview: op.summary,
      ...(affectedEstimate != null ? { affected_estimate: affectedEstimate } : {}),
      istruzioni: 'Mostra l\'anteprima all\'utente umano e chiedi conferma esplicita. Solo se l\'utente approva, richiama execute_write con questo confirm_token. Se l\'utente rifiuta, non richiamare il tool.',
    });
  });

  // --- Flag readOnly delle connessioni salvate (con conferma) -----------------
  // Unica modifica a connections.ini raggiungibile via MCP: il flag readOnly di
  // una connessione salvata, mai gli altri campi né i segreti. Stesso schema
  // human-in-the-loop di execute_write: anteprima + confirm_token monouso, in
  // ENTRAMBE le direzioni (anche tornare a sola lettura richiede conferma).

  tool('set_connection_read_only', {
    title: 'Cambia il flag readOnly di una connessione salvata (con conferma)',
    description:
      'Imposta il flag readOnly di una connessione salvata in connections.ini (unico campo modificabile via MCP: ' +
      'mai credenziali o altri parametri). Con read_only=false la connessione diventa scrivibile per execute_write; ' +
      'con read_only=true torna in sola lettura. Funziona in due passaggi come execute_write: ' +
      'primo passo SENZA confirm_token per ottenere anteprima e token; mostra l\'anteprima all\'utente umano e ' +
      'richiama col token solo dopo la sua approvazione esplicita. NON confermare mai di tua iniziativa. ' +
      'Il cambio vale per le connessioni aperte da quel momento in poi: riapri con connect_database per applicarlo. ' +
      'Ogni richiesta ed esecuzione viene registrata nell\'audit log.',
    inputSchema: {
      connection_name: z.string().describe('Nome della connessione salvata (vedi list_saved_connections)'),
      read_only: z.boolean().optional().describe('Nuovo valore del flag: false = scritture consentite, true = sola lettura (obbligatorio al primo passo)'),
      confirm_token: z.string().optional().describe('Token restituito dal primo passo, da inviare solo dopo la conferma esplicita dell\'utente umano'),
    },
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
  }, async (args) => {
    const name = String(args.connection_name || '').trim();
    if (!name) throw new Error('Parametro "connection_name" mancante.');
    sweepPendingWrites();
    const auditBase = { sessionId: session.id, connection: name, operation: 'set_connection_read_only' };

    // Secondo passo: applica la modifica registrata col token.
    const token = String(args.confirm_token || '').trim();
    if (token) {
      const pending = session.pendingWrites.get(token);
      if (!pending || pending.kind !== 'ini' || pending.name !== name) {
        throw new Error('confirm_token sconosciuto, scaduto o di un\'altra richiesta: ripeti la richiesta senza token.');
      }
      session.pendingWrites.delete(token); // monouso
      try {
        deps.setConnectionReadOnly(name, pending.readOnly);
        audit({ ...auditBase, event: 'executed', readOnly: pending.readOnly });
        return jsonResult({
          executed: true,
          connection: name,
          readOnly: pending.readOnly,
          nota: 'Il nuovo flag vale per le prossime connessioni: riapri con connect_database per applicarlo.',
        });
      } catch (err) {
        audit({ ...auditBase, event: 'failed', readOnly: pending.readOnly, error: errMsg(err) });
        throw err;
      }
    }

    // Primo passo: validazione, anteprima e token di conferma.
    if (typeof args.read_only !== 'boolean') {
      throw new Error('Parametro "read_only" mancante: indica true (sola lettura) o false (scritture consentite).');
    }
    const conn = deps.loadConnections()[name];
    if (!conn) throw new Error(`Connessione salvata "${name}" inesistente: verifica con list_saved_connections.`);
    const current = String(conn.readOnly || '').trim().toLowerCase() !== 'false';
    if (current === args.read_only) {
      return jsonResult({ changed: false, connection: name, readOnly: current, message: 'Il flag ha già il valore richiesto: nessuna modifica necessaria.' });
    }
    const confirmToken = crypto.randomUUID();
    session.pendingWrites.set(confirmToken, {
      kind: 'ini',
      name,
      readOnly: args.read_only,
      expiresAt: Date.now() + CONFIRM_TTL_MS,
    });
    audit({ ...auditBase, event: 'requested', readOnly: args.read_only });
    return jsonResult({
      requires_confirmation: true,
      confirm_token: confirmToken,
      expires_in_seconds: CONFIRM_TTL_MS / 1000,
      preview: { connection: name, readOnly: { da: current, a: args.read_only } },
      istruzioni: 'Mostra l\'anteprima all\'utente umano e chiedi conferma esplicita. Solo se l\'utente approva, richiama set_connection_read_only con questo confirm_token. Se l\'utente rifiuta, non richiamare il tool.',
    });
  });

  // --- Resources (Fase 2): schema come risorsa markdown -----------------------

  server.registerResource(
    'schema',
    new ResourceTemplate('schema://{connectionId}/{db}', { list: undefined }),
    {
      title: 'Schema del database (UML + dizionario dati)',
      description:
        'Diagramma UML in formato Mermaid (erDiagram) e dizionario dati del database indicato, ' +
        'con campi, tipi, presenza % e relazioni (foreign key reali ed euristiche). ' +
        'Generato al momento della lettura, quindi sempre aggiornato allo schema corrente. ' +
        'URI: schema://{connectionId}/{db}, dove connectionId è quello restituito da connect_database.',
      mimeType: 'text/markdown',
    },
    async (uri, { connectionId, db }) => {
      const sess = requireDbSession(connectionId);
      const dbName = String(db || '').trim();
      if (!dbName) throw new Error('Nome del database mancante nell\'URI (schema://{connectionId}/{db}).');
      const schema = await sess.strategy.dbSchema(dbName);
      return { contents: [{ uri: uri.href, mimeType: 'text/markdown', text: renderSchemaMarkdown(dbName, schema) }] };
    }
  );

  // --- Prompts (Fase 2): template parametrizzati per i flussi ricorrenti ------

  server.registerPrompt('genera-report', {
    title: 'Genera report da un database',
    description: 'Produce un report analitico in markdown su un database, usando i tools di sola lettura del server.',
    argsSchema: {
      connessione: z.string().describe('Nome della connessione salvata (vedi list_saved_connections)'),
      db: z.string().describe('Database da analizzare'),
      periodo: z.string().optional().describe('Periodo di interesse, es. "ultimo mese" o "2026"'),
    },
  }, ({ connessione, db, periodo }) => ({
    messages: [{
      role: 'user',
      content: {
        type: 'text',
        text:
          `Genera un report analitico sul database "${db}" della connessione salvata "${connessione}"` +
          (periodo ? `, limitato al periodo: ${periodo}` : '') + '.\n\n' +
          'Procedi così:\n' +
          `1. Apri la connessione con connect_database (saved: "${connessione}").\n` +
          `2. Studia la struttura con get_schema (o la risorsa schema://{connection_id}/${db}) prima di scrivere query.\n` +
          '3. Esegui con execute_query solo interrogazioni di sola lettura mirate (limit bassi, proiezioni/SELECT dei soli campi utili): volumi per collection/tabella, distribuzioni e metriche significative' +
          (periodo ? ' filtrate sul periodo indicato usando i campi data disponibili' : '') + '.\n' +
          '4. Componi un report in markdown con: panoramica delle entità e delle relazioni, numeri chiave, eventuali anomalie (campi poco presenti, valori sospetti) e osservazioni finali.\n' +
          '5. Alla fine chiudi la connessione con disconnect_database.',
      },
    }],
  }));

  server.registerPrompt('esplora-database', {
    title: 'Esplora una connessione',
    description: 'Esplorazione guidata di una connessione: topologia, schema e campioni, con dizionario dati commentato come risultato.',
    argsSchema: {
      connessione: z.string().describe('Nome della connessione salvata (vedi list_saved_connections)'),
      db: z.string().optional().describe('Database specifico; se assente, esplora la topologia e scegli i più rilevanti'),
    },
  }, ({ connessione, db }) => ({
    messages: [{
      role: 'user',
      content: {
        type: 'text',
        text:
          `Esplora la connessione salvata "${connessione}"${db ? `, concentrandoti sul database "${db}"` : ''}.\n\n` +
          'Procedi così:\n' +
          `1. Apri la connessione con connect_database (saved: "${connessione}").\n` +
          (db
            ? `2. Elenca le collection/tabelle di "${db}" con get_databases_and_collections.\n`
            : '2. Elenca i database con get_databases_and_collections e individua quelli applicativi (ignora quelli di sistema).\n') +
          '3. Per il database di interesse leggi lo schema con get_schema e osserva qualche documento/riga reale con execute_query (limit 5).\n' +
          '4. Produci un dizionario dati commentato in markdown: per ogni collection/tabella scopo presunto, campi principali con tipi, relazioni con le altre entità e note su qualità/particolarità dei dati.\n' +
          '5. Alla fine chiudi la connessione con disconnect_database.',
      },
    }],
  }));

  return server;
}

/* ---------------------------------------------------------------------------
 * Trasporto Streamable HTTP sull'app Express esistente
 * ------------------------------------------------------------------------- */

/**
 * Monta l'endpoint MCP su `app`. `deps` arriva da server.js:
 * { loadConnections, connLabel, connDbType, establishConnection,
 *   teardownConnection, tryAcquireGlobalSession, releaseGlobalSession,
 *   maxDbSessions }
 */
function attachMcp(app, deps) {
  /** @type {Map<string, {id: string|null, transport: any, dbSessions: Map<string, any>, lastActivity: number, destroyed: boolean}>} */
  const mcpSessions = new Map();

  async function destroyMcpSession(session, { closeTransport = true } = {}) {
    if (session.destroyed) return;
    session.destroyed = true;
    if (session.id) mcpSessions.delete(session.id);
    for (const [connId, dbSess] of [...session.dbSessions]) {
      session.dbSessions.delete(connId);
      deps.releaseGlobalSession();
      await Promise.resolve(deps.teardownConnection(dbSess)).catch(() => {});
    }
    if (closeTransport) {
      await Promise.resolve(session.transport.close()).catch(() => {});
    }
  }

  // Le sessioni MCP non hanno una "disconnessione" affidabile come i socket:
  // quelle inattive da troppo tempo vengono chiuse d'ufficio.
  setInterval(() => {
    const now = Date.now();
    for (const session of [...mcpSessions.values()]) {
      if (now - session.lastActivity > MCP_SESSION_TTL_MS) destroyMcpSession(session);
    }
  }, SWEEP_INTERVAL_MS).unref();

  // Anti DNS-rebinding: quando il server è in ascolto solo su loopback, una
  // pagina web ostile può comunque raggiungerlo facendo puntare il proprio
  // dominio a 127.0.0.1; in quel caso però l'header Host resta quello del
  // dominio ostile, quindi basta pretendere un Host locale.
  const bindHost = String(process.env.HOST || '127.0.0.1');
  const loopbackBind = ['127.0.0.1', 'localhost', '::1'].includes(bindHost);
  const LOCAL_HOST_HEADER = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i;

  function guardHost(req, res) {
    if (!loopbackBind || LOCAL_HOST_HEADER.test(String(req.headers.host || ''))) return true;
    res.status(403).json(rpcError(-32000, 'Host header non consentito.'));
    return false;
  }

  function rpcError(code, message) {
    return { jsonrpc: '2.0', error: { code, message }, id: null };
  }

  app.post(MCP_PATH, express.json({ limit: '5mb' }), async (req, res) => {
    if (!guardHost(req, res)) return;
    try {
      const sid = req.headers['mcp-session-id'];
      const existing = sid ? mcpSessions.get(String(sid)) : undefined;
      if (existing) {
        existing.lastActivity = Date.now();
        await existing.transport.handleRequest(req, res, req.body);
        return;
      }
      if (sid || !isInitializeRequest(req.body)) {
        res.status(400).json(rpcError(-32000, 'Sessione MCP assente o scaduta: reinizializza la connessione.'));
        return;
      }
      if (mcpSessions.size >= MAX_MCP_SESSIONS) {
        res.status(503).json(rpcError(-32000, `Raggiunto il limite di ${MAX_MCP_SESSIONS} sessioni MCP contemporanee.`));
        return;
      }

      // Nuova sessione: un McpServer e un transport dedicati, registrati
      // nella mappa quando l'SDK assegna il session id.
      const session = { id: null, transport: null, dbSessions: new Map(), pendingWrites: new Map(), lastActivity: Date.now(), destroyed: false };
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => crypto.randomUUID(),
        enableJsonResponse: true, // risposte JSON semplici: nessun push server→client
        onsessioninitialized: (newSid) => {
          session.id = newSid;
          mcpSessions.set(newSid, session);
        },
      });
      session.transport = transport;
      transport.onclose = () => { destroyMcpSession(session, { closeTransport: false }); };
      await buildMcpServer(session, deps).connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      if (!res.headersSent) res.status(500).json(rpcError(-32603, errMsg(err)));
    }
  });

  // GET = stream di notifiche server→client (non usato ma previsto dal
  // protocollo), DELETE = terminazione esplicita della sessione.
  const handleSessionRequest = async (req, res) => {
    if (!guardHost(req, res)) return;
    const sid = req.headers['mcp-session-id'];
    const session = sid ? mcpSessions.get(String(sid)) : undefined;
    if (!session) {
      res.status(400).json(rpcError(-32000, 'Sessione MCP non valida o scaduta.'));
      return;
    }
    session.lastActivity = Date.now();
    try {
      await session.transport.handleRequest(req, res);
    } catch (err) {
      if (!res.headersSent) res.status(500).json(rpcError(-32603, errMsg(err)));
    }
  };
  app.get(MCP_PATH, handleSessionRequest);
  app.delete(MCP_PATH, handleSessionRequest);
}

module.exports = { attachMcp, assertReadOnlySql, assertReadOnlyPipeline, MCP_PATH };
