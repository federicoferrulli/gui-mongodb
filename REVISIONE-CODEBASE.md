# Revisione codebase — 15 luglio 2026

Revisione completa di backend (`server.js`, `mcp/McpGateway.js`, `db/*`, `backup/lib/*`) e
moduli portanti del frontend (`utils.js`, `tabs.js`, `live.js`, `grid.js`, `uml.js`),
alla ricerca di bug critici e punti semplificabili.

Stato: tutte le sezioni sono state applicate. **Bug critici corretti** e **Correzioni di
scalabilità** sono verificate con suite e2e (Mongo, MCP, backup) + test di robustezza
dedicato. **Punti aperti** (B, C, D) e **Semplificazioni proposte** (1-6) sono state
applicate in una sessione successiva (21 luglio 2026) ma verificate solo con `node -c`,
non con le suite e2e: l'ambiente di quella sessione non aveva MongoDB/MySQL locali
raggiungibili. Da eseguire manualmente prima del prossimo deploy: `node test/e2e.js`,
`node test/e2e-mcp.js`, `node test/e2e-backup.js`, `node test/e2e-dbexport.js`.

---

## Bug critici corretti ✅

### 1. Un client socket malformato faceva crashare il server

**Dov'era:** `server.js`, tutti gli handler Socket.IO.

Gli handler chiamavano `cb(...)` incondizionatamente e alcuni destrutturavano il payload
nella firma (`({ name }, cb)`). Un client che emetteva un evento **senza callback di
acknowledgment** o **con payload `null`** provocava un `TypeError` che, dentro un handler
`async`, diventava una unhandled rejection: su Node moderno **il processo termina**.
Qualunque processo su localhost poteva abbattere CodeDB con una singola emit.

**Fix:** wrapper `safeOn(event, fn)` usato da tutti gli handler (incluso `delegate`):
payload sempre normalizzato a oggetto, ack sempre presente e monouso, qualsiasi errore
(sincrono o async) convertito nella risposta `{ ok: false, error }`. Effetto collaterale:
spariti ~10 blocchi try/catch ripetitivi.

### 2. `connections:import` poteva impedire l'avvio del server

**Dov'era:** `server.js`, handler `connections:import`.

L'import accettava segreti `ENC:` senza verificare che si decifrassero con la passphrase
corrente. Importando un `.ini` esportato con un'altra passphrase, al riavvio successivo
`decryptFailures > 0` e il server **rifiutava di partire** finché non si rimuoveva a mano
la sezione incriminata.

**Fix:** ogni segreto `ENC:` in ingresso viene provato con la chiave corrente
(`decryptRaw`); se non si decifra l'import è rifiutato con un messaggio che spiega le
alternative (riesportare con la stessa passphrase, o importare senza segreti).

### 3. Perdita silenziosa di segreti a runtime

**Dov'era:** `server.js`, `decryptSecret`.

Il controllo anti-azzeramento dei segreti valeva solo all'avvio. Se una decifratura
falliva **a runtime**, `decryptSecret` restituiva `""`: il successivo
`connections:save` di *qualunque* connessione riscriveva l'intero file col segreto
svuotato — lo stesso rischio per cui è nato il sistema `.bak`/`.bak2`, raggiungibile da
una porta laterale.

**Fix:** in caso di fallimento `decryptSecret` restituisce **il testo cifrato originale**
invece di stringa vuota. Poiché `encryptSecret` lascia passare i valori già `ENC:`, ogni
salvataggio successivo conserva il cifrato intatto: il segreto non va mai perso. Il
controllo `decryptFailures` all'avvio resta invariato.

---

## Correzioni di scalabilità ✅

### 4. Conteggio esatto a ogni pagina su collection grandi

**Dov'era:** `db/MongoDbStrategy.js`, `collectionFind`.

Ogni `collection:find`, anche con filtro vuoto, eseguiva `countDocuments({})`: una
scansione completa della collection **a ogni paginazione**.

**Fix:** con filtro vuoto si usa `estimatedDocumentCount()` (conteggio dai metadati,
istantaneo); con filtro resta il conteggio esatto. Su MySQL il `COUNT(*)` esatto è stato
lasciato di proposito: la stima `TABLE_ROWS` di InnoDB può sbagliare anche del 40% e
falserebbe la paginazione.

### 5. Loop infinito su catena di backup circolare

**Dov'era:** `backup/lib/restore.js`, `resolveChain`.

Un manifest corrotto con `baseId` circolare mandava il restore in loop infinito.

**Fix:** `Set` dei percorsi visitati; una catena circolare ora produce un errore chiaro.

### B. Export con skip/limit: quadratico sulle collection grandi ✅

**Dov'era:** `collectionExport` in `MongoDbStrategy.js` (`find({}).skip(skip)`) e
`MySqlStrategy.js` (`LIMIT ? OFFSET ?`): ogni blocco riparte dall'inizio, quindi esportare
milioni di righe a blocchi da 1000 era di fatto **O(n²)**. La CLI di backup non era
affetta (usa cursor/stream veri).

**Fix:** paginazione keyset. Su Mongo `find({_id: {$gt: lastId}}).sort({_id: 1})`
(`payload.after` = EJSON dell'ultimo `_id`, sempre presente e indicizzato). Su MySQL
cursore sulla chiave primaria con confronto per tupla `WHERE (pk1, pk2) > (?, ?) ORDER BY
pk1, pk2`; le tabelle **senza** chiave primaria (nessun ordinamento stabile disponibile)
mantengono il vecchio `skip/OFFSET` come ripiego. Entrambe le strategie restituiscono
`nextAfter`; `exportimport.js` lo fa viaggiare al posto di (oltre a) `skip` nei due loop di
export (collection singola e intero database).

**Da verificare manualmente:** non è stato possibile eseguire `node test/e2e-dbexport.js`
in questo ambiente (nessun MongoDB/MySQL locale in ascolto su 27017/3306); solo
`node -c` sui file toccati.

### C. Import MySQL riga per riga ✅

**Dov'era:** `collectionImport` in `MySqlStrategy.js` faceva un `INSERT` per riga (per
contare ok/errori). Il restore usava già il multi-VALUES a batch da 500 (`restore.js`),
~50-100× più veloce.

**Fix:** le righe vengono raggruppate per insieme di colonne (stesso ordine, il caso
comune quando il blocco viene da un export della stessa tabella) in batch da 500 e
inserite con un unico `INSERT ... VALUES ?` multi-riga (stesso pattern di
`backup/lib/restore.js`); se un batch fallisce (es. un solo vincolo violato) viene
ripetuto riga per riga solo per quel batch, così l'errore resta isolato e il report
ok/errori per riga non cambia.

**Da verificare manualmente:** non è stato possibile eseguire i test e2e in questo
ambiente (nessun MySQL locale in ascolto su 3306); solo `node -c`.

### D. Bug minori ✅

- **`renameDatabase` (Mongo) perde le view**: se il db sorgente ne contiene, ora la
  rinomina viene **rifiutata** con un errore che le elenca, invece di droppare il db
  sorgente e farle sparire in silenzio.
- **`listDatabases`/`search` (Mongo), ramo di ripiego**: `new URL(...)` estratto in un
  helper `dbNameFromUri()` che intercetta il proprio fallimento (URI con caratteri
  particolari) e torna `null` invece di lanciare un errore diverso da quello originale.
- **`appendToCatalog`** (`backup/lib/util.js`): read-modify-write ora protetto da un lock
  file (`.catalog.lock`, creazione esclusiva con attesa/ripiego su lock stantio) — un
  backup CLI e uno via MCP simultanei sullo stesso gruppo non si perdono più una voce.
- **`mermaidId`** (`McpGateway.js`): nuovo `makeMermaidEntityIdResolver()` disambigua le
  collisioni tra nomi di collection diversi che si riducono allo stesso id sanitizzato
  (es. `a-b` e `a_b`), usato per entità e relazioni nel diagramma; i nomi di campo/tipo
  restano come prima (collisione lì è puramente cosmetica).
- **Tunnel SSH**: `openSshTunnel` espone ora `alive`/`lastError`, aggiornati se la
  connessione SSH cade dopo l'apertura; `delegate()` in `server.js` intercetta gli errori
  di sessioni con tunnel non più vivo e li sostituisce con "Tunnel SSH caduto: …" invece
  del generico errore di rete del driver DB.
- **Log senza rotazione**: `mcp-audit.log` (`McpGateway.js`) e `backups/backup.log`
  (`backup/lib/logger.js`) ora ruotano su un singolo file `.1` quando superano 5 MB.
- **Un solo change stream per sessione**: comportamento confermato intenzionale (limita i
  change stream aperti per sessione), reso esplicito con un commento in `watch()`
  (`MongoDbStrategy.js`) — nessun cambio di comportamento.

**Da verificare manualmente:** nessuna suite e2e eseguita in questo ambiente (niente
MongoDB/MySQL/server SSH locali disponibili); solo `node -c` sui file toccati.

---

## Semplificazioni proposte (nessun cambio di comportamento) ✅

1. **`McpGateway.js` — `confirmFlow`**: `execute_write`, `set_connection_read_only` e
   `restore_backup` ripetevano tre volte la stessa danza del token a due passaggi.
   Estratto `confirmFlow.consume(token, kind, matches, mismatchNoun)` +
   `confirmFlow.issue(kind, data, { toolName, preview, extra })` (righe ~425-458): i tre
   tool ora chiamano solo questi due metodi; audit log e notifiche Slack (specifiche di
   `restore_backup`) restano nei call site perché differiscono per tool.
2. **`server.js` — `encryptSections()`**: estratta la cifratura dei segreti in una
   funzione condivisa (subito prima di `saveConnections`, ~riga 139), usata sia da
   `saveConnections` sia dall'handler `connections:export`.
3. **`server.js` — `resolveEffectiveCfg`**: ora chiama `loadConnections()` una sola
   volta (~riga 203-224), riusata sia per `cfg.saved` sia per `cfg.keepPasswordFrom`.
4. **`MySqlStrategy.js` — `buildSelect(db, coll, payload)`**: nuovo metodo (~righe
   304-314) che centralizza WHERE/ORDER/LIMIT/OFFSET; usato da `collectionFind` e dal
   ramo "find" di `collectionExplain` (il ramo "aggregate", che usa `payload.pipeline`,
   non serviva e non è stato toccato).
5. **`MySqlStrategy.js` — check di esistenza ridondanti**: rimosso il check preventivo
   via `listDatabases()` in `createDatabase`/`renameDatabase` (eliminata anche la
   race TOCTOU); `CREATE DATABASE` ora gira in un `try/catch` che traduce
   `err.code === 'ER_DB_CREATE_EXISTS'` nello stesso messaggio percepito di prima.
6. **`backup/lib/engine.js`**: corretto il refuso `${'incrementale'}` nel template
   literal (era già stringa fissa a runtime, nessun impatto funzionale).

Applicate tramite 3 agenti in parallelo (uno per gruppo di file, per evitare conflitti:
McpGateway.js / server.js / MySqlStrategy.js) più la correzione diretta del punto 6.
`node -c` passato su tutti i file toccati.

**Da verificare manualmente:** nessuna suite e2e eseguita in questo ambiente (niente
MongoDB/MySQL locali disponibili).

---

## Nota positiva

Il frontend è disciplinato: la griglia usa `createElement`/`textContent`, UML e modali
escapano tutto con `esc()`, i timer dei tab vengono puliti alla chiusura
(`closeTab`/`closeAllTabs`). Nessun XSS da contenuti del database rilevato.

## Come è stato verificato

- `node test/e2e.js` — suite MongoDB completa: tutti superati.
- `node test/e2e-mcp.js` — suite MCP (fasi 1+2+3): tutti superati.
- `node test/e2e-backup.js` — suite CLI backup: tutti superati.
- Test di robustezza dedicato: raffica di emit senza callback e con payload `null` su
  tutti gli eventi, poi verifica che il server risponda ancora e che l'import di
  segreti `ENC:` estranei venga rifiutato.
- I test sono girati su un'istanza dedicata (porta 3030, `connections.ini` temporaneo
  via `CODEDB_CONNECTIONS_FILE`, passphrase di test): il file reale non è mai stato toccato.
