# Analisi delle Migliorie e Sicurezza — Indice delle Issue

Questo indice raccoglie l'analisi dello stato del progetto **Mongo Web GUI** (GUI web
multi-database MongoDB/MySQL con supporto a tunnel SSH), suddivisa in singole issue
tracciabili. Ogni issue è descritta in un file dedicato in questa cartella.

> Nota: l'analisi originale (`improvements_analysis.md` nella root) è stata rivista per
> riflettere lo stato **attuale** del codice. Alcuni punti risultavano già risolti (vedi
> [FEAT-01](FEAT-01-ui-differenziata-per-dbtype.md)) e ne sono stati aggiunti di nuovi
> emersi dall'introduzione del tunnel SSH e dal modello di sicurezza dell'applicazione.

## Legenda stato

- 🔴 **Aperta** — da affrontare
- 🟡 **Parziale** — in parte già coperta dal codice, restano dei residui
- ✅ **Risolta** — già implementata (documentata per storia)

## Sicurezza

| ID | Titolo | Stato | Priorità | Difficoltà |
| :--- | :--- | :---: | :---: | :---: |
| [SEC-01](SEC-01-cifratura-segreti-salvati.md) | Segreti in chiaro in `connections.ini` (password DB + credenziali SSH) | 🔴 Aperta | Alta | Media |
| [SEC-02](SEC-02-autenticazione-e-binding-rete.md) | Assenza di autenticazione, binding su tutte le interfacce, query arbitrarie | 🔴 Aperta | Alta | Media |

## Feature e inconsistenze

| ID | Titolo | Stato | Priorità | Difficoltà |
| :--- | :--- | :---: | :---: | :---: |
| [FEAT-01](FEAT-01-ui-differenziata-per-dbtype.md) | UI differenziata per tipo di database | ✅ Risolta | — | — |
| [FEAT-02](FEAT-02-live-polling-mysql.md) | Aggiornamenti live (polling) per MySQL | 🔴 Aperta | Bassa | Facile |
| [FEAT-03](FEAT-03-rendering-tipi-dati.md) | Rendering dei tipi di dati (binari/BLOB, decimali) | 🟡 Parziale | Bassa | Media |

## Codice e debito tecnico

| ID | Titolo | Stato | Priorità | Difficoltà |
| :--- | :--- | :---: | :---: | :---: |
| [TECH-01](TECH-01-modularizzazione-frontend.md) | Modularizzazione del frontend monolitico `app.js` | 🔴 Aperta | Media | Alta |
| [TECH-02](TECH-02-pooling-connessioni-condiviso.md) | Condivisione/pooling delle connessioni tra socket | 🔴 Aperta | Bassa | Media |

## Ordine consigliato

1. **SEC-02** e **SEC-01** — il modello di sicurezza è il rischio più alto: l'app espone
   esecuzione di query arbitrarie con credenziali memorizzate in chiaro.
2. **TECH-01** — sblocca la manutenibilità di tutte le feature successive.
3. **FEAT-03**, **FEAT-02**, **TECH-02** — migliorie incrementali.
