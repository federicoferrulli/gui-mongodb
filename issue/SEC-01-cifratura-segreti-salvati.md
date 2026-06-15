# SEC-01 — Segreti in chiaro in `connections.ini`

| Stato | Categoria | Priorità | Difficoltà |
| :---: | :--- | :---: | :---: |
| 🔴 Aperta | Sicurezza | Alta | Media |

## Descrizione

Tutti i segreti dei profili di connessione salvati sono scritti **in chiaro** nel file
`connections.ini` nella root del progetto. Con l'introduzione del tunnel SSH i segreti non
sono più solo la password del database, ma l'intero insieme definito in `server.js`:

```js
const SECRET_FIELDS = ['password', 'sshPassword', 'sshPassphrase'];
```

Sebbene il file sia escluso da Git tramite `.gitignore` e la password non venga mai
rimandata al browser (`connections:get` la omette), chiunque abbia:

- accesso locale alla macchina (lettura del file `connections.ini`), oppure
- accesso alla UI con la feature **Esporta** (`connections:export` restituisce l'intero
  `.ini`, segreti SSH e password DB inclusi)

può leggere tutte le credenziali in chiaro.

## Impatto

Compromissione delle credenziali dei database **e** degli host SSH/bastion configurati
(`sshPassword`, `sshPassphrase`). Quest'ultimo è particolarmente grave perché un host SSH
è spesso un punto di accesso all'infrastruttura, non solo a un singolo database.

## Soluzione proposta

- Cifrare simmetricamente i campi in `SECRET_FIELDS` con il modulo nativo `crypto`
  (es. **AES-256-GCM**) prima di scriverli su file, e decifrarli in lettura.
- Gestire la chiave di cifratura in modo che **non** sia versionata né esportata:
  - chiave generata al primo avvio e salvata fuori dal progetto (es.
    `~/.mongo-web-gui.key` con permessi ristretti), **oppure**
  - chiave derivata da una passphrase richiesta all'avvio (`scrypt`/`pbkdf2`).
- Prevedere migrazione trasparente dei `connections.ini` esistenti (valori non cifrati →
  cifrati al primo salvataggio).
- Valutare se la feature **Esporta** debba esportare i segreti cifrati o ometterli del
  tutto (vedi anche SEC-02): un export con segreti in chiaro vanifica la cifratura a riposo.

## Riferimenti nel codice

- `server.js` — `SECRET_FIELDS`, `parseIni`/`stringifyIni`, `saveConnections`,
  `connections:export`/`connections:import`.
- `.gitignore` — `connections.ini` già escluso.

## Criteri di accettazione

- [ ] I segreti su `connections.ini` non sono leggibili in chiaro.
- [ ] La chiave di cifratura non è nel repository né in un file esportabile dalla UI.
- [ ] I profili salvati prima della modifica continuano a funzionare (migrazione).
- [ ] Comportamento dell'export documentato e coerente con il modello di sicurezza.
