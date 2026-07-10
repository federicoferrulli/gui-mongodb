# Crea i collegamenti "CodeDB" sul Desktop e nel menu Start, con l'icona del
# progetto. Il target è cmd.exe /c "...\CodeDB.cmd" (non il .cmd direttamente):
# Windows consente di aggiungere alla barra delle applicazioni solo collegamenti
# a eseguibili, quindi così il collegamento diventa "pinnabile" (tasto destro →
# Aggiungi alla barra delle applicazioni, o trascinandolo sulla barra).
# Uso: npm run shortcut (oppure esegui questo file direttamente).
$root = Split-Path -Parent $PSScriptRoot
$cmd = Join-Path $root 'CodeDB.cmd'
$ws = New-Object -ComObject WScript.Shell

$destinazioni = @(
  (Join-Path ([Environment]::GetFolderPath('Desktop')) 'CodeDB.lnk'),
  (Join-Path ([Environment]::GetFolderPath('Programs')) 'CodeDB.lnk')  # menu Start
)
foreach ($dest in $destinazioni) {
  $lnk = $ws.CreateShortcut($dest)
  $lnk.TargetPath = $env:ComSpec
  $lnk.Arguments = "/c `"$cmd`""
  $lnk.WorkingDirectory = $root
  $lnk.IconLocation = (Join-Path $root 'public\codedb.ico') + ',0'
  $lnk.Description = 'CodeDB - GUI web per MongoDB e MySQL'
  $lnk.Save()
  Write-Host "Collegamento creato: $dest"
}
Write-Host "Per la barra delle applicazioni: tasto destro sul collegamento -> 'Aggiungi alla barra delle applicazioni' (su Windows 11 sotto 'Mostra altre opzioni'), oppure trascinalo sulla barra. Dal menu Start puoi anche 'Aggiungi a Start'."
