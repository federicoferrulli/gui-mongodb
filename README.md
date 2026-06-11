# Mongo Web GUI

Un clone web di DBeaver per MongoDB: esplora database e collection, visualizza i
documenti come righe/colonne di una tabella, esegui query, modifica i dati.
Tutta la comunicazione tra browser e backend avviene tramite **Socket.IO**.

## Stack

- **Backend:** Node.js, Express, Socket.IO, driver nativo `mongodb` + `bson` (EJSON)
- **Frontend:** HTML/CSS/JS vanilla (nessun framework, nessuna build)

## Avvio

```bash
npm install
npm start          # oppure: npm run dev (riavvio automatico)
```

Apri <http://localhost:3030> (porta configurabile con la variabile `PORT`):
comparirà la schermata di connessione (host/porta/
credenziali oppure connection string completa).

## Funzionalità

| Funzione | Come |
| --- | --- |
| Connessione con credenziali | modale all'apertura (parametri o URI) |
| Connessioni salvate | campo "Salva come" al connect, oppure ✎ per modificare/rinominare e 💾 per salvare senza connettersi; click per riconnettersi, ✕ per eliminare |
| Import/export connessioni | pulsanti "⤓ Esporta" / "⤒ Importa" nel modale di connessione (file `.ini`) |
| Albero database → collection | sidebar, con conteggio documenti |
| Vista tabellare | colonne = unione delle chiavi dei documenti |
| Query `find` | filtro e sort in JSON/Extended JSON nella toolbar |
| Query `aggregate` | seleziona "aggregate" e inserisci la pipeline |
| Ordinamento | click sull'intestazione di colonna |
| Paginazione | barra in basso (25/50/100/200 per pagina) |
| Modifica di un campo | doppio click sulla cella → Invio per salvare, Esc per annullare |
| Modifica della riga intera | pulsante ✎ sulla riga (editor JSON del documento) |
| Inserimento documento | pulsante "+ Documento" (editor JSON) |
| Eliminazione documento | pulsante ✕ sulla riga |
| Gestione database | tasto destro su un database nella sidebar: crea, rinomina, elimina |
| Dettagli collection | tab "Dettagli": statistiche, indici e schema dedotto da un campione |
| Diagramma UML | tab "UML": la collection corrente e le associazioni con le altre |
| Aggiornamenti live | change stream MongoDB (badge "● LIVE") |

### Note

- Gli **aggiornamenti in tempo reale** usano i change stream, disponibili solo su
  replica set / Atlas. Su un server standalone l'app funziona comunque, ma senza
  badge LIVE (usa ⟳ per ricaricare).
- Nei filtri puoi usare Extended JSON, es. `{ "_id": { "$oid": "..." } }`;
  le stringhe di 24 caratteri esadecimali in `_id` vengono convertite in
  ObjectId automaticamente.
- Nelle celle: i numeri/booleani/oggetti digitati vengono interpretati come JSON,
  tutto il resto come stringa. Per le date usa `{ "$date": "2026-01-01T00:00:00Z" }`.
- Ogni scheda del browser apre una propria connessione MongoDB, chiusa
  automaticamente alla disconnessione del socket.
- Le **connessioni salvate** vivono in `connections.ini` nella root del progetto
  (file in `.gitignore`): le **password sono in chiaro**, sia nel file sia
  nell'export. La password non viene mai rimandata al browser: nel form di
  modifica, lasciandola vuota, resta quella già salvata.
- La **rinomina di un database** non è un'operazione nativa di MongoDB:
  l'app copia le collection nel nuovo database (`$out` cross-database,
  richiede MongoDB ≥ 4.4, indici inclusi) e poi elimina l'originale.
- Le **associazioni del diagramma UML** sono euristiche: vengono dedotte dai
  nomi dei campi (`user_id`, `userId`, `user_ids` → collection `users`/`user`)
  e dai campi di tipo ObjectId, su un campione di documenti per collection.
