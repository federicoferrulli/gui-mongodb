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

const crypto = require('crypto');
const express = require('express');
const { z } = require('zod');
const { EJSON } = require('bson');
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
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
 * Definizione dei tools su un McpServer legato a una sessione MCP
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
        '→ get_schema → execute_query. Chiudi le connessioni con disconnect_database quando hai finito.',
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
      .map(([name, c]) => ({ name, dbType: deps.connDbType(c), label: deps.connLabel(c), folder: c.folder || '' }));
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
    session.dbSessions.set(connectionId, { strategy: conn.strategy, tunnel: conn.tunnel, dbType: conn.dbType });
    let databases = [];
    try { databases = await conn.strategy.listDatabases(); } catch { /* la lista è facoltativa */ }
    return jsonResult({ connection_id: connectionId, dbType: conn.dbType, label: deps.connLabel(conn.effective), databases });
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
      const session = { id: null, transport: null, dbSessions: new Map(), lastActivity: Date.now(), destroyed: false };
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
