# Guida: installare e usare il server MCP di Mongo Web GUI

Mongo Web GUI espone un server **MCP (Model Context Protocol)** che permette ad agenti AI (Claude Code, Claude Desktop, Cursor, ...) di esplorare e interrogare **in sola lettura** i database MongoDB e MySQL configurati nella GUI, senza mai vedere le credenziali.

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

Flusso tipico dei 6 tools esposti:

1. `list_saved_connections` — elenca le connessioni salvate (nome, tipo, host mascherato; **mai** password).
2. `connect_database` — apre una connessione per nome e restituisce un `connection_id` (tunnel SSH gestiti automaticamente dal server).
3. `get_databases_and_collections` — topologia: database, poi collection/tabelle.
4. `get_schema` — campi/colonne e relazioni (FK reali + euristiche): utile all'AI per scrivere query corrette.
5. `execute_query` — MongoDB: `filter`/`sort`/`projection` o `pipeline` (Extended JSON); MySQL: `sql` (solo SELECT e simili).
6. `disconnect_database` — chiude la connessione.

Esempio di prompt: *"Connettiti alla connessione 'Produzione', guarda lo schema del db `shop` e dimmi i 10 clienti con più ordini."*

## 5. Limiti e sicurezza (Fase 1)

- **Sola lettura**: niente insert/update/delete/DDL. Su MongoDB sono vietati gli stage `$out`/`$merge`; su MySQL la query deve iniziare con SELECT/WITH/SHOW/DESCRIBE/EXPLAIN e gira comunque in una transazione `READ ONLY` (timeout 30 s), che blocca anche il DML annidato.
- Le credenziali non transitano mai verso l'AI: si connette solo per nome di connessione salvata.
- Max 8 connessioni DB per sessione MCP, 32 sessioni MCP; le sessioni inattive da 30 minuti vengono chiuse.
- Con bind su loopback (default) l'endpoint rifiuta richieste con header `Host` non locale (anti DNS-rebinding). Se esponi il server in rete (`HOST=0.0.0.0`), ricorda che **non c'è autenticazione**: fallo solo su reti fidate.

## 6. Risoluzione problemi

| Sintomo | Causa probabile |
| --- | --- |
| Il client non si connette | Server non avviato, o porta diversa da 3030 (allinea l'URL) |
| `403 Host header non consentito` | Stai passando da un hostname non locale con server su loopback: usa `localhost`/`127.0.0.1` o imposta `HOST` |
| `Sessione MCP assente o scaduta` | Sessione oltre i 30 min di inattività: il client deve reinizializzare |
| `Connessione salvata "..." non trovata` | Il nome non esiste in `connections.ini`: verifica con `list_saved_connections` |
| Errori "sola lettura" | Comportamento voluto: la Fase 1 non consente scritture |

Test end-to-end: `node test/e2e-mcp.js` (MongoDB) e `node test/e2e-mcp-mysql.js` (MySQL), col server già avviato.
