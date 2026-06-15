# FEAT-03 — Rendering dei tipi di dati (binari/BLOB, decimali)

| Stato | Categoria | Priorità | Difficoltà |
| :---: | :--- | :---: | :---: |
| 🟡 Parziale | Feature / UX | Bassa | Media |

## Descrizione

Il frontend è costruito attorno alla convenzione **Extended JSON (EJSON)** di MongoDB
(`$oid`, `$date`, `$numberLong`, ecc.). Grazie a questa convenzione condivisa, anche le
righe MySQL viaggiano in EJSON e diversi tipi sono **già gestiti correttamente**:

- le colonne `DATE`/`DATETIME` arrivano come `$date` e sono renderizzate da `displayValue`;
- i valori binari sono riconosciuti (`'$binary' in v`) e mostrati come `Binary(<subType>)`.

Restano però dei residui di resa poco leggibile/utile:

- i valori **binari/BLOB** mostrano solo un'etichetta segnaposto `Binary(...)`, senza
  anteprima (es. esadecimale troncato), dimensione o possibilità di copia/scarico;
- i **decimali** ad alta precisione (`DECIMAL`/`$numberDecimal`) e numeri grandi possono
  non essere formattati in modo ottimale;
- mancano formattazioni dedicate per alcuni tipi MySQL (es. `JSON`, `ENUM`, `BIT`).

## Soluzione proposta

- Migliorare `displayValue`/`simplify` per i binari: anteprima esadecimale troncata +
  dimensione in byte, ed eventuale azione di copia/download del contenuto completo.
- Verificare la resa dei decimali ad alta precisione (mantenere la precisione, evitare la
  conversione a `double`).
- Aggiungere, dove utile, una resa più ricca per `JSON`/`ENUM`/`BIT`.

## Riferimenti nel codice

- `public/js/app.js` — `displayValue` (gestione `$binary`, `$date`, `$oid`, …), `simplify`.
- `db/MySqlStrategy.js` — `serializeRow`, `toSqlValue` (mapping `Binary` ↔ `Buffer`).
- `CLAUDE.md` — sezione "Convenzione EJSON".

## Criteri di accettazione

- [ ] I BLOB mostrano un'anteprima utile (dimensione + esadecimale troncato) e sono
      copiabili/scaricabili.
- [ ] I decimali ad alta precisione sono mostrati senza perdita di precisione.
- [ ] Nessuna regressione sulla resa dei tipi MongoDB esistenti.
