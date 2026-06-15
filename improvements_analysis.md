# Analisi delle Migliorie e Sicurezza

Questo documento è stato **rivisto e suddiviso** in singole issue tracciabili nella
cartella [`issue/`](issue/README.md).

Vai a **[issue/README.md](issue/README.md)** per l'indice completo con stato, priorità e
ordine consigliato.

## Panoramica rapida

| ID | Titolo | Stato |
| :--- | :--- | :---: |
| [SEC-01](issue/SEC-01-cifratura-segreti-salvati.md) | Segreti in chiaro in `connections.ini` (password DB + credenziali SSH) | 🔴 Aperta |
| [SEC-02](issue/SEC-02-autenticazione-e-binding-rete.md) | Assenza di autenticazione, binding su tutte le interfacce, query arbitrarie | 🔴 Aperta |
| [FEAT-01](issue/FEAT-01-ui-differenziata-per-dbtype.md) | UI differenziata per tipo di database | ✅ Risolta |
| [FEAT-02](issue/FEAT-02-live-polling-mysql.md) | Aggiornamenti live (polling) per MySQL | 🔴 Aperta |
| [FEAT-03](issue/FEAT-03-rendering-tipi-dati.md) | Rendering dei tipi di dati (binari/BLOB, decimali) | 🟡 Parziale |
| [TECH-01](issue/TECH-01-modularizzazione-frontend.md) | Modularizzazione del frontend monolitico `app.js` | 🔴 Aperta |
| [TECH-02](issue/TECH-02-pooling-connessioni-condiviso.md) | Condivisione/pooling delle connessioni tra socket | 🔴 Aperta |
