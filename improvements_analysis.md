# Analisi delle Migliorie e Sicurezza

Questo documento è stato **rivisto e suddiviso** in singole issue tracciabili nella
cartella [`issue/`](issue/README.md).

Vai a **[issue/README.md](issue/README.md)** per l'indice completo con stato, priorità e
ordine consigliato.

## Panoramica rapida

| ID | Titolo | Stato |
| :--- | :--- | :---: |
| [SEC-01](issue/done/SEC-01-cifratura-segreti-salvati.md) | Segreti in chiaro in `connections.ini` (password DB + credenziali SSH) | ✅ Risolta |
| [SEC-02](issue/done/SEC-02-autenticazione-e-binding-rete.md) | Assenza di autenticazione, binding su tutte le interfacce, query arbitrarie | ✅ Risolta |
| [FEAT-01](issue/done/FEAT-01-ui-differenziata-per-dbtype.md) | UI differenziata per tipo di database | ✅ Risolta |
| [FEAT-02](issue/done/FEAT-02-live-polling-mysql.md) | Aggiornamenti live (polling) per MySQL | ✅ Risolta |
| [FEAT-03](issue/done/FEAT-03-rendering-tipi-dati.md) | Rendering dei tipi di dati (binari/BLOB, decimali) | ✅ Risolta |
| [TECH-01](issue/done/TECH-01-modularizzazione-frontend.md) | Modularizzazione del frontend monolitico `app.js` | ✅ Risolta |
| [TECH-02](issue/TECH-02-pooling-connessioni-condiviso.md) | Condivisione/pooling delle connessioni tra socket | 🔴 Aperta (Sospesa) |
