# FEAT-01 — UI differenziata per tipo di database

| Stato | Categoria | Priorità | Difficoltà |
| :---: | :--- | :---: | :---: |
| ✅ Risolta | Feature / UX | — | — |

## Descrizione (storica)

L'analisi originale segnalava che la UI mostrava sempre i campi "Filtro" e "Sort" con
descrizioni orientate solo a MongoDB (es. `Filtro, es. { "age": { "$gt": 30 } }`), senza
adattarsi a MySQL.

## Stato attuale

**Già implementata** nel codice. Alla connessione e al cambio di modalità query la UI si
adatta dinamicamente al DBMS:

- `applyDbTypeToWorkspace()` rinomina la seconda opzione del menu modalità in **`SQL Raw`**
  per MySQL (`aggregate` per MongoDB) e aggiorna i suggerimenti dell'UML.
- `applyQueryPlaceholders()` cambia i placeholder:
  - MySQL → `Clausola WHERE, es. age > 30` e `Ordinamento, es. name ASC oppure {"name":1}`;
  - MongoDB → `Filtro, es. { "age": { "$gt": 30 } }` e `Sort, es. { "name": 1 }`.
- Il campo `sort` viene nascosto in modalità aggregate/SQL Raw.

## Riferimenti nel codice

- `public/js/app.js` — `applyDbTypeToWorkspace`, `applyQueryPlaceholders`,
  listener su `#query-mode`.

## Note

Issue mantenuta solo a fini di tracciabilità: non richiede ulteriore lavoro. Eventuali
rifiniture testuali sui placeholder possono confluire in una semplice modifica di
`applyQueryPlaceholders`.
