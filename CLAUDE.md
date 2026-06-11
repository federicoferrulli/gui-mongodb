# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Regola per le risposte

L'utente si chiama **Keus**: rivolgiti a lui per nome in ogni risposta.

## Comandi

```bash
npm install
npm start            # avvia il server su http://localhost:3030 (porta: env PORT)
npm run dev          # come start, ma con riavvio automatico (node --watch)
node test/e2e.js     # test end-to-end (unico test del progetto)
```

Il test e2e richiede **il server già avviato su :3030** e un **MongoDB locale su localhost:27017**; crea e poi ripulisce il database `gui_mongodb_e2e`. Non ci sono lint né framework di test: i test usano semplici assert con `process.exitCode`.

## Architettura

GUI web stile DBeaver per MongoDB. Niente REST: **tutta la comunicazione browser↔backend passa da Socket.IO** con callback di acknowledgment; ogni risposta è `{ ok: true, ... }` oppure `{ ok: false, error }`.

- `server.js` — intero backend (Express serve solo `public/` come statici). Per ogni socket connesso viene creato **un `MongoClient` dedicato**, chiuso alla disconnessione. Eventi: `mongo:connect/disconnect` (`mongo:connect` accetta anche `saved` per usare una connessione salvata e `saveAs` per salvarla dopo un connect riuscito), `connections:list/get/save/delete/export/import` (connessioni salvate in `connections.ini` nella root, parser/serializer ini fatti in casa; **password in chiaro**, file in `.gitignore`; la password non viene mai rimandata al browser: `connections:get` la omette, `connections:save` e `mongo:connect` con `keepPasswordFrom` riusano quella salvata se il form la lascia vuota; `export`/`import` scambiano il testo `.ini` completo, password incluse), `db:list/create/rename/drop` (rename = copia via `$out` cross-db + drop, MongoDB ≥ 4.4; i db di sistema sono protetti), `db:collections`, `db:schema` (schema campionato + relazioni euristiche per l'UML, vedi `detectRelations`), `collection:find/aggregate/stats`, `doc:insert/update/replace/delete`, `collection:watch/unwatch` (change stream → emette `collection:changed`; su server standalone degrada emettendo `watch:unavailable`).
- `public/js/app.js` — intero frontend (vanilla JS, nessuna build, nessun framework). Stato in un singolo oggetto `state`; rendering manuale del DOM. Il workspace ha tre viste (`setView`): **Dati** (griglia), **Dettagli** (statistiche/indici/schema) e **UML** (SVG generato in `renderUml`). Menu contestuale generico in `showContextMenu` (tasto destro su database e collection nella sidebar).
- `public/index.html` + `public/css/style.css` — markup e stile.

### Convenzione EJSON (il punto più delicato)

I documenti viaggiano come **Extended JSON**: il server serializza con `EJSON.serialize(..., { relaxed: true })` (numeri normali, ma ObjectId/Date restano `$oid`/`$date`) e fa il parse degli input utente con `EJSON.parse(..., { relaxed: false })`. Il frontend riconosce e renderizza le forme `$oid`, `$date`, `$numberLong`, ecc. (vedi `displayValue`/`simplify` in app.js). Gli `_id` vengono passati dal client come stringhe EJSON (`JSON.stringify(doc._id)`) e riconvertiti lato server da `parseId`; le stringhe `_id` di 24 caratteri esadecimali vengono promosse automaticamente a ObjectId (`promoteObjectIds`). Qualsiasi modifica al flusso dati deve preservare questa convenzione su entrambi i lati.

I testi UI, i messaggi di errore e i commenti sono in **italiano**: mantieni la coerenza.
