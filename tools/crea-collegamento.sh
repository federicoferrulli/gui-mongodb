#!/usr/bin/env bash
# Crea l'avvio rapido di CodeDB su Linux/macOS.
# - Linux: voce "CodeDB" nel menu applicazioni (~/.local/share/applications):
#   da lì la puoi aggiungere ai preferiti/dock (tasto destro → Aggiungi ai
#   preferiti su GNOME, o equivalente KDE). Terminal=true perché il server
#   chiede la passphrase dei segreti all'avvio.
# - macOS: non esiste un formato .desktop; lo script stampa le istruzioni per
#   il Dock (o per creare un'app con Automator).
# Uso: npm run shortcut-unix (oppure bash tools/crea-collegamento.sh)
set -e
root="$(cd "$(dirname "$0")/.." && pwd)"
chmod +x "$root/codedb.sh"

if [ "$(uname)" = "Darwin" ]; then
  echo "macOS: due opzioni per l'avvio rapido di CodeDB:"
  echo "  1. Dock: trascina $root/codedb.sh nella parte destra del Dock (vicino al Cestino)."
  echo "  2. App vera e propria: Automator → Nuova Applicazione → azione 'Esegui script shell'"
  echo "     con: \"$root/codedb.sh\" — salvala come CodeDB.app e trascinala nel Dock."
  exit 0
fi

dest="$HOME/.local/share/applications/codedb.desktop"
mkdir -p "$(dirname "$dest")"
cat > "$dest" <<EOF
[Desktop Entry]
Type=Application
Name=CodeDB
Comment=GUI web per MongoDB e MySQL
Exec=$root/codedb.sh
Path=$root
Icon=$root/public/codedb.png
Terminal=true
Categories=Development;Database;
EOF
command -v update-desktop-database >/dev/null 2>&1 && update-desktop-database "$(dirname "$dest")" || true
echo "Voce 'CodeDB' creata nel menu applicazioni ($dest)."
echo "Per i preferiti/dock: cerca CodeDB nel menu → tasto destro → 'Aggiungi ai preferiti' (GNOME) o 'Aggiungi al pannello' (KDE)."
