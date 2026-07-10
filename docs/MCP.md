# Guida: installare e usare il server MCP di CodeDB

CodeDB (già Mongo Web GUI) espone un server **MCP (Model Context Protocol)** che permette ad agenti AI (Claude Code, Claude Desktop, Cursor, ...) di esplorare e interrogare i database MongoDB e MySQL configurati nella GUI, senza mai vedere le credenziali. Di default l'accesso è in **sola lettura**; le scritture (inclusi i drop di database/collection) sono opt-in per connessione e passano sempre da una **doppia conferma umana**.

## 1. Prerequisiti

- Node.js ≥ 18 e `npm install` già eseguito nella cartella del progetto.
- Almeno una **connessione salvata** in `connections.ini` (creala dalla GUI: pulsante ＋ → compila il form → salva). L'AI può connettersi **solo** alle connessioni salvate, indicandole per nome.

## 2. Avviare il server

```bash
npm start        # oppure: npm run dev
```

Alla richiesta, inserisci la passphrase che cifra i segreti di `connections.ini` (o impostala prima in `GUI_MONGO_PASSPHRASE`). In console compare:

```
Mongo Web GUI in ascolto su http://127.0.0.1:3030
Endpoint MCP (Streamable HTTP) su http://127.0.0.1:3030/mcp
```

Il server MCP è **lo stesso processo** della GUI: finché la GUI è su, l'endpoint `/mcp` è disponibile. Porta e host si cambiano con le env `PORT` e `HOST`.

## 3. Registrare il server nei client AI

### Claude Code (CLI)

```bash
claude mcp add --transport http gui-mongodb http://localhost:3030/mcp
```

Verifica con `claude mcp list` (deve risultare *connected*). Per rimuoverlo: `claude mcp remove gui-mongodb`.

### Claude Desktop (o altri client solo-stdio)

Claude Desktop non parla HTTP direttamente: si usa il ponte `mcp-remote`. In *Impostazioni → Sviluppatore → Modifica configurazione* (`claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "gui-mongodb": {
      "command": "npx",
      "args": ["mcp-remote", "http://localhost:3030/mcp"]
    }
  }
}
```

Riavvia Claude Desktop: il server compare tra i connettori.

### Cursor

In `.cursor/mcp.json` (di progetto) o `~/.cursor/mcp.json` (globale):

```json
{
  "mcpServers": {
    "gui-mongodb": { "url": "http://localhost:3030/mcp" }
  }
}
```

## 4. Come lo usa l'AI

Flusso tipico dei tools esposti (i primi 6 sono di sola lettura):

1. `list_saved_connections` — elenca le connessioni salvate (nome, tipo, host mascherato, flag `readOnly`; **mai** password).
2. `connect_database` — apre una connessione per nome e restituisce un `connection_id` (tunnel SSH gestiti automaticamente dal server).
3. `get_databases_and_collections` — topologia: database, poi collection/tabelle.
4. `get_schema` — campi/colonne e relazioni (FK reali + euristiche): utile all'AI per scrivere query corrette.
5. `execute_query` — MongoDB: `filter`/`sort`/`projection` o `pipeline` (Extended JSON); MySQL: `sql` (solo SELECT e simili).
6. `disconnect_database` — chiude la connessione.
7. `execute_write` — scritture DML e drop di database/collection, solo su connessioni scrivibili e con doppia conferma (vedi sotto).
8. `set_connection_read_only` — cambia il flag `readOnly` di una connessione salvata, con doppia conferma (vedi sotto).

In più: la risorsa `schema://{connection_id}/{db}` (UML Mermaid + dizionario dati sempre aggiornati) e i prompt `genera-report` / `esplora-database`.

### Scritture (opzionali, con conferma)

Di default ogni connessione è in **sola lettura**. Per abilitare le scritture su una connessione, aggiungi `readOnly=false` alla sua sezione in `connections.ini` (consigliato: usa un utente DB con privilegi minimi), oppure lascia che sia l'AI a chiedertelo tramite `set_connection_read_only` (vedi sotto). Il tool `execute_write` lavora in due passaggi: la prima chiamata restituisce un'anteprima (con stima dei documenti/righe interessati) e un `confirm_token` (monouso, 5 minuti); l'esecuzione avviene solo richiamandolo col token, che l'AI deve usare **solo dopo la tua conferma esplicita**. UPDATE/DELETE senza WHERE (MySQL) e filtri vuoti (MongoDB) sono rifiutati. Oltre al DML, `execute_write` ammette le `operation` `drop_collection` e `drop_database` (per entrambi i tipi di database, stessa doppia conferma; i database di sistema sono protetti); nessun altro DDL è consentito. Ogni operazione è tracciata in `mcp-audit.log`.

### Flag readOnly modificabile dall'AI (solo con doppia conferma)

L'AI **non può modificare `connections.ini`**, con una sola eccezione controllata: il tool `set_connection_read_only` cambia il flag `readOnly` di una connessione salvata (mai credenziali o altri campi). Anche qui vale la doppia conferma: la prima chiamata restituisce l'anteprima del cambio e un `confirm_token`; l'applicazione avviene solo col token, dopo la tua approvazione esplicita — in **entrambe** le direzioni (anche per tornare a sola lettura). Il nuovo valore vale per le connessioni aperte da quel momento: l'AI deve riconnettersi con `connect_database` per usarlo. Tutto finisce nell'audit log.

Esempio di prompt: *"Connettiti alla connessione 'Produzione', guarda lo schema del db `shop` e dimmi i 10 clienti con più ordini."*

## 5. Limiti e sicurezza

- **Sola lettura di default**: `execute_query` non può mai scrivere, nemmeno sulle connessioni scrivibili. Su MongoDB sono vietati gli stage `$out`/`$merge`; su MySQL la query deve iniziare con SELECT/WITH/SHOW/DESCRIBE/EXPLAIN e gira comunque in una transazione `READ ONLY` (timeout 30 s), che blocca anche il DML annidato. Le scritture (DML e drop) passano solo da `execute_write`, solo su connessioni con `readOnly=false`, e con conferma a due passaggi.
- Le credenziali non transitano mai verso l'AI: si connette solo per nome di connessione salvata. `connections.ini` non è modificabile dall'AI, tranne il solo flag `readOnly` via `set_connection_read_only`, sempre con doppia conferma.
- Max 8 connessioni DB per sessione MCP, 32 sessioni MCP; le sessioni inattive da 30 minuti vengono chiuse.
- Con bind su loopback (default) l'endpoint rifiuta richieste con header `Host` non locale (anti DNS-rebinding). Se esponi il server in rete (`HOST=0.0.0.0`), ricorda che **non c'è autenticazione**: fallo solo su reti fidate.

## 6. Risoluzione problemi

| Sintomo | Causa probabile |
| --- | --- |
| Il client non si connette | Server non avviato, o porta diversa da 3030 (allinea l'URL) |
| `403 Host header non consentito` | Stai passando da un hostname non locale con server su loopback: usa `localhost`/`127.0.0.1` o imposta `HOST` |
| `Sessione MCP assente o scaduta` | Sessione oltre i 30 min di inattività: il client deve reinizializzare |
| `Connessione salvata "..." non trovata` | Il nome non esiste in `connections.ini`: verifica con `list_saved_connections` |
| Errori "sola lettura" | Comportamento voluto: la connessione non ha `readOnly=false` — abilitala dal file o via `set_connection_read_only` (con la tua conferma) |
| `confirm_token sconosciuto o scaduto` | Token già usato (monouso) o passati più di 5 minuti: l'AI deve ripetere la richiesta senza token |

Test end-to-end: `node test/e2e-mcp.js` (MongoDB) e `node test/e2e-mcp-mysql.js` (MySQL), col server già avviato.
