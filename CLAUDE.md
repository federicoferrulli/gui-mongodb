# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

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

- `server.js` — livello di trasporto: Express serve solo `public/` come statici; gestisce `connections.ini` e delega tutti gli eventi DB alla strategia attiva. Per ogni socket connesso viene creata **una strategia dedicata** (e quindi un client/pool dedicato), chiusa alla disconnessione. Eventi: `mongo:connect/disconnect` (nomi storici, valgono per qualunque dbType; `mongo:connect` accetta anche `saved` per usare una connessione salvata e `saveAs` per salvarla dopo un connect riuscito, e risponde con `dbType`), `connections:list/get/save/delete/export/import` (connessioni salvate in `connections.ini` nella root, parser/serializer ini fatti in casa; campi `dbType` — default `mongodb` se assente — e `database` per MySQL; **password in chiaro**, file in `.gitignore`; la password non viene mai rimandata al browser: `connections:get` la omette, `connections:save` e `mongo:connect` con `keepPasswordFrom` riusano quella salvata se il form la lascia vuota; `export`/`import` scambiano il testo `.ini` completo, password incluse), `db:list/create/rename/drop`, `db:collections`, `db:schema`, `collection:find/aggregate/stats`, `doc:insert/update/replace/delete`, `collection:watch/unwatch`.
- `db/` — Strategy Pattern: `DbStrategy.js` (interfaccia base + euristiche `detectRelations` condivise per l'UML), `MongoDbStrategy.js` (un `MongoClient` per istanza; rename = copia via `$out` cross-db + drop, MongoDB ≥ 4.4; db di sistema protetti; change stream per `collection:watch`, su standalone degrada emettendo `watch:unavailable`), `MySqlStrategy.js` (pool `mysql2`; `_id` virtuale = chiave primaria come oggetto `{ colonna: valore }`, fallback all'intera riga senza PK; `filter` = clausola WHERE libera, `sort` = SQL libero o JSON `{"col":1}`, `collection:aggregate` = SQL Raw; schema/relazioni da `information_schema` con FK reali + euristiche; schemi di sistema protetti; niente watch), `DbFactory.js` (`getStrategy(dbType)`).
- `public/js/app.js` — intero frontend (vanilla JS, nessuna build, nessun framework). Stato in un singolo oggetto `state`; rendering manuale del DOM. Il workspace ha tre viste (`setView`): **Dati** (griglia), **Dettagli** (statistiche/indici/schema) e **UML** (SVG generato in `renderUml`). Menu contestuale generico in `showContextMenu` (tasto destro su database e collection nella sidebar).
- `public/index.html` + `public/css/style.css` — markup e stile.

### Convenzione EJSON (il punto più delicato)

I documenti viaggiano come **Extended JSON**: il server serializza con `EJSON.serialize(..., { relaxed: true })` (numeri normali, ma ObjectId/Date restano `$oid`/`$date`) e fa il parse degli input utente con `EJSON.parse(...)` — `relaxed: false` per MongoDB (preserva i tipi BSON), `relaxed: true` per MySQL (produce tipi JS nativi da usare come parametri SQL). Vale anche per le righe MySQL: le colonne DATETIME arrivano al client come `$date`. Il frontend riconosce e renderizza le forme `$oid`, `$date`, `$numberLong`, ecc. (vedi `displayValue`/`simplify` in app.js) e l'editing inline sceglie il controllo in base al tipo (`valueType`/`buildEditor`). Gli `_id` vengono passati dal client come stringhe EJSON (`JSON.stringify(doc._id)`) e riconvertiti lato server dalla strategia (`parseId` per Mongo, con promozione automatica delle stringhe di 24 hex a ObjectId via `promoteObjectIds`; `parseRowId` per MySQL). Qualsiasi modifica al flusso dati deve preservare questa convenzione su entrambi i lati.

I testi UI, i messaggi di errore e i commenti sono in **italiano**: mantieni la coerenza.
