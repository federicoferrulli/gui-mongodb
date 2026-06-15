# SEC-02 — Nessuna autenticazione, binding su tutte le interfacce, query arbitrarie

| Stato | Categoria | Priorità | Difficoltà |
| :---: | :--- | :---: | :---: |
| 🔴 Aperta | Sicurezza | Alta | Media |

## Descrizione

L'applicazione **non ha alcuno strato di autenticazione/autorizzazione**: chiunque possa
raggiungere la porta HTTP/Socket.IO ottiene il pieno controllo dei database raggiungibili
dal server, usando le credenziali memorizzate (e potendole esportare in chiaro, vedi
[SEC-01](SEC-01-cifratura-segreti-salvati.md)).

Tre fattori si combinano e amplificano il rischio:

1. **Binding su tutte le interfacce.** Il server ascolta senza host esplicito:

   ```js
   server.listen(PORT, () => { ... });
   ```

   `server.listen(PORT)` espone l'app su `0.0.0.0`, quindi è raggiungibile da tutta la
   rete locale, non solo da `localhost`.

2. **Esecuzione di query arbitrarie by-design.** Le strategie eseguono input utente quasi
   senza vincoli:
   - MySQL: `filter` è una **clausola WHERE libera**, `sort` è **SQL libero**, e
     `collection:aggregate` è **SQL Raw** (`USE <db>; <query>`), inclusi DDL/DML.
   - MongoDB: `find`/`aggregate` accettano filtri e pipeline arbitrarie.

   È una funzionalità voluta per una GUI da database, ma combinata con l'assenza di auth
   significa che un visitatore non autenticato può leggere, modificare o distruggere dati.

3. **Esfiltrazione dei segreti dalla UI.** `connections:export` restituisce l'intero
   `connections.ini` con i segreti in chiaro a qualunque client connesso.

## Impatto

Accesso non autenticato completo ai database configurati e furto delle credenziali
(DB e SSH) da qualsiasi host in grado di raggiungere la porta del server.

## Soluzione proposta

- **Binding di default su `127.0.0.1`**, rendendo l'host configurabile via env
  (es. `HOST`), così l'esposizione in rete è una scelta esplicita.
- Introdurre **autenticazione** sull'app (anche minimale): es. una passphrase/sessione o
  Basic Auth a protezione sia degli asset statici sia dell'handshake Socket.IO.
- Documentare chiaramente in `README`/`CLAUDE.md` che lo strumento è pensato per uso
  **locale** e quali precauzioni adottare prima di esporlo.
- Subordinare le operazioni sensibili (`connections:export`, esecuzione SQL Raw) all'essere
  autenticati.

## Riferimenti nel codice

- `server.js` — `server.listen(PORT, ...)`, handler `connections:export`,
  `collection:find/aggregate`.
- `db/MySqlStrategy.js` — `collectionFind` (WHERE libero), `buildOrderBy`,
  `collectionAggregate` (SQL Raw).

## Criteri di accettazione

- [ ] Di default il server è raggiungibile solo da `localhost`; l'esposizione in rete è
      opt-in ed esplicita.
- [ ] L'accesso alla UI e agli eventi Socket.IO richiede autenticazione (almeno opzionale
      e attivabile).
- [ ] Il modello di sicurezza e d'uso previsto è documentato.
