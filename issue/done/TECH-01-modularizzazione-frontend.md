# TECH-01 — Modularizzazione del frontend monolitico `app.js`

| Stato | Categoria | Priorità | Difficoltà |
| :---: | :--- | :---: | :---: |
| 🔴 Aperta | Codice / Qualità | Media | Alta |

## Descrizione

`public/js/app.js` è un unico file di JavaScript vanilla di **oltre 1900 righe** (cresciuto
ulteriormente con il supporto MySQL e il tunnel SSH). Gestisce in un solo modulo:

- lo stato globale (oggetto `state`);
- la comunicazione Socket.IO;
- il form di connessione, le connessioni salvate e l'import/export;
- il rendering della griglia dati e l'editing inline;
- i menu contestuali, le modali (insert/edit, colonne, indici, creazione DB/collection);
- la generazione dell'UML in SVG.

Questo accoppiamento rende difficile orientarsi, testare e estendere il codice.

## Soluzione proposta

Suddividere il frontend in **moduli ES6** con responsabilità chiare, ad esempio:

- `main.js` — bootstrap e stato condiviso;
- `socket.js` — wrapper sugli eventi Socket.IO e formato `{ ok, ... }`;
- `connect.js` — form di connessione, profili salvati, SSH, import/export;
- `grid.js` — rendering griglia ed editing inline;
- `modals.js` — modali (insert/edit, colonne, indici, DB/collection);
- `uml.js` — vista UML.

Accorgimenti:

- Nessuna build richiesta: i moduli ES6 nativi funzionano con `<script type="module">`,
  coerentemente con l'attuale assenza di toolchain.
- Procedere in modo incrementale (estrarre un dominio alla volta) per limitare le
  regressioni, mantenendo i test e2e come rete di sicurezza sul backend.

## Riferimenti nel codice

- `public/js/app.js` (intero file), `public/index.html` (inclusione script).

## Criteri di accettazione

- [ ] `app.js` è suddiviso in moduli ES6 con confini di responsabilità chiari.
- [ ] L'app continua a funzionare senza step di build.
- [ ] Nessuna regressione funzionale rispetto al monolite.
