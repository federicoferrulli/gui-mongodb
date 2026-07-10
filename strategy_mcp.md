# Strategy MCP - Integrazione del Model Context Protocol

Questo documento definisce l'architettura e la strategia per estendere **Mongo Web GUI** in modo da renderla un Server **MCP (Model Context Protocol)**. L'obiettivo è permettere ad agenti di Intelligenza Artificiale (come Claude, Cursor, o altri IDE/Client AI) di connettersi in modo sicuro ed eseguire operazioni esplorative o analitiche sui database gestiti dal progetto.

---

## 1. Cos'è il Model Context Protocol (MCP)?

Il **Model Context Protocol** è uno standard open source che consente alle applicazioni AI di connettersi in modo sicuro a origini dati esterne (database, file system, API). 
Invece di programmare integrazioni personalizzate tra ogni tool AI e ogni tipo di database, l'MCP definisce un'interfaccia client-server unificata basata su JSON-RPC 2.0.

In un ecosistema MCP:
- **L'AI (Client MCP):** Invia richieste (es. "quali tool hai a disposizione?" o "esegui questo tool").
- **Il Server MCP:** Espone *Resources* (dati statici), *Prompts* (template) e soprattutto **Tools** (funzioni eseguibili).

---

## 2. Perché integrare MCP in gui-mongodb?

L'integrazione è un'evoluzione naturale per `gui-mongodb` per tre ragioni fondamentali:

1. **Il lavoro di astrazione è già fatto:** Grazie allo *Strategy Pattern* (`DbStrategy`, `MongoDbStrategy`, `MySqlStrategy`), il backend possiede già le funzioni programmatiche unificate (`listDatabases`, `listCollections`, `dbSchema`, `collectionFind`) che servono all'AI per "capire" il database.
2. **Sicurezza Centralizzata:** `gui-mongodb` gestisce il file `connections.ini`, le password e i complessi tunnel SSH (`ssh2`). Esponendo un Server MCP, l'AI non deve conoscere le credenziali del database. L'AI chiede semplicemente di interrogare la connessione "Produzione", e il backend Node.js gestisce l'accesso con gli stessi criteri di sicurezza usati per la UI.
3. **Da GUI a "AI Data Hub":** Il progetto smetterebbe di essere solo un'interfaccia visiva per utenti umani, diventando un "ponte universale" (Data Hub) tra le intelligenze artificiali e i dati aziendali/personali (abilitando casi d'uso come la generazione di query SQL/NoSQL da linguaggio naturale: *NL2SQL*).

---

## 3. Architettura Proposta

L'integrazione avverrà utilizzando l'SDK ufficiale per Node.js (`@modelcontextprotocol/sdk`).

### Livello di Trasporto (Transport)
L'SDK Node.js di MCP supporta due metodi di trasporto. Per la massima flessibilità di `gui-mongodb`, potremmo abilitarli entrambi o sceglierne uno:

1. **SSE (Server-Sent Events) via Express:**
   Poiché `gui-mongodb` ha già un server Express in esecuzione (tipicamente sulla porta 3030), possiamo aggiungere due endpoint (es. `GET /mcp/sse` e `POST /mcp/messages`). Questo permette ai client AI di connettersi al server MCP tramite la rete (anche in locale), mantenendo la comunicazione asincrona.
2. **Standard I/O (stdio):**
   Utile se vogliamo che un client come Claude Desktop lanci direttamente `node server.js` in background e comunichi tramite i flussi di input/output standard.

### Gestione dello Stato (Sessioni)
Attualmente la comunicazione tra Web UI e Backend usa `Socket.IO` instradando tutto con un `tabId`. Per l'MCP, ogni connessione Client-Server AI rappresenterà una propria "sessione". L'AI dovrà prima invocare un tool per "aprire" una connessione DB salvata, il backend stanzierà una strategia (tramite `DbFactory`) per quella sessione MCP, e l'AI userà quell'istanza per le chiamate successive.

---

## 4. I "Tools" MCP da Esporre

I server MCP definiscono dei "Tools" (strumenti) che l'AI può invocare. Mappando l'attuale logica di `gui-mongodb`, esporremo i seguenti strumenti:

- **`list_saved_connections`**: Legge `connections.ini` e restituisce i nomi e i tipi di DB disponibili all'AI, omettendo rigorosamente le password.
- **`connect_database`**: Inizializza una connessione a uno dei DB salvati e restituisce un `connection_id` (simile all'attuale `tabId`).
- **`get_databases_and_collections`**: Restituisce la topologia del database (es. output di `listDatabases` e `listCollections`).
- **`get_schema`**: Richiama il metodo `dbSchema(db)`. **Cruciale per l'AI**: fornisce il diagramma delle tabelle/collezioni e le relazioni scoperte tramite le tue euristiche (chiavi esterne), permettendo all'AI di formulare query precise.
- **`execute_query`**: 
  - Su **MongoDB**: Riceve parametri `filter`, `sort` (in EJSON string) e li passa a `collectionFind`.
  - Su **MySQL**: Riceve una stringa SQL raw e la passa come `collectionAggregate` o a un metodo SQL dedicato.

---

## 5. Implementazione Pratica (Bozza di Integrazione)

Aggiunta delle dipendenze necessarie:
```bash
npm install @modelcontextprotocol/sdk express
```

**Esempio di integrazione in `server.js` (con SSE):**

```javascript
const { Server } = require("@modelcontextprotocol/sdk/server/index.js");
const { SSEServerTransport } = require("@modelcontextprotocol/sdk/server/sse.js");

// Inizializzazione del Server MCP
const mcpServer = new Server(
  { name: "gui-mongodb-mcp", version: "1.0.0" },
  { capabilities: { tools: {} } }
);

// Definizione di un Tool MCP (es. get_schema)
mcpServer.setRequestHandler(
  "tools/call",
  async (request) => {
    if (request.params.name === "get_schema") {
      const { connectionId, dbName } = request.params.arguments;
      const strategy = getSessionStrategy(connectionId); // La tua logica esistente
      const schemaData = await strategy.dbSchema(dbName);
      
      return {
        content: [{ type: "text", text: JSON.stringify(schemaData, null, 2) }],
      };
    }
    // ... gestione altri tools ...
  }
);

// Setup Endpoint SSE su Express (app esistente)
let mcpTransport;
app.get("/mcp/sse", async (req, res) => {
  mcpTransport = new SSEServerTransport("/mcp/messages", res);
  await mcpServer.connect(mcpTransport);
});

app.post("/mcp/messages", async (req, res) => {
  await mcpTransport.handlePostMessage(req, res);
});
```

---

## 6. Piano di Sviluppo (Roadmap)

1. **Fase 1: Proof of Concept (PoC) in sola lettura** ✅ *(implementata, luglio 2026 — vedi §7)*
   - Implementare il server MCP via SSE nel `server.js` esistente.
   - Esporre unicamente strumenti di *lettura*: lettura connessioni salvate, esplorazione schema e query SELECT/find limitate.
2. **Fase 2: Prompts & Resources** ✅ *(implementata, 10/07/2026 — vedi §7)*
   - Esporre *Prompts* MCP standardizzati e parametrizzati (es. `genera-report`
     con argomenti `database` e `periodo`), così l'AI riceve istruzioni coerenti
     invece di prompt improvvisati dall'utente.
   - Pubblicare lo schema del database come *Resource* MCP: diagramma UML in
     formato testuale (Mermaid o PlantUML) più un dizionario dati sintetico
     (tabelle, colonne, relazioni, vincoli). Aggiornare la risorsa automaticamente
     a ogni cambio di schema per evitare che l'AI ragioni su una struttura obsoleta.
   - Definire una convenzione di naming e descrizioni chiare per ogni prompt/resource:
     la qualità delle descrizioni è ciò che permette all'AI di scegliere lo strumento giusto.

3. **Fase 3: Operazioni di scrittura (opzionale, con misure di sicurezza)** ✅ *(implementata, 10/07/2026 — vedi §7)*
   - Introdurre un flag `read_only = true` per connessione in `connections.ini`,
     attivo di default: le scritture vanno abilitate esplicitamente, mai il contrario.
   - Applicare il vincolo a livello di connessione DB (utente SQL con soli permessi
     `SELECT`), non solo a livello applicativo: se il controllo sta solo nel codice
     del server MCP, un bug lo aggira.
   - Separare i tool: `query` (sola lettura) ed `execute` (scrittura) come strumenti
     distinti, così le policy si applicano per-tool e l'AI non può "scivolare" in
     una scrittura tramite il tool di lettura.
   - Per update/delete: richiedere conferma esplicita (human-in-the-loop), loggare
     ogni statement eseguito con timestamp e connessione, e valutare un limite sul
     numero di righe interessate (es. rifiutare `DELETE` senza `WHERE`).
---

## 7. Stato dell'implementazione (Fasi 1, 2 e 3 — 10/07/2026)

Tutte e tre le fasi sono implementate in `mcp/McpGateway.js` (montato da `server.js` con `attachMcp(app, deps)`); test e2e in `test/e2e-mcp.js` (MongoDB, tools + prompts + resources + scritture) e `test/e2e-mcp-mysql.js` (MySQL), entrambi superati in locale.

**Fase 3 — Scritture con misure di sicurezza:**

- **Flag `readOnly` per connessione** in `connections.ini` (camelCase come gli altri campi): le scritture via MCP sono consentite **solo** se la sezione dichiara esplicitamente `readOnly=false`; flag assente = sola lettura, come richiesto ("mai il contrario"). Il flag è esposto da `list_saved_connections` e la scrivibilità (`writable`) da `connect_database`, valutata al momento della connessione.
- **Tool separato `execute_write`** (il tool di lettura resta `execute_query`, che rimane blindato anche sulle connessioni scrivibili: policy per-tool). MongoDB: `operation` insert/update/delete con `doc`/`filter`/`set` in EJSON, filtri vuoti rifiutati (nuovo `collectionUpdateMany` in `MongoDbStrategy` per l'update di massa); MySQL: `sql` con solo INSERT/UPDATE/DELETE/REPLACE (niente DDL) e **UPDATE/DELETE senza WHERE rifiutati**.
- **Conferma human-in-the-loop a due passaggi**: la prima chiamata restituisce anteprima (con stima best-effort dei documenti interessati su MongoDB) + `confirm_token` monouso (scadenza 5 minuti, legato a sessione e connessione); l'esecuzione avviene solo richiamando il tool col token, che l'AI è istruita a usare solo dopo l'approvazione esplicita dell'utente. Scelto il token a due passaggi al posto dell'*elicitation* MCP perché funziona con qualunque client e non richiede lo stream SSE (le risposte del transport sono JSON).
- **Audit log**: ogni richiesta/esecuzione/fallimento è registrato in `mcp-audit.log` (JSON Lines: timestamp, sessione MCP, connessione, statement/operazione, esito; file in `.gitignore`).
- **Vincolo a livello di motore**: resta la raccomandazione di usare per le connessioni scrivibili un utente DB con privilegi minimi (per quelle in sola lettura, un utente con soli `SELECT`), così il vincolo non dipende solo dal codice del gateway.

**Estensioni post-Fase 3 (11/07/2026):**

- **Drop di database e collection**: `execute_write` accetta le `operation` `drop_collection` e `drop_database`, valide per entrambi i dbType (usano `dropCollection`/`dropDatabase` delle strategie, che proteggono i db/schemi di sistema). Stesse guardie del DML: connessione con `readOnly=false`, doppia conferma col `confirm_token`, audit; l'anteprima stima l'impatto (documenti/righe per il drop di collection, numero di collection per il drop di database). Nessun altro DDL è ammesso.
- **Tool `set_connection_read_only`**: unica modifica a `connections.ini` raggiungibile via MCP — cambia il solo flag `readOnly` di una connessione salvata (mai credenziali o altri campi), con doppia conferma in **entrambe** le direzioni e audit. Il nuovo valore vale per le connessioni aperte successivamente (serve riconnettersi con `connect_database`).

**Fase 2 — Prompts & Resources:**

- **Resource** `schema://{connectionId}/{db}` (ResourceTemplate, `text/markdown`): diagramma UML in **Mermaid** (`erDiagram`) + dizionario dati (campi, tipi, presenza %, relazioni). Invece di aggiornare la risorsa a ogni cambio di schema (che richiederebbe notifiche push, non disponibili con le risposte JSON), il contenuto è **generato al momento della lettura** da `dbSchema(db)`: mai obsoleto per costruzione.
- **Prompts** parametrizzati: `genera-report` (argomenti `connessione`, `db`, `periodo` opzionale) ed `esplora-database` (`connessione`, `db` opzionale). Entrambi guidano l'AI sul flusso corretto (connect → schema → query mirate in sola lettura → output markdown → disconnect).

**Scostamenti rispetto alla bozza di questo documento:**

- **Trasporto: Streamable HTTP anziché SSE.** Il doppio endpoint SSE (`GET /mcp/sse` + `POST /mcp/messages`) è deprecato dal protocollo 2025-03-26; l'SDK espone `StreamableHTTPServerTransport` su un singolo endpoint `POST/GET/DELETE /mcp` (risposte JSON con `enableJsonResponse`). Lo sketch con un `mcpTransport` globale avrebbe inoltre rotto i client concorrenti: ogni sessione MCP (header `mcp-session-id`) ha il proprio `McpServer` + transport. I client che parlano solo stdio (es. Claude Desktop) possono usare `npx mcp-remote http://localhost:3030/mcp`.
- **Sessioni**: come previsto, ogni sessione MCP tiene una `Map<connection_id, sessione DB>` (strategia + eventuale tunnel SSH), riusando `establishConnection`/`teardownConnection` di `server.js`; budget globale condiviso coi socket, max 8 connessioni per sessione MCP, max 32 sessioni MCP, chiusura d'ufficio dopo 30 minuti di inattività.
- **Tool aggiuntivo `disconnect_database`** per liberare le risorse esplicitamente.
- **`execute_query` su MySQL accetta solo `sql`** (niente modalità filter/WHERE): whitelist del primo token (SELECT/WITH/SHOW/DESCRIBE/EXPLAIN/TABLE/VALUES), blocco di `INTO OUTFILE/DUMPFILE` e — perché la whitelist non basta (CTE con DML, `EXPLAIN ANALYZE`) — esecuzione dentro una transazione `READ ONLY` con timeout 30 s (flag `readOnly` di `MySqlStrategy.collectionAggregate`). Su MongoDB `pipeline` rifiuta gli stage `$out`/`$merge`.
- **Sicurezza dell'endpoint**: con bind su loopback (default) le richieste con header `Host` non locale vengono rifiutate (anti DNS-rebinding).

**Registrazione nei client:**

```bash
# Claude Code
claude mcp add --transport http gui-mongodb http://localhost:3030/mcp

# Client solo-stdio (Claude Desktop): mcpServers →
# { "command": "npx", "args": ["mcp-remote", "http://localhost:3030/mcp"] }
```
