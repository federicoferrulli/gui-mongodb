'use strict';

const net = require('net');
const fs = require('fs');
const { Client } = require('ssh2');

/* ---------------------------------------------------------------------------
 * Tunnel SSH condiviso tra le strategie: ortogonale al tipo di database.
 *
 * Apre una connessione SSH e mette in ascolto una porta locale effimera
 * (127.0.0.1:<random>) che inoltra ogni connessione verso target.host:target.port
 * sul lato remoto. La strategia DB si connette poi al capo locale del tunnel.
 * ------------------------------------------------------------------------- */

function errText(err) {
  return (err && err.message) || String(err);
}

// ssh = { sshHost, sshPort, sshUser, sshPassword, sshKeyFile, sshPassphrase }
// target = { host, port } endpoint del DB raggiungibile dal server SSH.
// Ritorna { host, port, close } dove host:port è il capo locale del tunnel.
function openSshTunnel(ssh, target) {
  return new Promise((resolve, reject) => {
    const conn = new Client();
    let server = null;
    let settled = false;

    const fail = (err) => {
      if (settled) return;
      settled = true;
      if (server) try { server.close(); } catch { /* ignora */ }
      conn.end();
      reject(err instanceof Error ? err : new Error(String(err)));
    };

    // Stato del tunnel dopo l'apertura: se la connessione SSH cade a runtime
    // (rete, timeout, chiusura remota), 'error'/'close' arrivano con
    // settled già true, quindi `fail` non fa nulla — senza questo flag la
    // strategia DB vedrebbe solo un ECONNREFUSED generico sulla porta locale
    // ormai orfana, invece di un messaggio che spieghi che è il tunnel a
    // essere caduto.
    const tunnelState = { alive: true, lastError: null };

    conn.on('error', (err) => {
      if (settled) {
        tunnelState.alive = false;
        tunnelState.lastError = errText(err);
        return;
      }
      fail(err);
    });
    conn.on('close', () => {
      tunnelState.alive = false;
    });

    conn.on('ready', () => {
      server = net.createServer((socket) => {
        if (!tunnelState.alive) {
          socket.destroy();
          return;
        }
        conn.forwardOut('127.0.0.1', socket.remotePort || 0, target.host, target.port, (err, stream) => {
          if (err) {
            socket.destroy();
            return;
          }
          socket.pipe(stream).pipe(socket);
          stream.on('error', () => socket.destroy());
          socket.on('error', () => stream.destroy());
        });
      });
      server.on('error', fail);
      server.listen(0, '127.0.0.1', () => {
        settled = true;
        const { port } = server.address();
        resolve({
          host: '127.0.0.1',
          port,
          get alive() { return tunnelState.alive; },
          get lastError() { return tunnelState.lastError; },
          close() {
            try { server.close(); } catch { /* ignora */ }
            conn.end();
          },
        });
      });
    });

    const params = {
      host: String(ssh.sshHost || '').trim(),
      port: parseInt(ssh.sshPort, 10) || 22,
      username: String(ssh.sshUser || '').trim(),
      readyTimeout: 8000,
    };
    if (!params.host) return fail(new Error('Host SSH mancante.'));
    if (!params.username) return fail(new Error('Utente SSH mancante.'));

    const keyFile = String(ssh.sshKeyFile || '').trim();
    if (keyFile) {
      try {
        params.privateKey = fs.readFileSync(keyFile);
      } catch {
        return fail(new Error(`Impossibile leggere la chiave privata SSH: "${keyFile}".`));
      }
      if (ssh.sshPassphrase) params.passphrase = ssh.sshPassphrase;
    } else if (ssh.sshPassword) {
      params.password = ssh.sshPassword;
    } else {
      return fail(new Error('Indica una password SSH oppure il percorso di una chiave privata.'));
    }

    conn.connect(params);
  });
}

module.exports = { openSshTunnel };
