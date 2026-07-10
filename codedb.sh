#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# Avvio "desktop" di CodeDB su Linux/macOS: se il server è già attivo apre solo
# il browser, altrimenti chiede la passphrase e avvia il server in background
# (nohup, log su codedb.log): il terminale si può chiudere subito dopo.
#   ./codedb.sh        avvia (o riusa l'istanza attiva) e apre il browser
#   ./codedb.sh stop   ferma il server in background
# Porta configurabile con la variabile d'ambiente PORT (default 3030).
# ---------------------------------------------------------------------------
cd "$(dirname "$0")" || exit 1
PORT="${PORT:-3030}"
URL="http://localhost:$PORT"

apri_browser() {
  if command -v xdg-open >/dev/null 2>&1; then xdg-open "$1" >/dev/null 2>&1 &
  elif command -v open >/dev/null 2>&1; then open "$1"           # macOS
  else echo "Apri manualmente: $1"; fi
}

porta_attiva() {
  if command -v curl >/dev/null 2>&1; then
    curl -s -o /dev/null --max-time 1 "http://127.0.0.1:$PORT/"
  else
    # Fallback senza curl: pseudo-device /dev/tcp di bash.
    (exec 3<>"/dev/tcp/127.0.0.1/$PORT") 2>/dev/null && { exec 3>&- 3<&-; return 0; }
    return 1
  fi
}

if [ "$1" = "stop" ]; then
  pid="$(lsof -ti "tcp:$PORT" 2>/dev/null || fuser "$PORT/tcp" 2>/dev/null | tr -d ' ')"
  if [ -n "$pid" ]; then
    kill "$pid" && echo "CodeDB fermato."
  else
    echo "Nessuna istanza di CodeDB in ascolto sulla porta $PORT."
  fi
  exit 0
fi

# Istanza già in esecuzione? Allora basta il browser.
if porta_attiva; then
  echo "CodeDB è già in esecuzione: apro $URL"
  apri_browser "$URL"
  exit 0
fi

# Passphrase prima del detach: il server in background non può chiederla.
if [ -z "$GUI_MONGO_PASSPHRASE" ]; then
  read -r -s -p "Inserisci la passphrase dei segreti di CodeDB: " GUI_MONGO_PASSPHRASE
  echo
  export GUI_MONGO_PASSPHRASE
fi

nohup node server.js >codedb.log 2>&1 &
srv=$!
disown "$srv" 2>/dev/null

# Attendi che la porta risponda (max 60 s), poi apri il browser.
for _ in $(seq 1 120); do
  if ! kill -0 "$srv" 2>/dev/null; then
    # Tipico: passphrase sbagliata (il server esce subito senza toccare il file).
    echo "CodeDB non è partito:"
    tail -5 codedb.log
    exit 1
  fi
  if porta_attiva; then
    apri_browser "$URL"
    echo "CodeDB avviato in background su $URL (log: codedb.log). Per fermarlo: ./codedb.sh stop"
    exit 0
  fi
  sleep 0.5
done
echo "Timeout: il server non ha risposto entro 60 secondi (vedi codedb.log)."
exit 1
