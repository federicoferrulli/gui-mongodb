# FEAT-02 — Aggiornamenti live (polling) per MySQL

| Stato | Categoria | Priorità | Difficoltà |
| :---: | :--- | :---: | :---: |
| 🔴 Aperta | Feature | Bassa | Facile |

## Descrizione

MongoDB supporta i **Change Stream** (se in replica set) ed emette aggiornamenti in tempo
reale tramite `collection:watch`. MySQL non offre un meccanismo equivalente con il driver
semplice: il backend risponde con `watch:unavailable` e il client degrada silenziosamente
nascondendo il badge **LIVE**.

## Soluzione proposta

Implementare un meccanismo di **polling opzionale** lato client per MySQL, attivabile
dall'utente, che simuli l'aggiornamento live:

- ricaricare periodicamente (es. ogni 5 s) la vista corrente, oppure
- confrontare un conteggio righe / una colonna timestamp (`updated_at`) per rilevare
  cambiamenti ed evidenziarli.

Accorgimenti:

- Polling **opt-in** (toggle esplicito) per non generare carico indesiderato.
- Sospendere il polling quando la tab/scheda non è attiva o durante un'editazione inline.
- Riusare il badge LIVE esistente per segnalare lo stato.

## Riferimenti nel codice

- `db/MySqlStrategy.js` — assenza di `watch` (eredita il default che lancia errore).
- `server.js` — handler `collection:watch`/`collection:unwatch`, evento `watch:unavailable`.
- `public/js/app.js` — gestione del badge LIVE (`#live-badge`).

## Criteri di accettazione

- [ ] Su MySQL è possibile attivare un aggiornamento periodico della vista.
- [ ] Il polling è opt-in e si sospende quando non serve.
- [ ] Nessuna regressione sul comportamento dei Change Stream MongoDB.
