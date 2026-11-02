/**
 * tools/dashboard/serve-ask.test.mjs
 *
 * Route POST /ask de l'onglet 問 Question (plan 2026-10-02-2218, U2).
 * `node --test tools/dashboard/serve-ask.test.mjs` — faux `claude`, jamais une vraie session.
 */

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, test } from 'node:test';

import { writeDashboardFile } from './run.mjs';
import { ASK_TOKEN_HEADER, startServer } from './serve.mjs';
import { declareFakeGuard, writeTestConfig } from '../test-vault.mjs';

const FAKE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'fake-claude.mjs');

let vault;
let record;
let instance;

const put = (rel, text) => {
  const file = path.join(vault, rel);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, text);
};

const start = async (domain = 'pro') => {
  instance = await startServer(vault, domain, { port: 0, quiet: true, askCommand: process.execPath, askCommandArgs: [FAKE] });
  return instance;
};

/** Requete HTTP brute : fetch interdit de poser Origin et Host librement. */
const request = (port, { method = 'GET', pathName = '/', headers = {}, body = null, onResponse } = {}) =>
  new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: pathName, headers: { Host: `localhost:${port}`, ...headers } }, (res) => {
      if (onResponse) onResponse(req, res);
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (c) => (data += c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
      res.on('error', () => resolve({ status: res.statusCode, headers: res.headers, body: data, aborted: true }));
    });
    req.on('error', (err) => (err.code === 'ECONNRESET' ? resolve({ aborted: true }) : reject(err)));
    if (body !== null) req.write(body);
    req.end();
  });

const tokenOf = async (port) => {
  const { body } = await request(port);
  const m = /"askToken":"([0-9a-f]{48})"/.exec(body);
  assert.ok(m, 'jeton present dans la page live');
  return m[1];
};

const ask = async (port, payload, extra = {}) => {
  const token = extra.token ?? (await tokenOf(port));
  const headers = {
    Origin: `http://localhost:${port}`,
    'Content-Type': 'application/json',
    [ASK_TOKEN_HEADER]: token,
    ...extra.headers,
  };
  for (const [k, v] of Object.entries(headers)) if (v === undefined) delete headers[k];
  return request(port, { method: 'POST', pathName: '/ask', headers, body: typeof payload === 'string' ? payload : JSON.stringify(payload), onResponse: extra.onResponse });
};

const lines = (body) => body.trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
const calls = () => readFileSync(record, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));

/**
 * Callback onResponse qui resout `ready` (avec la requete) au premier fragment de texte du flux : la session du faux
 * claude a demarre et ecrit. Signal d'action des tests d'occupation et d'annulation, a la place d'un delai fixe.
 */
const firstText = () => {
  let ready;
  const promise = new Promise((r) => (ready = r));
  const onResponse = (req, res) => {
    let seen = '';
    res.on('data', (c) => {
      seen += c;
      if (/"type":"text"/.test(seen)) ready(req);
    });
  };
  return { promise, onResponse };
};

/**
 * Repose la question jusqu'a ce que le serveur ne rende plus 409 (un 409 ne lance aucune session) : la liberation du
 * verrou apres une annulation est asynchrone (le processus doit mourir), on l'attend sans delai fixe.
 */
const askWhenFree = async (port, payload, extra) => {
  for (let i = 0; i < 500; i++) {
    const res = await ask(port, payload, extra);
    if (res.status !== 409) return res;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error('verrou jamais libere');
};

beforeEach(() => {
  vault = mkdtempSync(path.join(tmpdir(), 'serve-ask-test-'));
  writeTestConfig(vault);
  declareFakeGuard(vault);
  put('wiki/pro/projects/atlas.md', '---\ntitle: Atlas\ntype: project\n---\nAtlas.\n');
  put('wiki/perso/projects/maison.md', '---\ntitle: Maison\ntype: project\n---\nMaison.\n');
  record = path.join(vault, 'record.jsonl');
  writeFileSync(record, '');
  process.env.FAKE_CLAUDE_RECORD = record;
  process.env.FAKE_CLAUDE_SCENARIO = 'ok';
});
afterEach(async () => {
  if (instance) await instance.close();
  instance = null;
  delete process.env.FAKE_CLAUDE_RECORD;
  delete process.env.FAKE_CLAUDE_SCENARIO;
  rmSync(vault, { recursive: true, force: true });
});

describe('U2 : route POST /ask', () => {
  test('happy path : flux read, text, puis done avec le HTML rendu et un wikilink connu', async () => {
    process.env.FAKE_CLAUDE_SCENARIO = 'html';
    const { port } = await start();
    const res = await ask(port, { question: 'Atlas ?' });
    assert.equal(res.status, 200);
    assert.match(res.headers['content-type'], /application\/x-ndjson/);
    assert.equal(res.headers['access-control-allow-origin'], undefined);
    const evts = lines(res.body);
    assert.deepEqual(evts.filter((e) => e.type === 'read').map((e) => e.path), ['index.md', 'projects/atlas.md']);
    assert.ok(evts.some((e) => e.type === 'text'));
    const done = evts.at(-1);
    assert.equal(done.type, 'done');
    assert.match(done.html, /class="wikilink"/);
    assert.ok(!done.html.includes('<script>'), 'HTML brut echappe');
    assert.match(done.thread, /^[0-9a-f-]{36}$/);
    assert.equal(done.pagesRead, 2);
  });

  test('couvre AE4 : sans jeton, jeton faux, Origin tiers ou absent -> 403, aucune session lancee', async () => {
    const { port } = await start();
    assert.equal((await ask(port, { question: 'Q' }, { token: '' , headers: { [ASK_TOKEN_HEADER]: undefined } })).status, 403);
    assert.equal((await ask(port, { question: 'Q' }, { token: 'f'.repeat(48) })).status, 403);
    assert.equal((await ask(port, { question: 'Q' }, { headers: { Origin: 'https://evil.example' } })).status, 403);
    assert.equal((await ask(port, { question: 'Q' }, { headers: { Origin: undefined } })).status, 403);
    assert.equal(calls().length, 0);
  });

  test('Host invalide -> 403', async () => {
    const { port } = await start();
    const res = await request(port, { method: 'POST', pathName: '/ask', headers: { Host: 'evil.example' }, body: '{}' });
    assert.equal(res.status, 403);
  });

  test('GET /ask -> 405 ; POST / reste en 405', async () => {
    const { port } = await start();
    assert.equal((await request(port, { pathName: '/ask' })).status, 405);
    assert.equal((await request(port, { method: 'POST', pathName: '/', body: 'x' })).status, 405);
  });

  test('type non JSON -> 415, corps trop gros -> 413, JSON invalide ou question vide -> 400', async () => {
    const { port } = await start();
    assert.equal((await ask(port, { question: 'Q' }, { headers: { 'Content-Type': 'text/plain' } })).status, 415);
    const big = await ask(port, { question: 'x'.repeat(20000) });
    assert.ok(big.status === 413 || big.aborted, 'corps trop gros refuse');
    assert.equal((await ask(port, '{pas du json')).status, 400);
    assert.equal((await ask(port, { question: '   ' })).status, 400);
    assert.equal((await ask(port, { question: 'x'.repeat(4001) })).status, 400);
    assert.equal(calls().length, 0);
  });

  test('occupe : second POST pendant un flux -> 409, le premier continue', async () => {
    process.env.FAKE_CLAUDE_SCENARIO = 'hang';
    const { port } = await start();
    const token = await tokenOf(port);
    const streaming = firstText();
    const first = ask(port, { question: 'Q1' }, { token, onResponse: streaming.onResponse });
    const firstReq = await streaming.promise; // la premiere session tourne et ecrit
    const second = await ask(port, { question: 'Q2' }, { token });
    assert.equal(second.status, 409);
    assert.equal(JSON.parse(second.body).code, 'busy');
    firstReq.destroy();
    await first;
  });

  test('annulation : le client coupe la connexion, la session est tuee et le verrou libere', async () => {
    process.env.FAKE_CLAUDE_SCENARIO = 'hang';
    const { port } = await start();
    const token = await tokenOf(port);
    const streaming = firstText();
    const first = ask(port, { question: 'Q1' }, { token, onResponse: streaming.onResponse });
    (await streaming.promise).destroy(); // le client coupe une fois la session en train d'ecrire
    await first;
    process.env.FAKE_CLAUDE_SCENARIO = 'ok';
    const again = await askWhenFree(port, { question: 'Q2' }, { token });
    assert.equal(again.status, 200, 'verrou libere apres annulation');
  });

  test('arret : close() pendant un flux tue la session et se termine', async () => {
    process.env.FAKE_CLAUDE_SCENARIO = 'hang';
    const { port } = await start();
    const streaming = firstText();
    const pending = ask(port, { question: 'Q' }, { onResponse: streaming.onResponse });
    await streaming.promise; // la session tourne
    await instance.close();
    instance = null;
    const res = await pending;
    assert.ok(res.aborted || !res.body.includes('"type":"done"'));
  });

  test('silo : un serveur perso lance la session en perso, meme si le corps demande pro', async () => {
    const { port } = await start('perso');
    await ask(port, { question: 'Q', domain: 'pro' });
    const [c] = calls();
    assert.equal(c.domain, 'perso');
    assert.equal(c.mode, 'query');
  });

  test('suivi : le fil rendu par done est repris au tour suivant', async () => {
    const { port } = await start();
    const token = await tokenOf(port);
    const first = lines((await ask(port, { question: 'Q1' }, { token })).body).at(-1);
    await ask(port, { question: 'oui', thread: first.thread }, { token });
    const [, b] = calls();
    assert.equal(b.stdin, 'oui');
    assert.equal(b.args[b.args.indexOf('--resume') + 1], first.thread);
  });

  test('le jeton est dans la page live, jamais dans le fichier genere', async () => {
    const { port } = await start();
    const token = await tokenOf(port);
    const out = path.join(vault, 'out');
    writeDashboardFile(vault, 'pro', out);
    const html = readFileSync(path.join(out, readdirSync(out)[0]), 'utf8');
    assert.ok(!html.includes(token));
    assert.ok(html.includes('"askToken":null'));
  });
});
