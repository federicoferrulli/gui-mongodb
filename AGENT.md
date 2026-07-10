# AGENT.md

This file provides guidance to AI coding agents when working with code in this repository. (Allineato a `CLAUDE.md`.)

## Regola per le risposte

L'utente si chiama **Keus**: rivolgiti a lui per nome in ogni risposta.

## Comandi

```bash
npm install
npm start                  # avvia il server su http://localhost:3030 (porta: env PORT)
npm run dev                # come start, ma con riavvio automatico (node --watch)
node test/e2e.js           # test end-to-end MongoDB
node test/e2e-mysql.js     # test end-to-end MySQL (porta: env MYSQL_PORT, default 3306)
```

I test e2e richiedono **il server già avviato su :3030** e rispettivamente un **MongoDB locale su localhost:27017** o un **MySQL locale (root, password vuota)**; creano e poi ripuliscono i database `gui_mongodb_e2e` / `gui_mysql_e2e`. Non ci sono lint né framework di test: i test usano semplici assert con `process.exitCode`.

## Architettura

GUI web stile DBeaver, multi-database (**MongoDB** e **MySQL** via Strategy Pattern). Niente REST: **tutta la comunicazione browser↔backend passa da Socket.IO** con callback di acknowledgment; ogni risposta è `{ ok: true, ... }` oppure `{ ok: false, error }`.

- `server.js` — livello di trasporto: Express serve solo `public/` come statici; gestisce `connections.ini` e delega tutti gli eventi DB alla sessione indicata dal `tabId` nel payload. Per ogni socket il server tiene una **`Map<tabId, sessione>`** (sessione = strategia dedicata + eventuale tunnel SSH, quindi un client/pool per tab, max 8 per socket); `tabId` assente = sessione `"default"` (retro-compatibile col comportamento a connessione singola). Alla disconnessione del socket vengono chiuse tutte le sessioni. Eventi: `mongo:connect/disconnect` (nomi storici, valgono per qualunque dbType e per-tab; `mongo:connect` accetta anche `saved` per usare una connessione salvata e `saveAs` per salvarla dopo un connect riuscito, e risponde con `dbType` e `tabId`), `connections:test` (connect + listDatabases + disconnect immediato, senza toccare le sessioni), `connections:list/get/save/delete/export/import` (connessioni salvate in `connections.ini` nella root, parser/serializer ini fatti in casa; campi `dbType` — default `mongodb` se assente —, `database` per MySQL e `folder` per il raggruppamento in UI; **password in chiaro**, file in `.gitignore`; la password non viene mai rimandata al browser: `connections:get` la omette, `connections:save` e `mongo:connect` con `keepPasswordFrom` riusano quella salvata se il form la lascia vuota; `export`/`import` scambiano il testo `.ini` completo, password incluse), `db:list/search/create/rename/drop`, `db:collections`, `db:schema`, `collection:create/rename/drop` (`create` accetta `columns` per lo schema MySQL), `column:add/alter/drop` (solo MySQL), `index:create/drop`, `collection:find/aggregate/stats`, `collection:explain` (piano di esecuzione: `explain` MongoDB / `EXPLAIN` MySQL), `doc:insert/update/replace/delete`, `collection:deleteMany` (bulk delete per lista di `_id`), `collection:export/import` (export EJSON/CSV/SQL INSERT e import batch), `collection:watch/unwatch` e `schema:watch/unwatch` (gli eventi push `collection:changed`, `schema:changed` e `watch:unavailable` sono taggati col `tabId` della sessione).
- `db/` — Strategy Pattern: `DbStrategy.js` (interfaccia base + euristiche `detectRelations` condivise per l'UML), `MongoDbStrategy.js` (un `MongoClient` per istanza; rename = copia via `$out` cross-db + drop, MongoDB ≥ 4.4; db di sistema protetti; change stream per `collection:watch`, su standalone degrada emettendo `watch:unavailable`), `MySqlStrategy.js` (pool `mysql2`; `_id` virtuale = chiave primaria come oggetto `{ colonna: valore }`, fallback all'intera riga senza PK; `filter` = clausola WHERE libera, `sort` = SQL libero o JSON `{"col":1}`, `collection:aggregate` = SQL Raw; schema/relazioni da `information_schema` con FK reali + euristiche; schemi di sistema protetti; niente watch), `DbFactory.js` (`getStrategy(dbType)`).
- `public/js/` — frontend modulare (vanilla JS, nessuna build, nessun framework). Lo stato vive **per tab** in `tabs.js` (registro dei tab: ognuno ha `id` = tabId della sessione server, metadati e un proprio `state` creato da `freshState()`); `state.js` esporta un **Proxy che delega allo stato del tab attivo**, così i moduli storici leggono/scrivono "un singolo oggetto" senza sapere dei tab. Tutte le richieste passano da `emit()`/`notify()` in `utils.js`, che iniettano il `tabId` del tab attivo catturato al momento della chiamata (la risposta porta il tab d'origine in `_tab`; se il tab è stato chiuso la risposta viene scartata). Utility condivise in `utils.js`. L'entrypoint è `main.js`, che coordina i moduli:
  - `tabs.js`: Registro dei tab di connessione (createTab/switchTab/closeTab/closeAllTabs, onTabChange)
  - `tabbar.js`: Barra dei tab di connessione (stile VS Code, click centrale = chiudi, ＋ = nuova connessione)
  - `colltabs.js`: Tab di secondo livello per le collection/tabelle aperte dentro un tab di connessione (`state.collTabs`); ogni coll-tab ha uno **snapshot** di query/risultati/vista ripristinato alla riattivazione; drop/rename di db e collection chiudono/aggiornano i coll-tab (`closeCollTabsWhere`/`updateCollTabs`)
  - `connmanager.js`: Sidebar sinistra con le connessioni salvate raggruppate per cartella (`folder`), menu contestuale (apri in nuovo tab / testa / modifica / elimina)
  - `connection.js`: Modale di connessione (form) e `connectAndOpenTab` (il tab compare solo a connessione riuscita)
  - `workspace.js`: Ri-render del workspace condiviso dallo stato del tab attivo (`renderWorkspace`/`saveWorkspaceInputs`) — il DOM del workspace è **unico**, al cambio tab viene ri-popolato
  - `utils.js`: Helper vari (EJSON, stringhe, modali, socket, errori) + `emit`/`notify` col tabId
  - `dbtree.js`: Render della sidebar interna coi DB del tab attivo
  - `schema-ops.js`: Modali di creazione/alter (DDL)
  - `grid.js`: Griglia dati, query SQL/Mongo e impaginazione (`selectCollection` apre un coll-tab)
  - `inlineEdit.js`: Editing al volo della riga
  - `insert.js`: Inserimento nuovo documento/riga
  - `details.js`: Vista statistiche, indici e definizioni colonne
  - `live.js`: Logica di polling / socket watch (eventi push instradati per tabId)
  - `autocomplete.js`: Autocomplete contestuale per filtri e ordinamenti
  - `exportimport.js`: Modali di export (EJSON/CSV/SQL INSERT) e import batch con progresso e report errori
  - `queryhistory.js`: Cronologia delle query eseguite (persistita in localStorage per collection)
  - `cellselect.js`: Selezione celle stile Excel, copia multi-formato (TSV/JSON/CSV/Markdown/SQL), incolla da Excel, selezione colonne ed export CSV
  - `responsive.js`: Adattamento layout per viewport piccole (drawer ≤900px, touch/orientamento)
  - `socket.js` e `uml.js`. Il workspace ha tre viste (`setView`): **Dati** (griglia), **Dettagli** (statistiche/indici/schema) e **UML** (SVG generato in `uml.js`); la vista è ricordata per coll-tab. Menu contestuale generico (tasto destro su connessioni, database e collection). Layout con sidebar ridimensionabili (`.resizer`, larghezze in localStorage).
- `public/index.html` + `public/css/style.css` — markup e stile.
- `db/SshTunnel.js` — `openSshTunnel(ssh, target)`: tunnel SSH condiviso (ortogonale al dbType, basato su `ssh2`). Apre una porta locale effimera su `127.0.0.1` che inoltra verso `target.host:target.port` sul lato remoto; auth via password **oppure** chiave privata (`sshKeyFile`, percorso su disco) + `sshPassphrase`. `server.js` apre the tunnel in `mongo:connect` quando `cfg.ssh === 'true'` (solo modalità "Parametri", non con URI completa), riscrive `host/port` verso il capo locale prima di `strategy.connect` (per MongoDB aggiunge `directConnection=true`) e lo chiude in `closeStrategy`. I campi SSH (`ssh`, `sshHost`, `sshPort`, `sshUser`, `sshPassword`, `sshKeyFile`, `sshPassphrase`) sono salvati in `connections.ini`; `sshPassword` e `sshPassphrase` sono **segreti** (`SECRET_FIELDS`) gestiti come la password DB: mai rimandati al browser, riusati se il form li lascia vuoti.

### Convenzione EJSON (il punto più delicato)

I documenti viaggiano come **Extended JSON**: il server serializza con `EJSON.serialize(..., { relaxed: true })` (numeri normali, ma ObjectId/Date restano `$oid`/`$date`) e fa il parse degli input utente con `EJSON.parse(...)` — `relaxed: false` per MongoDB (preserva i tipi BSON), `relaxed: true` per MySQL (produce tipi JS nativi da usare come parametri SQL). Vale anche per le righe MySQL: le colonne DATETIME arrivano al client come `$date`. Il frontend riconosce e renderizza le forme `$oid`, `$date`, `$numberLong`, ecc. (vedi `displayValue`/`simplify` in app.js) e l'editing inline sceglie il controllo in base al tipo (`valueType`/`buildEditor`). Gli `_id` vengono passati dal client come stringhe EJSON (`JSON.stringify(doc._id)`) e riconvertiti lato server dalla strategia (`parseId` per Mongo, con promozione automatica delle stringhe di 24 hex a ObjectId via `promoteObjectIds`; `parseRowId` per MySQL). Qualsiasi modifica al flusso dati deve preservare questa convenzione su entrambi i lati.

I testi UI, i messaggi di errore e i commenti sono in **italiano**: mantieni la coerenza.
