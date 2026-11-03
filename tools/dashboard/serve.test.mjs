/**
 * tools/dashboard/serve.test.mjs
 *
 * Tests unitaires et d'integration du serveur local securise du dashboard (U2).
 * `node --test tools/dashboard/serve.test.mjs`
 */

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';

import { resolveDomains } from './run.mjs';
import { CSP_HEADER, startServer } from './serve.mjs';
import { writeTestConfig } from '../test-vault.mjs';

let vault;
const put = (rel, text) => {
  const file = path.join(vault, rel);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, text);
};

// Helper pour envoyer une requete brute via socket TCP (pour tester les chemins non normalises)
const sendRawRequest = (port, rawHttp) => {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: '127.0.0.1', port }, () => {
      socket.write(rawHttp);
    });
    let data = '';
    socket.on('data', (chunk) => {
      data += chunk.toString();
    });
    socket.on('end', () => {
      resolve(data);
    });
    socket.on('error', reject);
  });
};

beforeEach(() => {
  vault = mkdtempSync(path.join(tmpdir(), 'serve-test-'));
  writeTestConfig(vault);
});
afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
});

describe('U2 : Serveur local securise a routes fixes', () => {
  test('GET / avec Host valide renvoie 200, HTML live, CSP et no-store', async () => {
    put('wiki/pro/people/alice.md', '---\ntitle: Alice\ntype: person\ngate: passe 2026-09-24\n---\nAlice.\n');

    const instance = await startServer(vault, 'pro', { port: 0, quiet: true });
    try {
      // 1. Ecoute stricte sur 127.0.0.1 (AE2)
      const addr = instance.server.address();
      assert.equal(addr.address, '127.0.0.1');

      // 2. GET / avec Host localhost:<port>
      const res = await fetch(`http://127.0.0.1:${instance.port}/`, {
        headers: { Host: `localhost:${instance.port}` },
      });

      assert.equal(res.status, 200);
      assert.equal(res.headers.get('content-type'), 'text/html; charset=utf-8');
      assert.equal(res.headers.get('cache-control'), 'no-store');
      assert.equal(res.headers.get('content-security-policy'), CSP_HEADER);

      // Aucune entete Access-Control-Allow-*
      assert.equal(res.headers.get('access-control-allow-origin'), null);

      const html = await res.text();
      assert.ok(html.includes('Tableau de bord — pro'));
      assert.ok(html.includes('"mode":"live"'));
    } finally {
      await instance.close();
    }
  });

  test('GET /vendor/3d-force-graph.min.js renvoie la ressource vendor et 404 sur autre fichier', async () => {
    // Creer un faux vendor local pour le test
    put('tools/dashboard/vendor/3d-force-graph.min.js', '/* 3d-force-graph stub */');

    const instance = await startServer(vault, 'pro', { port: 0, quiet: true, vendorDir: path.join(vault, 'tools', 'dashboard', 'vendor') });
    try {
      const resVendor = await fetch(`http://127.0.0.1:${instance.port}/vendor/3d-force-graph.min.js`, {
        headers: { Host: `127.0.0.1:${instance.port}` },
      });
      assert.equal(resVendor.status, 200);
      assert.equal(resVendor.headers.get('content-type'), 'text/javascript; charset=utf-8');
      assert.equal(resVendor.headers.get('access-control-allow-origin'), null);
      const content = await resVendor.text();
      assert.equal(content, '/* 3d-force-graph stub */');

      // Fichiers statiques interdits
      const resDoc = await fetch(`http://127.0.0.1:${instance.port}/dashboard-pro.html`, {
        headers: { Host: `127.0.0.1:${instance.port}` },
      });
      assert.equal(resDoc.status, 404);

      const resRun = await fetch(`http://127.0.0.1:${instance.port}/tools/dashboard/run.mjs`, {
        headers: { Host: `127.0.0.1:${instance.port}` },
      });
      assert.equal(resRun.status, 404);
    } finally {
      await instance.close();
    }
  });

  test('U1 & KTD1 : route securisee /vendor/fonts/ sert les polices woff2 et bloque les traversées et extensions invalides', async () => {
    put('tools/dashboard/vendor/fonts/inter-latin-400.woff2', '/* woff2 binary stub */');
    put('tools/dashboard/vendor/fonts/fichier.txt', 'texte');

    const instance = await startServer(vault, 'pro', { port: 0, quiet: true, vendorDir: path.join(vault, 'tools', 'dashboard', 'vendor') });
    try {
      // 1. Police WOFF2 valide
      const res = await fetch(`http://127.0.0.1:${instance.port}/vendor/fonts/inter-latin-400.woff2`, {
        headers: { Host: `127.0.0.1:${instance.port}` },
      });
      assert.equal(res.status, 200);
      assert.equal(res.headers.get('content-type'), 'font/woff2');
      assert.ok(res.headers.get('cache-control').includes('max-age=86400'));
      const text = await res.text();
      assert.equal(text, '/* woff2 binary stub */');

      // 2. Extension non-woff2 refusee (404)
      const resTxt = await fetch(`http://127.0.0.1:${instance.port}/vendor/fonts/fichier.txt`, {
        headers: { Host: `127.0.0.1:${instance.port}` },
      });
      assert.equal(resTxt.status, 404);

      // 3. Police inexistante (404)
      const resMissing = await fetch(`http://127.0.0.1:${instance.port}/vendor/fonts/inconnue.woff2`, {
        headers: { Host: `127.0.0.1:${instance.port}` },
      });
      assert.equal(resMissing.status, 404);

      // 4. Tentative de traversee (404)
      const rawReq = `GET /vendor/fonts/../run.mjs HTTP/1.1\r\nHost: 127.0.0.1:${instance.port}\r\nConnection: close\r\n\r\n`;
      const rawRes = await sendRawRequest(instance.port, rawReq);
      assert.ok(rawRes.includes('404'));
    } finally {
      await instance.close();
    }
  });

  test('video Mode d emploi : la video du coffre est servie quand le core n en a pas', async () => {
    put('tools/dashboard/vendor/media/kioku-explainer.mp4', '0123456789');
    const instance = await startServer(vault, 'pro', { port: 0, quiet: true, vendorDir: path.join(vault, 'core-sans-video') });
    try {
      const res = await fetch(`http://127.0.0.1:${instance.port}/vendor/media/kioku-explainer.mp4`, { headers: { Host: `127.0.0.1:${instance.port}` } });
      assert.equal(res.status, 200);
      assert.equal(await res.text(), '0123456789');
      const miss = await fetch(`http://127.0.0.1:${instance.port}/vendor/media/absente.mp4`, { headers: { Host: `127.0.0.1:${instance.port}` } });
      assert.equal(miss.status, 404);
    } finally {
      await instance.close();
    }
  });

  test('video Mode d emploi : route /vendor/media/ sert le mp4 avec Range, bloque traversees et extensions', async () => {
    put('tools/dashboard/vendor/media/kioku-explainer.mp4', '0123456789ABCDEF');
    put('tools/dashboard/vendor/media/kioku-explainer.vtt', 'WEBVTT\n');
    put('tools/dashboard/vendor/media/notes.txt', 'texte');

    const instance = await startServer(vault, 'pro', { port: 0, quiet: true, vendorDir: path.join(vault, 'tools', 'dashboard', 'vendor') });
    const get = (p, headers = {}) => fetch(`http://127.0.0.1:${instance.port}${p}`, { headers: { Host: `127.0.0.1:${instance.port}`, ...headers } });
    try {
      // 1. Fichier complet
      const res = await get('/vendor/media/kioku-explainer.mp4');
      assert.equal(res.status, 200);
      assert.equal(res.headers.get('content-type'), 'video/mp4');
      assert.equal(res.headers.get('accept-ranges'), 'bytes');
      assert.equal(await res.text(), '0123456789ABCDEF');

      // 2. Requete partielle (lecteur video, deplacement dans la timeline)
      const part = await get('/vendor/media/kioku-explainer.mp4', { Range: 'bytes=4-7' });
      assert.equal(part.status, 206);
      assert.equal(part.headers.get('content-range'), 'bytes 4-7/16');
      assert.equal(await part.text(), '4567');

      // 3. Plage ouverte et plage hors limites
      const open = await get('/vendor/media/kioku-explainer.mp4', { Range: 'bytes=10-' });
      assert.equal(open.status, 206);
      assert.equal(await open.text(), 'ABCDEF');
      const bad = await get('/vendor/media/kioku-explainer.mp4', { Range: 'bytes=40-50' });
      assert.equal(bad.status, 416);

      // 4. Sous-titres WebVTT
      const vtt = await get('/vendor/media/kioku-explainer.vtt');
      assert.equal(vtt.status, 200);
      assert.equal(vtt.headers.get('content-type'), 'text/vtt; charset=utf-8');

      // 5. Extension non autorisee, fichier absent, traversee
      assert.equal((await get('/vendor/media/notes.txt')).status, 404);
      assert.equal((await get('/vendor/media/absente.mp4')).status, 404);
      const rawRes = await sendRawRequest(instance.port, `GET /vendor/media/../../run.mjs HTTP/1.1\r\nHost: 127.0.0.1:${instance.port}\r\nConnection: close\r\n\r\n`);
      assert.ok(rawRes.includes('404'));

      // 6. La CSP autorise la lecture de medias de meme origine
      const page = await get('/');
      assert.ok(page.headers.get('content-security-policy').includes("media-src 'self'"));
    } finally {
      await instance.close();
    }
  });

  test('couvre AE1 : requete brute non normalisee /../../wiki/perso/piege.md renvoie 404 sans le contenu', async () => {
    put('wiki/perso/piege.md', 'CONTENU_SECRET_PERSO_NE_JAMAIS_DIVULGUER');

    const instance = await startServer(vault, 'pro', { port: 0, quiet: true });
    try {
      const rawReq = `GET /../../wiki/perso/piege.md HTTP/1.1\r\nHost: 127.0.0.1:${instance.port}\r\nConnection: close\r\n\r\n`;
      const rawRes = await sendRawRequest(instance.port, rawReq);

      assert.ok(rawRes.includes('404'), 'Doit renvoyer un statut 404');
      assert.ok(!rawRes.includes('CONTENU_SECRET_PERSO_NE_JAMAIS_DIVULGUER'), 'Ne doit jamais exposer le fichier');
    } finally {
      await instance.close();
    }
  });

  test('GET / avec Host invalide renvoie 403 (KTD6 - blocage DNS rebinding)', async () => {
    const instance = await startServer(vault, 'pro', { port: 0, quiet: true });
    try {
      const rawReq = `GET / HTTP/1.1\r\nHost: evil.example:${instance.port}\r\nConnection: close\r\n\r\n`;
      const rawRes = await sendRawRequest(instance.port, rawReq);
      assert.ok(rawRes.includes('403 Forbidden') || rawRes.includes('403'), 'Doit renvoyer un statut 403');
      assert.ok(rawRes.includes('Forbidden: Host invalide'));
    } finally {
      await instance.close();
    }
  });

  test('GET /?x=1 gere la chaine de requete et renvoie 200 sur le pathname pur', async () => {
    const instance = await startServer(vault, 'pro', { port: 0, quiet: true });
    try {
      const res = await fetch(`http://127.0.0.1:${instance.port}/?query=valeur`, {
        headers: { Host: `127.0.0.1:${instance.port}` },
      });
      assert.equal(res.status, 200);
    } finally {
      await instance.close();
    }
  });

  test('R3 : rendu a la volee a chaque requete prenant en compte les ajouts au vol', async () => {
    put('wiki/pro/people/alice.md', '---\ntitle: Alice\ntype: person\ngate: passe 2026-09-24\n---\nAlice.\n');

    const instance = await startServer(vault, 'pro', { port: 0, quiet: true });
    try {
      const res1 = await fetch(`http://127.0.0.1:${instance.port}/`, {
        headers: { Host: `127.0.0.1:${instance.port}` },
      });
      const html1 = await res1.text();
      assert.ok(html1.includes('Alice'));
      assert.ok(!html1.includes('Bob'));

      // Ajout d'une nouvelle page pendant que le serveur tourne
      put('wiki/pro/people/bob.md', '---\ntitle: Bob\ntype: person\ngate: passe 2026-09-24\n---\nBob.\n');

      const res2 = await fetch(`http://127.0.0.1:${instance.port}/`, {
        headers: { Host: `127.0.0.1:${instance.port}` },
      });
      const html2 = await res2.text();
      assert.ok(html2.includes('Bob'), 'La deuxieme requete doit contenir la nouvelle page Bob');
    } finally {
      await instance.close();
    }
  });

  test('couvre AE5 : refus de demarrer sur un domaine different en session Claude', () => {
    assert.throws(
      () => {
        resolveDomains('perso', { VAULT_DOMAIN: 'pro', CLAUDECODE: '1' }, vault);
      },
      /sortirait du silo/
    );
  });

  test('port deja utilise renvoie un message explicite mentionnant --port', async () => {
    const instance1 = await startServer(vault, 'pro', { port: 0, quiet: true });
    try {
      await assert.rejects(
        async () => {
          await startServer(vault, 'pro', { port: instance1.port, quiet: true });
        },
        (err) => {
          assert.ok(err.message.includes(`Port ${instance1.port} deja utilise`));
          assert.ok(err.message.includes('--port'));
          return true;
        }
      );
    } finally {
      await instance1.close();
    }
  });

  test('couvre F2 : serveurs pro et perso en parallele sur deux ports sans fuite croisee', async () => {
    put('wiki/pro/people/pro-only.md', '---\ntitle: ProUnique\ntype: person\ngate: passe 2026-09-24\n---\nNote.\n');
    put('wiki/perso/people/perso-only.md', '---\ntitle: PersoUnique\ntype: person\ngate: passe 2026-09-24\n---\nNote.\n');

    const srvPro = await startServer(vault, 'pro', { port: 0, quiet: true });
    const srvPerso = await startServer(vault, 'perso', { port: 0, quiet: true });

    try {
      const resPro = await fetch(`http://127.0.0.1:${srvPro.port}/`, {
        headers: { Host: `127.0.0.1:${srvPro.port}` },
      });
      const htmlPro = await resPro.text();
      assert.ok(htmlPro.includes('ProUnique'));
      assert.ok(!htmlPro.includes('PersoUnique'));

      const resPerso = await fetch(`http://127.0.0.1:${srvPerso.port}/`, {
        headers: { Host: `127.0.0.1:${srvPerso.port}` },
      });
      const htmlPerso = await resPerso.text();
      assert.ok(htmlPerso.includes('PersoUnique'));
      assert.ok(!htmlPerso.includes('ProUnique'));
    } finally {
      await srvPro.close();
      await srvPerso.close();
    }
  });

  test('U3 & KTD4 : flux SSE /events transmet la version initiale puis les mises a jour', async () => {
    // Helper SSE client
    const connectSSE = (port) => {
      return new Promise((resolve, reject) => {
        const events = [];
        const req = http.request(
          {
            host: '127.0.0.1',
            port,
            path: '/events',
            headers: { host: `127.0.0.1:${port}` },
          },
          (res) => {
            res.setEncoding('utf8');
            let buffer = '';
            res.on('data', (chunk) => {
              buffer += chunk;
              const lines = buffer.split('\n\n');
              buffer = lines.pop();
              for (const line of lines) {
                if (line.startsWith('data: ')) {
                  try {
                    events.push(JSON.parse(line.slice(6)));
                  } catch {
                    // ignore
                  }
                }
              }
            });
            resolve({
              res,
              getEvents: () => events,
              close: () => req.destroy(),
            });
          }
        );
        req.on('error', reject);
        req.end();
      });
    };

    put('wiki/pro/people/alice.md', '---\ntitle: Alice\ntype: person\ngate: passe 2026-09-24\n---\nAlice.\n');

    const instance = await startServer(vault, 'pro', {
      port: 0,
      quiet: true,
      debounceMs: 50,
      heartbeatMs: 0,
    });

    try {
      // 1. GET /events avec verification des en-tetes
      const sseClient = await connectSSE(instance.port);
      assert.equal(sseClient.res.statusCode, 200);
      assert.equal(sseClient.res.headers['content-type'], 'text/event-stream');
      assert.equal(sseClient.res.headers['access-control-allow-origin'], undefined);

      // Attendre la reception de l'evenement initial
      await new Promise((r) => setTimeout(r, 60));
      const initialEvents = sseClient.getEvents();
      assert.ok(initialEvents.length >= 1, 'Doit recevoir au moins la version initiale');
      const v0 = initialEvents[0].version;
      assert.ok(typeof v0 === 'number');
      // Hors node --watch, le serveur ne demande pas a la page de se recharger seule
      assert.equal(initialEvents[0].dev, Boolean(process.env.WATCH_REPORT_DEPENDENCIES));

      // 2. Ecriture dans wiki/pro/
      put('wiki/pro/people/bob.md', '---\ntitle: Bob\ntype: person\ngate: passe 2026-09-24\n---\nBob.\n');

      // Attendre la propagation et le debounce
      await new Promise((r) => setTimeout(r, 150));
      const updatedEvents = sseClient.getEvents();
      assert.ok(updatedEvents.length >= 2, 'Doit recevoir un deuxieme evenement avec la nouvelle version');
      const v1 = updatedEvents[updatedEvents.length - 1].version;
      assert.ok(v1 > v0, `La version recue (${v1}) doit etre superieure a la version initiale (${v0})`);

      sseClient.close();
    } finally {
      await instance.close();
    }
  });

  test('U3 & KTD4 : fermeture propre du serveur avec client SSE connecte', async () => {
    const instance = await startServer(vault, 'pro', { port: 0, quiet: true });
    let reqClosed = false;

    const req = http.request(
      {
        host: '127.0.0.1',
        port: instance.port,
        path: '/events',
        headers: { host: `127.0.0.1:${instance.port}` },
      },
      (res) => {
        res.resume();
        res.on('close', () => {
          reqClosed = true;
        });
      }
    );
    req.end();

    await new Promise((r) => setTimeout(r, 50));
    await instance.close();
    // Laisser un tick pour que l'evenement close se propage sur la socket cliente
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(reqClosed, true, 'Le client SSE doit recevoir l evenement close lors de la fermeture');
  });

  test('HEAD /events repond 200 et se termine immediatement sans corps ni socket fantome', async () => {
    const instance = await startServer(vault, 'pro', { port: 0, quiet: true });
    try {
      const res = await fetch(`http://127.0.0.1:${instance.port}/events`, {
        method: 'HEAD',
        headers: { Host: `127.0.0.1:${instance.port}` },
      });
      assert.equal(res.status, 200);
      assert.equal(res.headers.get('content-type'), 'text/event-stream');
      const text = await res.text();
      assert.equal(text, '', 'La requete HEAD ne doit porter aucun corps');
    } finally {
      await instance.close();
    }
  });

  test('POST / renvoie 405 Methode non autorisee (immuabilite)', async () => {
    const instance = await startServer(vault, 'pro', { port: 0, quiet: true });
    try {
      const res = await fetch(`http://127.0.0.1:${instance.port}/`, {
        method: 'POST',
        headers: { Host: `127.0.0.1:${instance.port}` },
        body: 'test',
      });
      assert.equal(res.status, 405);
      const text = await res.text();
      assert.ok(text.includes('Methode non autorisee'));
    } finally {
      await instance.close();
    }
  });

  test('Host insensible a la casse : Localhost:<port> renvoie 200', async () => {
    const instance = await startServer(vault, 'pro', { port: 0, quiet: true });
    try {
      const rawReq = `GET / HTTP/1.1\r\nHost: Localhost:${instance.port}\r\nConnection: close\r\n\r\n`;
      const rawRes = await sendRawRequest(instance.port, rawReq);
      assert.ok(rawRes.includes('200 OK'));
    } finally {
      await instance.close();
    }
  });

  test('close() est idempotent : appeler deux fois close() ne leve pas ERR_SERVER_NOT_RUNNING', async () => {
    const instance = await startServer(vault, 'pro', { port: 0, quiet: true });
    await instance.close();
    await assert.doesNotReject(async () => {
      await instance.close();
    });
  });

  test('port invalide rejette la promesse sans fuite', async () => {
    await assert.rejects(
      async () => {
        await startServer(vault, 'pro', { port: -1, quiet: true });
      },
      /Port invalide/
    );

    await assert.rejects(
      async () => {
        await startServer(vault, 'pro', { port: NaN, quiet: true });
      },
      /Port invalide/
    );
  });
});
