/**
 * Tests OAuth, HTTP et fournisseur Gmail : `node --test tools/mail-sync/oauth.test.mjs`
 * Aucun appel reseau : `fetch` simule ; la boucle OAuth tourne sur 127.0.0.1 avec un « navigateur » simule (une requete
 * locale). Dossier de configuration temporaire : aucun vrai client ni jeton n'est lu.
 */

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { HOOKS_DIR, writeTestConfig } from '../test-vault.mjs';

import { fakeGmail, gmailMessage, jsonResponse } from './fixtures.mjs';
import { HttpError, requestJson } from './http.mjs';
import { accessToken, authUrl, loadClient, login, pkce, saveToken, SCOPE, TOKEN_URL, waitForCode } from './oauth.mjs';
import { configDir, tokenPath } from './paths.mjs';
import { createGmail } from './providers/gmail.mjs';

let dir;
const noSleep = async () => {};
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'kioku-mail-cfg-'));
  writeFileSync(path.join(dir, 'client.json'), JSON.stringify({ installed: { client_id: 'cid.apps.example.com', client_secret: 'secret-invente' } }));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const form = (init) => Object.fromEntries(new URLSearchParams(init.body));

describe('emplacements', () => {
  test('XDG, ~/.config, %APPDATA% ; un identifiant de compte invalide n est jamais un nom de fichier', () => {
    assert.equal(configDir({ XDG_CONFIG_HOME: '/x' }, 'linux', '/h'), path.join('/x', 'kioku', 'mail'));
    assert.equal(configDir({}, 'darwin', '/h'), path.join('/h', '.config', 'kioku', 'mail'));
    assert.equal(configDir({ APPDATA: 'C:\\U\\A' }, 'win32', 'C:\\U'), path.join('C:\\U\\A', 'kioku', 'mail'));
    for (const bad of ['../x', 'a/b', 'A', '', undefined]) assert.throws(() => tokenPath(bad, dir), /compte mail invalide/);
  });
  test('client.json : format telecharge ou plat ; absent ou incomplet : message qui dit ou le poser', () => {
    assert.deepEqual(loadClient(dir), { clientId: 'cid.apps.example.com', clientSecret: 'secret-invente' });
    writeFileSync(path.join(dir, 'client.json'), JSON.stringify({ client_id: 'a', client_secret: 'b' }));
    assert.equal(loadClient(dir).clientId, 'a');
    writeFileSync(path.join(dir, 'client.json'), JSON.stringify({ client_id: 'a' }));
    assert.throws(() => loadClient(dir), /incomplet/);
    rmSync(path.join(dir, 'client.json'));
    assert.throws(() => loadClient(dir), /client OAuth absent.*Desktop/);
  });
});

describe('PKCE et URL', () => {
  test('defi = SHA-256(verificateur) en base64url ; scope lecture seule ; state et redirection portes', () => {
    const { verifier, challenge } = pkce(Buffer.alloc(32, 7));
    assert.match(verifier, /^[A-Za-z0-9_-]{43}$/);
    assert.equal(challenge, createHash('sha256').update(verifier).digest('base64url'));
    const u = new URL(authUrl({ clientId: 'c', redirectUri: 'http://127.0.0.1:5', state: 's', challenge }));
    assert.equal(u.searchParams.get('scope'), SCOPE);
    assert.equal(SCOPE, 'https://www.googleapis.com/auth/gmail.readonly');
    assert.equal(u.searchParams.get('code_challenge_method'), 'S256');
    assert.equal(u.searchParams.get('state'), 's');
    assert.equal(u.searchParams.get('access_type'), 'offline');
  });
});

describe('boucle locale', () => {
  test('state invalide : 400 et on continue d attendre ; le bon state rend le code', async () => {
    const statuses = [];
    let browser;
    const code = await waitForCode({
      state: 'bon-state',
      timeoutMs: 5000,
      onListening: (redirect) => (browser = (async () => {
        assert.match(redirect, /^http:\/\/127\.0\.0\.1:\d+$/);
        statuses.push((await fetch(`${redirect}/?state=mauvais&code=vole`)).status);
        statuses.push((await fetch(`${redirect}/autre?state=bon-state&code=x`)).status);
        statuses.push((await fetch(`${redirect}/?state=bon-state&code=le-code`)).status);
      })()),
    });
    await browser;
    assert.equal(code.code, 'le-code');
    assert.deepEqual(statuses, [400, 404, 200]);
  });
  test('refus de l utilisateur (error=access_denied) : arret avec le motif', async () => {
    await assert.rejects(
      waitForCode({ state: 's', timeoutMs: 5000, onListening: (r) => void fetch(`${r}/?state=s&error=access_denied`).catch(() => {}) }),
      /access_denied/,
    );
  });
  test('delai depasse : message qui dit de relancer', async () => {
    await assert.rejects(waitForCode({ state: 's', timeoutMs: 50, onListening: () => {} }), /relance mail:login/);
  });
});

describe('connexion complete', () => {
  test('le code est echange avec le verificateur PKCE du defi envoye ; jeton ecrit en 0600, hors coffre ; jamais affiche', async () => {
    let challenge;
    const fetchFn = async (url, init) => {
      assert.equal(url, TOKEN_URL);
      const f = form(init);
      assert.equal(f.grant_type, 'authorization_code');
      assert.equal(f.code, 'code-recu');
      assert.equal(createHash('sha256').update(f.code_verifier).digest('base64url'), challenge, 'PKCE : le verificateur correspond au defi');
      return jsonResponse(200, { access_token: 'acces-invente', refresh_token: 'refresh-invente', expires_in: 3600 });
    };
    const logs = [];
    const original = console.log;
    console.log = (...a) => logs.push(a.join(' '));
    let file;
    try {
      file = await login('travail', {
        dir,
        fetch: fetchFn,
        now: () => 1_000,
        openUrl: (u) => {
          const url = new URL(u);
          challenge = url.searchParams.get('code_challenge');
          void fetch(`${url.searchParams.get('redirect_uri')}/?state=${url.searchParams.get('state')}&code=code-recu`);
        },
      });
    } finally {
      console.log = original;
    }
    assert.equal(file, path.join(dir, 'travail.json'));
    const t = JSON.parse(readFileSync(file, 'utf8'));
    assert.deepEqual([t.access_token, t.refresh_token, t.expires_at], ['acces-invente', 'refresh-invente', 1_000 + 3_600_000]);
    if (process.platform !== 'win32') {
      assert.equal(statSync(file).mode & 0o777, 0o600);
      assert.equal(statSync(dir).mode & 0o077, 0, 'dossier non lisible par les autres');
    }
    assert.ok(!logs.join('\n').includes('acces-invente') && !logs.join('\n').includes('refresh-invente'), 'aucun jeton dans la sortie');
  });
  test('pas de refresh_token rendu : erreur explicite, rien n est ecrit', async () => {
    await assert.rejects(
      login('travail', {
        dir,
        fetch: async () => jsonResponse(200, { access_token: 'a', expires_in: 3600 }),
        openUrl: (u) => {
          const url = new URL(u);
          void fetch(`${url.searchParams.get('redirect_uri')}/?state=${url.searchParams.get('state')}&code=c`);
        },
      }),
      /refresh_token/,
    );
    assert.equal(existsSync(path.join(dir, 'travail.json')), false);
  });
});

describe('jeton : rafraichissement', () => {
  test('valide : rendu tel quel, aucun appel', async () => {
    saveToken('travail', { access_token: 'a1', refresh_token: 'r', expires_at: 10_000_000 }, dir);
    assert.equal(await accessToken('travail', { dir, now: () => 0, fetch: async () => assert.fail('aucun appel attendu') }), 'a1');
  });
  test('expire : rafraichi, reecrit (refresh_token garde), toujours 0600', async () => {
    saveToken('travail', { access_token: 'a1', refresh_token: 'r1', expires_at: 1000 }, dir);
    const got = await accessToken('travail', {
      dir,
      now: () => 5000,
      fetch: async (url, init) => {
        assert.equal(form(init).grant_type, 'refresh_token');
        assert.equal(form(init).refresh_token, 'r1');
        return jsonResponse(200, { access_token: 'a2', expires_in: 3600 });
      },
    });
    assert.equal(got, 'a2');
    const t = JSON.parse(readFileSync(path.join(dir, 'travail.json'), 'utf8'));
    assert.equal(t.refresh_token, 'r1');
    assert.equal(t.expires_at, 5000 + 3_600_000);
    if (process.platform !== 'win32') assert.equal(statSync(path.join(dir, 'travail.json')).mode & 0o777, 0o600);
  });
  test('refresh refuse (invalid_grant) : message clair, relancer mail:login, sans jeton dans le message', async () => {
    saveToken('travail', { access_token: 'a1', refresh_token: 'r-secret', expires_at: 0 }, dir);
    await assert.rejects(
      accessToken('travail', { dir, now: () => 5000, fetch: async () => jsonResponse(400, { error: 'invalid_grant', error_description: 'Token has been expired or revoked.' }) }),
      (e) => /refuse/.test(e.message) && /npm run mail:login -- travail/.test(e.message) && !e.message.includes('r-secret'),
    );
  });
  test('jeton absent ou illisible : dire quelle commande lancer', async () => {
    await assert.rejects(accessToken('perso', { dir }), /npm run mail:login -- perso/);
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, 'perso.json'), '{ tronque');
    await assert.rejects(accessToken('perso', { dir }), /illisible.*mail:login/);
  });
});

describe('HTTP : relances bornees', () => {
  test('429 avec Retry-After puis succes ; l attente demandee est respectee (plafonnee)', async () => {
    const waits = [];
    let n = 0;
    const r = await requestJson('https://x.example.com', {}, { fetch: async () => (++n === 1 ? jsonResponse(429, { error: 'rate' }, { 'retry-after': '120' }) : jsonResponse(200, { ok: 1 })), sleep: async (ms) => waits.push(ms) });
    assert.deepEqual(r, { ok: 1 });
    assert.deepEqual(waits, [30_000]);
  });
  test('5xx repete : au plus 3 relances, puis erreur qui le dit', async () => {
    let n = 0;
    await assert.rejects(requestJson('https://x.example.com', {}, { fetch: async () => (n++, jsonResponse(503, {})), sleep: noSleep, what: 'test' }), /test : HTTP 503 apres 3 relance/);
    assert.equal(n, 4);
  });
  test('4xx (hors 429) : aucune relance', async () => {
    let n = 0;
    await assert.rejects(requestJson('https://x.example.com', {}, { fetch: async () => (n++, jsonResponse(403, { error: { code: 403, status: 'PERMISSION_DENIED' } })), sleep: noSleep }), (e) => e instanceof HttpError && e.status === 403 && e.code === 'PERMISSION_DENIED');
    assert.equal(n, 1);
  });
  test('erreur reseau : relancee, puis erreur nommee', async () => {
    let n = 0;
    await assert.rejects(requestJson('https://x.example.com', {}, { fetch: async () => { n++; throw new TypeError('fetch failed'); }, sleep: noSleep, retries: 2 }), /reseau indisponible/);
    assert.equal(n, 3);
  });
});

describe('fournisseur Gmail', () => {
  const msg = (id, t, extra = {}) => gmailMessage({ id, threadId: 't1', internalDate: t, text: `texte ${id}`, ...extra });
  const threads = Array.from({ length: 5 }, (_, i) => ({ id: `t${i}`, messages: [msg(`m${i}`, 1_700_000_000_000 + i)] }));

  test('libelle resolu par son nom (casse ignoree), pagination nextPageToken jusqu au bout, filtre after:', async () => {
    const g = fakeGmail({ labels: [{ id: 'L9', name: 'KB' }], threads, pageSize: 2 });
    const gm = createGmail({ token: async () => 'tok', fetch: g.fetch, sleep: noSleep });
    const list = await gm.listThreads('kb', '2026-11-01');
    assert.deepEqual(list.map((t) => t.id), ['t0', 't1', 't2', 't3', 't4']);
    const pages = g.calls.filter((c) => c.url.includes('/threads?'));
    assert.equal(pages.length, 3);
    assert.equal(new URL(pages[0].url).searchParams.get('labelIds'), 'L9');
    assert.equal(new URL(pages[0].url).searchParams.get('q'), 'after:2026/11/01');
    assert.equal(g.calls[0].init.headers.authorization, 'Bearer tok');
  });
  test('libelle absent : erreur qui dit de le creer', async () => {
    const gm = createGmail({ token: async () => 'tok', fetch: fakeGmail({ labels: [], threads }).fetch, sleep: noSleep });
    await assert.rejects(gm.listThreads('kb'), /libelle Gmail introuvable : "kb"/);
  });
  test('401 en cours de route : un rafraichissement force, puis la requete repasse', async () => {
    const forced = [];
    const g = fakeGmail({ threads, failures: (url, n) => (n === 1 ? jsonResponse(401, { error: { code: 401, status: 'UNAUTHENTICATED' } }) : null) });
    const gm = createGmail({ token: async ({ force }) => (forced.push(force), force ? 'neuf' : 'vieux'), fetch: g.fetch, sleep: noSleep });
    await gm.listThreads('kb');
    assert.deepEqual(forced.slice(0, 2), [false, true]);
    assert.equal(g.calls[1].init.headers.authorization, 'Bearer neuf');
  });
  test('getThread : messages normalises et tries ; getAttachment : octets', async () => {
    const pdf = Buffer.from('%PDF-1.4 invente');
    const t = { id: 'tx', messages: [msg('b', 2000), msg('a', 1000, { attachments: [{ filename: 'devis.pdf', size: pdf.length, attachmentId: 'A1' }] })] };
    const gm = createGmail({ token: async () => 'tok', fetch: fakeGmail({ threads: [t], attachments: { A1: pdf } }).fetch, sleep: noSleep });
    const got = await gm.getThread('tx');
    assert.deepEqual(got.messages.map((m) => m.id), ['a', 'b']);
    assert.equal(got.messages[0].text, 'texte a');
    assert.equal(got.messages[0].headers.from, 'Alice Martin <alice@example.com>');
    assert.deepEqual(got.messages[0].attachments.map((a) => [a.filename, a.attachmentId]), [['devis.pdf', 'A1']]);
    assert.deepEqual(await gm.getAttachment('a', 'A1'), pdf);
  });
});

// B1 : la garde ferme le dossier que paths.mjs calcule, quel que soit l'emplacement retenu (meme calcul, deux copies :
// la garde ne depend pas de tools/). Ce test les tient ensemble.
describe('le dossier des jetons est ferme par la garde', () => {
  test('pour chaque mode, le jeton et le client calcules par paths.mjs sont refuses en lecture', () => {
    const vault = mkdtempSync(path.join(tmpdir(), 'kioku-mail-guard-'));
    try {
      writeTestConfig(vault, { version: 1, domains: [{ id: 'pro' }] });
      for (const env of [{ XDG_CONFIG_HOME: dir }, { XDG_CONFIG_HOME: '' }]) {
        const home = mkdtempSync(path.join(tmpdir(), 'kioku-mail-home-'));
        const full = { ...process.env, HOME: home, USERPROFILE: home, CLAUDE_PROJECT_DIR: vault, ...env };
        if (!full.XDG_CONFIG_HOME) delete full.XDG_CONFIG_HOME;
        const target = configDir(full, process.platform, home);
        for (const mode of [['query', 'pro'], ['ingest', 'pro'], ['triage'], ['setup']]) {
          for (const file of [tokenPath('travail', target), path.join(target, 'client.json')]) {
            const e = { ...full, VAULT_MODE: mode[0], ...(mode[1] ? { VAULT_DOMAIN: mode[1] } : {}) };
            if (!mode[1]) delete e.VAULT_DOMAIN;
            const r = spawnSync(process.execPath, [path.join(HOOKS_DIR, 'guard.mjs')], { input: JSON.stringify({ tool_name: 'Read', tool_input: { file_path: file }, cwd: vault }), env: e, encoding: 'utf8' });
            assert.equal(r.status, 2, `${mode[0]} : ${file}`);
          }
        }
        rmSync(home, { recursive: true, force: true });
      }
    } finally {
      rmSync(vault, { recursive: true, force: true });
    }
  });
});

