# DB Web GUI

Un clone web di DBeaver **multi-database**: esplora database e collection/tabelle,
visualizza i documenti/righe come una tabella, esegui query, modifica i dati.
Supporta **MongoDB** e **MySQL** tramite uno **Strategy Pattern**.
Tutta la comunicazione tra browser e backend avviene tramite **Socket.IO**.

## Stack

- **Backend:** Node.js, Express, Socket.IO
  - MongoDB: driver nativo `mongodb` + `bson` (EJSON)
  - MySQL: `mysql2` (pool)
  - Tunnel SSH opzionale via `ssh2`
- **Frontend:** HTML/CSS/JS vanilla (nessun framework, nessuna build)

## Avvio

```bash
npm install
npm start          # oppure: npm run dev (riavvio automatico)
```

Apri <http://localhost:3030> (porta configurabile con la variabile `PORT`):
comparirà la schermata di connessione. Nel form scegli il **tipo di database**
(MongoDB o MySQL) e inserisci host/porta/credenziali, oppure una connection string
completa (MongoDB).

### Test end-to-end

Richiedono **il server già avviato su :3030** e un DB locale in ascolto.
Creano e poi ripuliscono i database `gui_mongodb_e2e` / `gui_mysql_e2e`.

```bash
node test/e2e.js         # MongoDB su localhost:27017
node test/e2e-mysql.js   # MySQL locale (root, password vuota; porta env MYSQL_PORT, default 3306)
```

## Funzionalità

| Funzione | Come |
| --- | --- |
| Multi-database | MongoDB e MySQL, selezionabili nel form di connessione |
| Tab di connessione | più connessioni aperte insieme (stile VS Code), una sessione DB per tab |
| Tab di collection | ogni collection/tabella aperta in un proprio coll-tab con snapshot di query e vista |
| Connessioni salvate | sidebar sinistra raggruppata per cartella (`folder`); menu contestuale per aprire/testare/modificare/eliminare |
| Import/export connessioni | scambio del file `.ini` completo (password incluse) |
| Tunnel SSH | connessione via SSH (password o chiave privata + passphrase), solo in modalità "Parametri" |
| Albero database → collection/tabelle | sidebar, con conteggio documenti/righe |
| Vista tabellare | colonne = unione delle chiavi (Mongo) o colonne della tabella (MySQL) |
| Query `find` / WHERE | filtro e sort nella toolbar (JSON/EJSON per Mongo, clausola WHERE + `ORDER BY` per MySQL) |
| Query `aggregate` / SQL Raw | pipeline di aggregazione (Mongo) o SQL libero (MySQL) |
| Piano di esecuzione | `explain` (Mongo) / `EXPLAIN` (MySQL) sulla query corrente |
| Cronologia query | query eseguite, ripetibili con un click (persistita per collection) |
| Ordinamento / Paginazione | click sull'intestazione; barra in basso (25/50/100/200 per pagina) |
| Modifica di un campo | doppio click sulla cella |
| Modifica della riga intera | pulsante ✎ sulla riga (editor JSON) |
| Inserimento documento/riga | pulsante "+ Documento" |
| Eliminazione | ✕ sulla riga, oppure **bulk delete** su selezione multipla |
| Selezione celle | selezione stile Excel, copia multi-formato (TSV/JSON/CSV/Markdown/SQL), incolla, export CSV |
| Export/Import collection | export EJSON/CSV/SQL INSERT; import batch con barra di progresso e report errori |
| Gestione database/collection | tasto destro nella sidebar: crea, rinomina, elimina |
| Gestione colonne (MySQL) | aggiungi/modifica/elimina colonna (DDL) |
| Dettagli collection | tab "Dettagli": statistiche, indici, schema/colonne |
| Diagramma UML | tab "UML": collection corrente e associazioni con le altre |
| Aggiornamenti live | change stream MongoDB (badge "● LIVE"); auto-refresh dello schema in sidebar |
| Layout responsive | drawer laterale ≤900px, supporto touch/orientamento |

### Note

- L'app è **multi-database**: MongoDB usa EJSON e ObjectId; MySQL espone un `_id`
  virtuale che rappresenta la chiave primaria (`{ colonna: valore }`), con fallback
  all'intera riga se la tabella non ha PK. Per MySQL il `filter` è una clausola
  WHERE libera, il `sort` è SQL o JSON, e la modalità "SQL Raw" esegue query libere.
- Ogni **tab** ha la propria sessione server (strategia dedicata + eventuale tunnel
  SSH, quindi un client/pool per tab, max 8 per socket); alla disconnessione del
  socket vengono chiuse tutte le sessioni.
- Gli **aggiornamenti in tempo reale** (MongoDB) usano i change stream, disponibili
  solo su replica set / Atlas. Su standalone l'app funziona senza badge LIVE (usa ⟳).
  MySQL non ha watch.
- Nei filtri MongoDB puoi usare Extended JSON, es. `{ "_id": { "$oid": "..." } }`;
  le stringhe di 24 caratteri esadecimali in `_id` vengono convertite in ObjectId
  automaticamente. Per le date usa `{ "$date": "2026-01-01T00:00:00Z" }`.
- Le **connessioni salvate** vivono in `connections.ini` nella root (file in
  `.gitignore`): **password e segreti SSH sono in chiaro**, sia nel file sia
  nell'export. Nessun segreto viene mai rimandato al browser: nel form, lasciando
  vuoto il campo, resta quello già salvato.
- La **rinomina di un database MongoDB** non è nativa: l'app copia le collection
  nel nuovo database (`$out` cross-database, richiede MongoDB ≥ 4.4) e poi elimina
  l'originale.
- Le **associazioni del diagramma UML** sono euristiche (nomi dei campi, tipi
  ObjectId); per MySQL si aggiungono le foreign key reali da `information_schema`.

## Documentazione per gli agenti

- `CLAUDE.md` / `AGENT.md` — guida all'architettura per gli agenti di coding.
- `strategy_db.md` — piano storico di estensione multi-database (MongoDB & MySQL).
</content>
</invoke>
