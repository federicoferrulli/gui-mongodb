# Avvio in background di CodeDB (usato da CodeDB.cmd): chiede la passphrase in
# una finestra di dialogo (saltata se GUI_MONGO_PASSPHRASE è già impostata),
# avvia node senza finestra con i log su codedb.log / codedb.err.log e apre il
# browser quando la porta risponde. La console si può chiudere: il server vive
# come processo indipendente. Per fermarlo: CodeDB.cmd stop
param([switch]$NoBrowser)
$root = Split-Path -Parent $PSScriptRoot
$port = if ($env:PORT) { [int]$env:PORT } else { 3030 }
$url = "http://localhost:$port"

if (-not $env:GUI_MONGO_PASSPHRASE) {
  # Prompt mascherato nella console del launcher (già aperta e a fuoco): più
  # affidabile del dialogo Get-Credential, che può finire dietro le finestre.
  $ss = Read-Host -AsSecureString 'Inserisci la passphrase dei segreti di CodeDB'
  $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($ss)
  $env:GUI_MONGO_PASSPHRASE = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr)
  [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
}

$out = Join-Path $root 'codedb.log'
$err = Join-Path $root 'codedb.err.log'
$proc = Start-Process node -ArgumentList 'server.js' -WorkingDirectory $root `
  -WindowStyle Hidden -PassThru -RedirectStandardOutput $out -RedirectStandardError $err
$null = $proc.Handle  # senza toccare l'handle, ExitCode resterebbe vuoto dopo l'uscita

for ($i = 0; $i -lt 120; $i++) {
  if ($proc.HasExited) {
    # Tipico: passphrase sbagliata (il server esce subito senza toccare il file).
    Write-Host "CodeDB non e' partito (exit code $($proc.ExitCode)):" -ForegroundColor Red
    if (Test-Path $err) { Get-Content $err | Write-Host }
    Read-Host 'Premi INVIO per chiudere'
    exit 1
  }
  if (Test-NetConnection 127.0.0.1 -Port $port -InformationLevel Quiet -WarningAction SilentlyContinue) {
    if (-not $NoBrowser) { Start-Process $url }
    Write-Host "CodeDB avviato in background su $url (log: codedb.log). Per fermarlo: CodeDB.cmd stop"
    exit 0
  }
  Start-Sleep -Milliseconds 500
}
Write-Host 'Timeout: il server non ha risposto entro 60 secondi (vedi codedb.log).'
exit 1
