/**
 * tools/dashboard/serve.mjs
 *
 * Serveur HTTP local securise pour le tableau de bord en direct.
 *
 * Garanties et architecture (KTD2, KTD5, KTD6, KTD7, KTD8) :
 * - Ecoute exclusive sur loopback 127.0.0.1 (jamais 0.0.0.0)
 * - Validation stricte du header Host pour contrer le DNS rebinding
 * - Table de routes statique (aucun chemin de fichier derive de l'URL)
 * - Cache-Control: no-store et Content-Security-Policy sur le HTML
 * - Aucune entete Access-Control-Allow-* (zero lecture inter-origines)
 * - Un seul domaine par processus
 * - Le serveur n'ecrit rien dans le coffre. La route POST /ask lance une session `claude -p` en mode
 *   query, sous la garde (ask.mjs) : c'est elle, et elle seule, qui peut ecrire (journal, index,
 *   candidates de /save), comme en CLI. La route exige le jeton du demarrage et l'Origin attendu.
 */

import { randomBytes, timingSafeEqual } from 'node:crypto';
import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { createAsker } from './ask.mjs';
import { readHeldAndCandidates } from './held-read.mjs';
import { renderMarkdown } from './markdown.mjs';
import { generateDashboardHtml, resolveDomains } from './run.mjs';
import { readGoldTopologyAndIssues } from './vault-read.mjs';
import { createWatcher } from './watch.mjs';
import { assertDomain, domainsOf } from '../vault-config.mjs';

// Ressources embarquees (bibliotheque, polices, video) : livrees avec le code du dashboard, donc a cote de ce module,
// pas dans le coffre (le core est installe ailleurs).
const VENDOR_DIR = fileURLToPath(new URL('./vendor', import.meta.url));

export const ASK_TOKEN_HEADER = 'x-kioku-token';
const ASK_MAX_BODY = 16 * 1024;
const ASK_MAX_QUESTION = 4000;

const sameToken = (a, b) => {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && timingSafeEqual(ba, bb);
};

// Port par defaut : 3456 + rang du domaine dans la configuration (pro 3456, perso 3457 pour l'ordre d'aujourd'hui).
// Deux serveurs de domaines differents ne se disputent donc jamais le meme port par defaut.
export const BASE_PORT = 3456;
export const defaultPort = (vaultRoot, domain) => BASE_PORT + Math.max(0, domainsOf(vaultRoot).indexOf(domain));

export const CSP_HEADER =
  "default-src 'none'; script-src 'self' 'unsafe-inline' 'unsafe-eval'; style-src 'unsafe-inline'; connect-src 'self'; img-src 'self' data: blob:; font-src 'self' data:; media-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

/**
 * Configure les gestionnaires de terminaison SIGINT/SIGTERM pour un arret propre.
 *
 * @param {() => Promise<void>} close - Fonction d'arret du serveur
 * @param {boolean} [quiet=false] - Supprime les messages console si vrai
 */
export const setupGracefulShutdown = (close, quiet = false) => {
  const shutdown = async () => {
    if (!quiet) console.log('\n[dashboard] Arret du serveur...');
    try {
      await close();
    } catch {
      // ignore
    }
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
};

/**
 * Demarre le serveur HTTP local pour un domaine donne.
 *
 * @param {string} vaultRoot - Racine absolue du coffre
 * @param {string} domain - un domaine declare dans la configuration du coffre
 * @param {object} [options={}] - Options (port, quiet, debounceMs, heartbeatMs, version)
 * @returns {Promise<{server: http.Server, port: number, domain: string, url: string, close: () => Promise<void>, watcher: object}>}
 */
export const startServer = (vaultRoot, domain, options = {}) => {
  assertDomain(vaultRoot, domain);

  const requestedPort = options.port !== undefined ? options.port : defaultPort(vaultRoot, domain);
  const quiet = Boolean(options.quiet);

  return new Promise((resolve, reject) => {
    let currentVersion = typeof options.version === 'number' ? options.version : Date.now();
    // Identifiant de demarrage : avec node --watch (npm run dashboard:dev), le serveur
    // redemarre a chaque modification du code ; la page compare ce boot a celui de sa
    // premiere connexion SSE et se recharge d'elle-meme s'il change. Seulement sous --watch
    // (Node pose WATCH_REPORT_DEPENDENCIES dans le processus surveille) : en `serve`, un autre
    // boot leve le bandeau, la page ne se recharge jamais seule.
    const bootId = Date.now();
    const dev = options.dev !== undefined ? Boolean(options.dev) : Boolean(process.env.WATCH_REPORT_DEPENDENCIES);
    const ssePayload = () => `data: ${JSON.stringify({ version: currentVersion, boot: bootId, dev })}\n\n`;
    const vendorDir = options.vendorDir || VENDOR_DIR;
    const vendorFile = path.join(vendorDir, '3d-force-graph.min.js');
    let cachedVendor = null;

    // Onglet 問 Question : jeton tire a chaque demarrage, injecte seulement dans la page live
    const askToken = randomBytes(24).toString('hex');
    const asker = createAsker({
      vaultRoot,
      domain,
      command: options.askCommand || 'claude',
      commandArgs: options.askCommandArgs || [],
    });

    const sseClients = new Set();
    const broadcast = (payload) => {
      for (const res of sseClients) {
        if (res.destroyed || res.writableEnded) {
          sseClients.delete(res);
          continue;
        }
        try {
          const ok = res.write(payload);
          if (!ok && (res.destroyed || res.writableEnded)) {
            sseClients.delete(res);
          }
        } catch {
          sseClients.delete(res);
        }
      }
    };

    let candidateHashes = new Set();
    const updateCandidateHashes = () => {
      try {
        const held = readHeldAndCandidates(vaultRoot, domain);
        candidateHashes = new Set((held?.candidates || []).map((c) => c.hash).filter(Boolean));
      } catch {
        // ignore
      }
    };
    updateCandidateHashes();

    const watcher = createWatcher(vaultRoot, domain, {
      debounceMs: options.debounceMs,
      heartbeatMs: options.heartbeatMs,
      getCandidateHashes: () => candidateHashes,
      onChanged: () => {
        updateCandidateHashes();
        currentVersion = Math.max(Date.now(), currentVersion + 1);
        broadcast(ssePayload());
      },
    });

    const sseHeartbeatTimer = setInterval(() => {
      broadcast(': keepalive\n\n');
    }, 30000);
    if (typeof sseHeartbeatTimer.unref === 'function') {
      sseHeartbeatTimer.unref();
    }

    const cleanupResources = () => {
      asker.killAll();
      if (sseHeartbeatTimer) clearInterval(sseHeartbeatTimer);
      try {
        watcher.close();
      } catch {
        // ignore
      }
      for (const res of sseClients) {
        try {
          res.end();
        } catch {
          // ignore
        }
      }
      sseClients.clear();
    };

    let expectedHosts = new Set([`localhost:${requestedPort}`, `127.0.0.1:${requestedPort}`]);

    const plain = (res, status, text) => {
      res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(text);
    };

    /**
     * POST /ask : une question de l'onglet 問, une ligne JSON par evenement en reponse.
     * Controles dans l'ordre : methode, Origin (absent = refus), jeton, type, taille, question.
     * Un site tiers ne peut pas envoyer l'en-tete du jeton sans pre-vol CORS, que le serveur ne
     * valide jamais (aucun Access-Control-Allow-*).
     */
    const handleAsk = (req, res, host) => {
      if (req.method !== 'POST') {
        plain(res, 405, 'Methode non autorisee');
        return;
      }
      const origin = (req.headers.origin || '').toLowerCase();
      if (origin !== `http://${host}`) {
        plain(res, 403, 'Forbidden: Origin invalide');
        return;
      }
      if (!sameToken(req.headers[ASK_TOKEN_HEADER], askToken)) {
        plain(res, 403, 'Forbidden: jeton invalide');
        return;
      }
      if (!/^application\/json\b/i.test(req.headers['content-type'] || '')) {
        plain(res, 415, 'Corps JSON attendu');
        return;
      }

      const chunks = [];
      let size = 0;
      let tooBig = false;
      req.on('data', (chunk) => {
        if (tooBig) return;
        size += chunk.length;
        if (size > ASK_MAX_BODY) {
          tooBig = true;
          res.setHeader('Connection', 'close');
          plain(res, 413, 'Corps trop volumineux');
          req.destroy();
          return;
        }
        chunks.push(chunk);
      });
      req.on('end', () => {
        if (tooBig) return;
        let body;
        try {
          body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        } catch {
          plain(res, 400, 'JSON invalide');
          return;
        }
        // Le domaine n'est jamais lu dans le corps : c'est celui du serveur (silo)
        const question = typeof body?.question === 'string' ? body.question.trim() : '';
        const thread = typeof body?.thread === 'string' ? body.thread : null;
        if (!question || question.length > ASK_MAX_QUESTION) {
          plain(res, 400, 'Question vide ou trop longue');
          return;
        }
        if (asker.isBusy()) {
          res.writeHead(409, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
          res.end(JSON.stringify({ type: 'error', code: 'busy' }));
          return;
        }

        res.writeHead(200, {
          'Content-Type': 'application/x-ndjson; charset=utf-8',
          'Cache-Control': 'no-store',
          'X-Content-Type-Options': 'nosniff',
        });
        const send = (obj) => {
          if (!res.writableEnded && !res.destroyed) res.write(JSON.stringify(obj) + '\n');
        };

        const handle = asker.ask(question, thread, (evt) => {
          if (evt.type === 'done') {
            let html;
            try {
              const known = new Set(readGoldTopologyAndIssues(vaultRoot, domain).pages.keys());
              html = renderMarkdown(evt.markdown, { isKnownPage: (t) => known.has(t) });
            } catch {
              html = renderMarkdown(evt.markdown);
            }
            send({ type: 'done', thread: evt.thread, html, durationMs: evt.durationMs, pagesRead: evt.pagesRead });
            res.end();
          } else if (evt.type === 'error' || evt.type === 'cancelled') {
            send(evt);
            res.end();
          } else {
            send(evt);
          }
        });
        if (handle === null) {
          send({ type: 'error', code: 'busy' });
          res.end();
          return;
        }
        // Page fermee ou fetch annule : la reponse se ferme avant la fin, on tue la session
        res.on('close', () => {
          if (!res.writableFinished) handle.cancel();
        });
      });
    };

    const server = http.createServer((req, res) => {
      // KTD6 : Validation du header Host contre le DNS rebinding (insensible a la casse)
      const rawHost = req.headers.host;
      const host = rawHost ? rawHost.toLowerCase() : '';
      if (!host || !expectedHosts || !expectedHosts.has(host)) {
        res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Forbidden: Host invalide');
        return;
      }

      let pathname;
      try {
        const parsed = new URL(req.url, 'http://127.0.0.1');
        pathname = parsed.pathname;
      } catch {
        res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Requete malformee');
        return;
      }

      // Route de question : la seule qui accepte POST
      if (pathname === '/ask') {
        handleAsk(req, res, host);
        return;
      }

      if (req.method !== 'GET' && req.method !== 'HEAD') {
        res.writeHead(405, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Methode non autorisee');
        return;
      }

      // Route 1 : Page principale (rendue a la volee - R3)
      if (pathname === '/') {
        try {
          const html = generateDashboardHtml(vaultRoot, domain, {
            mode: 'live',
            version: currentVersion,
            askToken,
          });
          res.writeHead(200, {
            'Content-Type': 'text/html; charset=utf-8',
            'Cache-Control': 'no-store',
            'Content-Security-Policy': CSP_HEADER,
          });
          if (req.method === 'HEAD') {
            res.end();
          } else {
            res.end(html);
          }
        } catch (err) {
          if (!quiet) {
            console.error('[dashboard] Erreur de rendu live :', err?.message || err);
          }
          res.writeHead(500, {
            'Content-Type': 'text/plain; charset=utf-8',
            'Cache-Control': 'no-store',
          });
          res.end('Erreur interne du serveur');
        }
        return;
      }

      // Route favicon silencieuse (204 No Content)
      if (pathname === '/favicon.ico') {
        res.writeHead(204);
        res.end();
        return;
      }

      // Route 2 : Flux d'evenements SSE (KTD4, R4, R5)
      if (pathname === '/events') {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache, no-transform',
          'Connection': 'keep-alive',
          'X-Accel-Buffering': 'no',
        });
        if (req.method === 'HEAD') {
          res.end();
          return;
        }

        res.write(ssePayload());

        sseClients.add(res);
        req.on('close', () => {
          sseClients.delete(res);
        });
        res.on('close', () => {
          sseClients.delete(res);
        });
        return;
      }

      // Route 3 : Bibliotheque vendor UMD locale constante
      if (pathname === '/vendor/3d-force-graph.min.js') {
        if (!cachedVendor) {
          if (existsSync(vendorFile)) {
            try {
              cachedVendor = readFileSync(vendorFile);
            } catch {
              res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
              res.end('Erreur lecture ressource vendor');
              return;
            }
          } else {
            res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
            res.end('Ressource vendor introuvable');
            return;
          }
        }

        res.writeHead(200, {
          'Content-Type': 'text/javascript; charset=utf-8',
          'Cache-Control': 'public, max-age=3600',
        });
        if (req.method === 'HEAD') {
          res.end();
        } else {
          res.end(cachedVendor);
        }
        return;
      }

      // Route 4 : Polices vendorisees WOFF2 (KTD1, U1)
      if (pathname.startsWith('/vendor/fonts/')) {
        const fontName = pathname.slice('/vendor/fonts/'.length);
        if (!/^[a-zA-Z0-9_-]+\.woff2$/.test(fontName)) {
          res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
          res.end('Police introuvable');
          return;
        }

        const fontsDir = path.join(vendorDir, 'fonts');
        const resolvedPath = path.resolve(fontsDir, fontName);
        if (!resolvedPath.startsWith(fontsDir + path.sep) || !existsSync(resolvedPath)) {
          res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
          res.end('Police introuvable');
          return;
        }

        try {
          const fontContent = readFileSync(resolvedPath);
          res.writeHead(200, {
            'Content-Type': 'font/woff2',
            'Cache-Control': 'public, max-age=86400',
          });
          if (req.method === 'HEAD') {
            res.end();
          } else {
            res.end(fontContent);
          }
        } catch {
          res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
          res.end('Erreur lecture ressource police');
        }
        return;
      }

      // Route 5 : video du Mode d'emploi et ses sous-titres. Lecture par plages (Range) :
      // indispensable pour se deplacer dans la video, et pour Safari qui refuse un MP4 sans 206.
      if (pathname.startsWith('/vendor/media/')) {
        const mediaName = pathname.slice('/vendor/media/'.length);
        const MEDIA_TYPES = { mp4: 'video/mp4', vtt: 'text/vtt; charset=utf-8' };
        const ext = /^[a-zA-Z0-9_-]+\.(mp4|vtt)$/.exec(mediaName)?.[1];
        const mediaDir = path.join(vendorDir, 'media');
        const resolvedPath = ext ? path.resolve(mediaDir, mediaName) : '';
        if (!ext || !resolvedPath.startsWith(mediaDir + path.sep) || !existsSync(resolvedPath)) {
          res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
          res.end('Media introuvable');
          return;
        }

        try {
          const size = statSync(resolvedPath).size;
          const headers = { 'Content-Type': MEDIA_TYPES[ext], 'Accept-Ranges': 'bytes', 'Cache-Control': 'public, max-age=86400' };
          const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
          let start = 0;
          let end = size - 1;
          if (range && (range[1] || range[2])) {
            if (range[1]) {
              start = Number(range[1]);
              end = range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
            } else {
              start = Math.max(0, size - Number(range[2]));   // suffixe : les N derniers octets
            }
            if (start >= size || start > end) {
              res.writeHead(416, { 'Content-Range': `bytes */${size}` });
              res.end();
              return;
            }
            res.writeHead(206, { ...headers, 'Content-Range': `bytes ${start}-${end}/${size}`, 'Content-Length': end - start + 1 });
          } else {
            res.writeHead(200, { ...headers, 'Content-Length': size });
          }
          if (req.method === 'HEAD') {
            res.end();
            return;
          }
          const stream = createReadStream(resolvedPath, { start, end });
          stream.on('error', () => res.destroy());
          stream.pipe(res);
        } catch {
          res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
          res.end('Erreur lecture media');
        }
        return;
      }

      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Non trouve');
    });

    server.on('error', (err) => {
      cleanupResources();
      if (err.code === 'EADDRINUSE') {
        const msg = `[dashboard] Port ${requestedPort} deja utilise. Utilisez l'option --port pour specifier un autre port.`;
        if (!quiet) console.error(msg);
        reject(new Error(msg));
      } else {
        reject(err);
      }
    });

    if (typeof requestedPort !== 'number' || Number.isNaN(requestedPort) || requestedPort < 0 || requestedPort > 65535) {
      cleanupResources();
      reject(new Error(`[dashboard] Port invalide : ${requestedPort}.`));
      return;
    }

    try {
      server.listen(requestedPort, '127.0.0.1', () => {
        const boundAddress = server.address();
        const boundPort = typeof boundAddress === 'object' && boundAddress ? boundAddress.port : requestedPort;
        const url = `http://localhost:${boundPort}/`;
        expectedHosts = new Set([`localhost:${boundPort}`, `127.0.0.1:${boundPort}`]);
        if (boundPort === 80) {
          expectedHosts.add('localhost');
          expectedHosts.add('127.0.0.1');
        }

        if (!quiet) {
          console.log(`[dashboard] Serveur en direct (${domain}) demarre : ${url}`);
          console.log('[dashboard] Appuyez sur Ctrl+C pour arreter.');
        }

        let isClosing = false;
        const close = () =>
          new Promise((resClose, rejClose) => {
            cleanupResources();
            if (isClosing || !server.listening) {
              resClose();
              return;
            }
            isClosing = true;
            if (typeof server.closeAllConnections === 'function') {
              server.closeAllConnections();
            }
            server.close((closeErr) => {
              if (closeErr && closeErr.code !== 'ERR_SERVER_NOT_RUNNING') {
                rejClose(closeErr);
              } else {
                resClose();
              }
            });
          });

        resolve({
          server,
          port: boundPort,
          domain,
          url,
          close,
          watcher,
        });
      });
    } catch (listenErr) {
      cleanupResources();
      reject(listenErr);
    }
  });
};

const isDirectExecution = () => {
  if (!process.argv[1]) return false;
  return import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
};

if (isDirectExecution()) {
  const args = process.argv.slice(2);
  const vaultRoot = path.resolve();

  let domain;
  let port;

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--port' && args[i + 1]) {
      port = parseInt(args[i + 1], 10);
      i++;
    } else if (!a.startsWith('--')) {
      domain = a;
    }
  }

  let domains;
  try {
    domains = resolveDomains(domain, process.env, vaultRoot);
  } catch (err) {
    console.error(`[dashboard] ${err.message}`);
    process.exit(1);
  }

  if (domains.length !== 1) {
    console.error("[dashboard] Le serveur ne peut executer qu'un domaine a la fois.");
    process.exit(1);
  }

  startServer(vaultRoot, domains[0], { port })
    .then(({ close }) => {
      setupGracefulShutdown(close);
    })
    .catch((err) => {
      console.error(`[dashboard] Erreur au demarrage : ${err?.message || err}`);
      process.exit(1);
    });
}
