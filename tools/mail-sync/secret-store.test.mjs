/**
 * Tests du magasin de secrets du module mail : `node --test tools/mail-sync/secret-store.test.mjs`
 *
 * Trousseau SIMULE : de faux `security` (macOS) et `secret-tool` (Linux) places en tete du PATH gardent les secrets dans
 * un fichier JSON et journalisent leurs arguments et leur entree standard. On verifie ainsi qu'aucun secret ne passe en
 * argument d'un processus. Aucun vrai trousseau n'est touche ; secrets inventes.
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { terminalEnv, writeTestConfig } from '../test-vault.mjs';
import { accessToken, loadClient, loadToken, saveToken } from './oauth.mjs';
import { jsonResponse } from './fixtures.mjs';
import { fileWarning, secretStore, SecretStoreError } from './secret-store.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SECRET = 'refresh-INVENTE-1//0abc"quote';
let root;
let bin;
let dir;
let env;

const fakeSecurity = `#!${process.execPath}
const fs = require('node:fs');
const db = () => (fs.existsSync(process.env.FAKE_DB) ? JSON.parse(fs.readFileSync(process.env.FAKE_DB, 'utf8')) : {});
const save = (d) => fs.writeFileSync(process.env.FAKE_DB, JSON.stringify(d));
const args = process.argv.slice(2);
const stdin = args[0] === '-i' ? fs.readFileSync(0, 'utf8') : '';
fs.appendFileSync(process.env.FAKE_ARGS, JSON.stringify({ cmd: 'security', args, stdin }) + '\\n');
const opt = (a, n) => a[a.indexOf(n) + 1];
const one = (a) => {
  if (a[0] === 'help') return 0;
  if (process.env.FAKE_LOCKED) { process.stderr.write('security: SecKeychainItemCopyContent: User interaction is not allowed.\\n'); return 51; }
  const d = db();
  const k = opt(a, '-a');
  if (a[0] === 'add-generic-password') { d[k] = Buffer.from(opt(a, '-X'), 'hex').toString('utf8'); save(d); return 0; }
  if (a[0] === 'find-generic-password') {
    if (!(k in d)) { process.stderr.write('security: SecKeychainSearchCopyNext: The specified item could not be found in the keychain.\\n'); return 44; }
    process.stdout.write(d[k] + '\\n'); return 0;
  }
  if (a[0] === 'delete-generic-password') { if (!(k in d)) return 44; delete d[k]; save(d); return 0; }
  return 2;
};
if (args[0] === '-i') { for (const line of stdin.split('\\n').filter(Boolean)) one(line.trim().split(/\\s+/)); process.exit(0); }
process.exit(one(args));
`;

const fakeSecretTool = `#!${process.execPath}
const fs = require('node:fs');
const db = () => (fs.existsSync(process.env.FAKE_DB) ? JSON.parse(fs.readFileSync(process.env.FAKE_DB, 'utf8')) : {});
const save = (d) => fs.writeFileSync(process.env.FAKE_DB, JSON.stringify(d));
const args = process.argv.slice(2);
const stdin = args[0] === 'store' ? fs.readFileSync(0, 'utf8') : '';
fs.appendFileSync(process.env.FAKE_ARGS, JSON.stringify({ cmd: 'secret-tool', args, stdin }) + '\\n');
if (process.env.FAKE_NODBUS) { process.stderr.write('secret-tool: Cannot autolaunch D-Bus without X11 $DISPLAY\\n'); process.exit(1); }
const attr = (n) => args[args.indexOf(n) + 1];
const d = db();
const k = attr('account');
if (args[0] === 'lookup') { if (!(k in d)) process.exit(1); process.stdout.write(d[k]); process.exit(0); }
if (args[0] === 'store') { d[k] = stdin; save(d); process.exit(0); }
if (args[0] === 'clear') { delete d[k]; save(d); process.exit(0); }
process.exit(2);
`;

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'kioku-secrets-'));
  bin = path.join(root, 'bin');
  dir = path.join(root, 'config', 'kioku', 'mail');
  mkdirSync(bin, { recursive: true });
  for (const [name, body] of [['security', fakeSecurity], ['secret-tool', fakeSecretTool]]) {
    writeFileSync(path.join(bin, name), body);
    chmodSync(path.join(bin, name), 0o755);
  }
  env = terminalEnv({ PATH: `${bin}${path.delimiter}${process.env.PATH}`, FAKE_DB: path.join(root, 'db.json'), FAKE_ARGS: path.join(root, 'args.log') });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const calls = () => (existsSync(env.FAKE_ARGS) ? readFileSync(env.FAKE_ARGS, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
const hex = (s) => Buffer.from(s, 'utf8').toString('hex');

for (const [platform, cmd] of [['darwin', 'security'], ['linux', 'secret-tool']]) {
  describe(`trousseau ${platform} (${cmd} simule)`, () => {
    test('ecrire, relire, supprimer ; le secret ne passe jamais en argument d un processus', () => {
      const store = secretStore({ platform, env, dir });
      assert.equal(store.file, false);
      store.set('token:travail', SECRET);
      assert.equal(store.get('token:travail'), SECRET);
      store.del('token:travail');
      assert.equal(store.get('token:travail'), null);
      const all = calls();
      assert.ok(all.length > 0);
      for (const c of all) {
        const argv = c.args.join(' ');
        assert.ok(!argv.includes(SECRET) && !argv.includes(hex(SECRET)), `${cmd} ${argv}`);
      }
      // Le secret est passe par l'entree standard (hexadecimal pour security -i, brut pour secret-tool store).
      assert.ok(all.some((c) => c.stdin.includes(platform === 'darwin' ? hex(SECRET) : SECRET)));
      assert.equal(existsSync(path.join(dir, 'travail.json')), false, 'aucun fichier ecrit');
    });

    test('entree absente : null (le jeton manquant sera signale avec la commande a relancer)', () => {
      assert.equal(secretStore({ platform, env, dir }).get('token:absent'), null);
    });

    test('cle invalide : refusee avant tout appel', () => {
      assert.throws(() => secretStore({ platform, env, dir }).get('token:../x'), SecretStoreError);
    });
  });
}

describe('trousseau indisponible ou verrouille', () => {
  test('Linux sans service de secrets (D-Bus) : repli fichier, avertissement', () => {
    const store = secretStore({ platform: 'linux', env: { ...env, FAKE_NODBUS: '1' }, dir });
    assert.equal(store.file, true);
    assert.match(fileWarning(store), /secrets du module mail en FICHIER \(secret-tool introuvable, ou aucun service de secrets/);
  });

  test('commande absente (PATH vide) : repli fichier', () => {
    assert.equal(secretStore({ platform: 'darwin', env: { PATH: '' }, dir }).file, true);
  });

  test('Windows : repli fichier, dit', () => {
    const store = secretStore({ platform: 'win32', env, dir });
    assert.equal(store.file, true);
    assert.match(fileWarning(store), /pas de trousseau Windows/);
  });

  test('secretStore: "file" : fichier 0600, avertissement ; valeur inconnue : refusee', () => {
    const store = secretStore({ mode: 'file', env, dir });
    store.set('token:travail', SECRET);
    assert.equal(readFileSync(path.join(dir, 'travail.json'), 'utf8'), SECRET);
    if (process.platform !== 'win32') assert.equal(statSync(path.join(dir, 'travail.json')).mode & 0o777, 0o600);
    assert.match(fileWarning(store), /secretStore: "file"/);
    assert.equal(fileWarning(secretStore({ platform: 'darwin', env, dir })), null);
    assert.throws(() => secretStore({ mode: 'coffre' }), /secretStore inconnu/);
  });
});

// Le verrou simule doit tomber APRES la sonde (help) : on pose FAKE_LOCKED apres la creation du magasin.
test('macOS : verrouille apres ouverture du magasin', () => {
  const store = secretStore({ platform: 'darwin', env, dir });
  env.FAKE_LOCKED = '1';
  assert.throws(() => store.get('token:travail'), /deverrouille/);
  assert.throws(() => store.set('token:travail', 'x'), /deverrouille/);
});

describe('jeton et client au trousseau (oauth.mjs)', () => {
  const store = () => secretStore({ platform: process.platform === 'linux' ? 'linux' : 'darwin', env, dir });
  const token = { access_token: 'a1', refresh_token: SECRET, expires_at: 1 };

  test('saveToken : au trousseau, aucun fichier ; loadToken le relit', () => {
    const s = store();
    const where = saveToken('travail', token, dir, { store: s });
    assert.match(where, /entree token:travail/);
    assert.equal(existsSync(path.join(dir, 'travail.json')), false);
    assert.deepEqual(loadToken('travail', dir, { store: s }), token);
  });

  test('migration : un fichier de jeton existant est importe, relu, puis supprime, et la sortie le dit', () => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, 'travail.json'), JSON.stringify(token));
    const logs = [];
    const s = store();
    assert.deepEqual(loadToken('travail', dir, { store: s, log: (l) => logs.push(l) }), token);
    assert.equal(existsSync(path.join(dir, 'travail.json')), false, 'fichier supprime apres relecture');
    assert.equal(s.get('token:travail'), JSON.stringify(token));
    assert.match(logs.join('\n'), /importe au trousseau .*fichier supprime/);
  });

  test('migration refusee si la relecture differe : le fichier reste', () => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, 'travail.json'), JSON.stringify(token));
    const s = store();
    const broken = { ...s, set: () => {}, get: (k) => (k === 'token:travail' ? null : s.get(k)) };
    assert.throws(() => loadToken('travail', dir, { store: { ...broken, get: () => null, set: () => {} } }), /relecture differente|pas de jeton/);
    assert.ok(existsSync(path.join(dir, 'travail.json')));
  });

  test('entree absente du trousseau : « relance kioku mail --login »', () => {
    assert.throws(() => loadToken('perso', dir, { store: store() }), /pas de jeton pour le compte perso au trousseau : relance `kioku mail --login perso`/);
  });

  test('client : importe de client.json au --login, puis lu au trousseau ; le fichier n est pas supprime par le core', () => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, 'client.json'), JSON.stringify({ installed: { client_id: 'cid.apps.example.com', client_secret: 'secret-client-invente' } }));
    const s = store();
    const logs = [];
    const imported = loadClient(dir, { store: s, importFile: true, log: (l) => logs.push(l) });
    assert.equal(imported.clientId, 'cid.apps.example.com');
    assert.match(logs.join('\n'), /Client OAuth importe au trousseau/);
    assert.ok(existsSync(path.join(dir, 'client.json')), 'jamais supprime sans accord');
    rmSync(path.join(dir, 'client.json'));
    assert.equal(loadClient(dir, { store: s }).clientSecret, 'secret-client-invente', 'relu au trousseau, sans fichier');
  });

  test('client absent partout : message qui dit de poser client.json puis de lancer --login', () => {
    assert.throws(() => loadClient(dir, { store: store() }), /client OAuth absent du trousseau.*kioku mail --login/s);
  });

  test('rafraichissement : le nouveau jeton va au trousseau', async () => {
    const s = store();
    s.set('client', JSON.stringify({ client_id: 'c', client_secret: 's' }));
    saveToken('travail', token, dir, { store: s });
    const got = await accessToken('travail', { dir, store: s, now: () => 5000, fetch: async () => jsonResponse(200, { access_token: 'a2', expires_in: 3600 }) });
    assert.equal(got, 'a2');
    assert.equal(JSON.parse(s.get('token:travail')).access_token, 'a2');
    assert.equal(JSON.parse(s.get('token:travail')).refresh_token, SECRET, 'refresh_token garde');
    assert.equal(existsSync(path.join(dir, 'travail.json')), false);
  });
});

describe('fetch-mail et doctor', () => {
  test('fetch-mail au trousseau : jeton absent, « relance kioku mail --login », aucun depot', () => {
    const vault = path.join(root, 'coffre');
    writeTestConfig(vault, { version: 1, domains: [{ id: 'pro' }], modules: { mail: { state: 'tools/mail-sync', accounts: [{ id: 'travail', provider: 'gmail' }] } } });
    const r = spawnSync(process.execPath, [path.join(HERE, 'fetch-mail.mjs')], { encoding: 'utf8', env: terminalEnv({ ...env, CLAUDE_PROJECT_DIR: vault, XDG_CONFIG_HOME: path.join(root, 'config') }) });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /au trousseau : relance `kioku mail --login travail`/);
    assert.doesNotMatch(r.stderr, /en FICHIER/, 'trousseau disponible : pas d avertissement');
    assert.equal(existsSync(path.join(vault, 'inbox')), false);
  });

  test('secretStore: "file" : avertissement a chaque lancement ; valeur inconnue : configuration refusee', () => {
    const vault = path.join(root, 'coffre');
    writeTestConfig(vault, { version: 1, domains: [{ id: 'pro' }], modules: { mail: { state: 'tools/mail-sync', secretStore: 'file', accounts: [{ id: 'travail', provider: 'gmail' }] } } });
    const r = spawnSync(process.execPath, [path.join(HERE, 'fetch-mail.mjs')], { encoding: 'utf8', env: terminalEnv({ ...env, CLAUDE_PROJECT_DIR: vault, XDG_CONFIG_HOME: path.join(root, 'config') }) });
    assert.match(r.stderr, /secrets du module mail en FICHIER \(secretStore: "file"/);
    writeTestConfig(vault, { version: 1, domains: [{ id: 'pro' }], modules: { mail: { state: 'tools/mail-sync', secretStore: 'coffre', accounts: [] } } });
    const bad = spawnSync(process.execPath, [path.join(HERE, 'fetch-mail.mjs')], { encoding: 'utf8', env: terminalEnv({ ...env, CLAUDE_PROJECT_DIR: vault }) });
    assert.match(bad.stderr, /"secretStore" doit valoir "keychain"/);
  });

  test('kioku doctor dit ou sont les secrets (repli fichier : avertissement)', () => {
    const vault = path.join(root, 'coffre');
    const KIOKU = path.join(HERE, '..', 'kioku.mjs');
    assert.equal(spawnSync(process.execPath, [KIOKU, 'init', vault, '--domains', 'pro', '--mail', '--guard-hook'], { encoding: 'utf8', env: terminalEnv({ ...env, HOME: root }) }).status, 0);
    const cfgFile = path.join(vault, 'kioku.config.json');
    const cfg = JSON.parse(readFileSync(cfgFile, 'utf8'));
    cfg.modules.mail.secretStore = 'file';
    writeFileSync(cfgFile, JSON.stringify(cfg));
    const r = spawnSync(process.execPath, [KIOKU, 'doctor', '--vault', vault], { encoding: 'utf8', env: terminalEnv({ ...env, HOME: root }) });
    assert.match(r.stdout, /mail : Attention : secrets du module mail en FICHIER/);
  });
});
