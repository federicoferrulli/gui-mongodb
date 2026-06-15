# TECH-02 — Condivisione/pooling delle connessioni tra socket

| Stato | Categoria | Priorità | Difficoltà |
| :---: | :--- | :---: | :---: |
| 🔴 Aperta | Codice / Qualità | Bassa | Media |

## Descrizione

Per ogni socket connesso viene creata una **strategia dedicata** e quindi un client/pool
DB dedicato (e, con il tunnel SSH, una connessione SSH dedicata), chiusi alla
disconnessione. È un modello semplice e isolato, ma con più schede/utenti che puntano allo
stesso database comporta connessioni e tunnel ridondanti verso lo stesso endpoint.

## Soluzione proposta

Valutare una **condivisione server-side** delle risorse verso lo stesso target:

- riuso di un pool MySQL / `MongoClient` per endpoint+credenziali identici, con
  reference counting e chiusura quando l'ultimo socket si disconnette;
- analogamente, riuso del tunnel SSH verso lo stesso bastion/target.

Da soppesare con attenzione:

- **Isolamento e sicurezza**: credenziali diverse non devono mai condividere lo stesso
  pool; serve una chiave di cache che includa host, porta, utente e parametri SSH.
- **Ciclo di vita**: la chiusura deve avvenire solo quando nessun socket usa più la
  risorsa, evitando leak o chiusure premature.
- Spesso il guadagno è marginale per uno strumento a uso prevalentemente locale: prioritizzare
  solo se emergono problemi reali di numero di connessioni.

## Riferimenti nel codice

- `server.js` — creazione/chiusura della strategia per socket (`closeStrategy`,
  `mongo:connect`, `disconnect`).
- `db/MySqlStrategy.js`, `db/MongoDbStrategy.js` — pool/client per istanza.
- `db/SshTunnel.js` — tunnel per istanza.

## Criteri di accettazione

- [ ] Le risorse verso lo stesso endpoint+credenziali sono riusate in modo sicuro.
- [ ] Reference counting corretto: nessuna chiusura prematura né leak.
- [ ] Nessuna condivisione tra credenziali/parametri SSH diversi.
