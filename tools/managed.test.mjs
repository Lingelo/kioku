/**
 * Parties gerees du coffre (decision 2) : fusions pures, sans disque.
 * `node --test tools/managed.test.mjs`
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { BLOCK_END, BLOCK_START, gitignoreBlock, appendTopLevelKeys, legacyTranslation, managedScripts, mergeConfig, mergeGitignore, mergeScripts, mergeSettings, VAULT_FORMAT } from './managed.mjs';

describe('scripts', () => {
  test('tous geres (prefixe kioku), dashboard = premier domaine, plaud conditionnel', () => {
    const s = managedScripts(['travail', 'perso']);
    assert.ok(Object.values(s).every((v) => v.startsWith('kioku ')));
    assert.equal(s.dashboard, 'kioku dashboard travail');
    assert.equal(s['dashboard:serve:perso'], 'kioku dashboard perso --serve');
    assert.ok(!('plaud:sync' in s));
    assert.equal(managedScripts(['a'], { plaud: true })['plaud:drop'], 'kioku plaud --drop');
  });

  test('reecrit le gere, garde le maison, ajoute le manquant, signale l obsolete sans le retirer', () => {
    const existing = { a: 'node ~/mon-clone/tools/vault.mjs --domain a', digest: 'claude -p /digest', 'lint:a': 'kioku session a --lint', 'plaud:sync': 'kioku plaud' };
    const r = mergeScripts(existing, managedScripts(['a']));
    assert.equal(r.scripts.digest, 'claude -p /digest');
    assert.equal(r.scripts.a, existing.a, 'valeur sans prefixe kioku : script maison, laisse');
    assert.ok(r.kept.includes('a'));
    assert.ok(!r.changes.includes('lint:a'), 'deja a la forme courante');
    assert.ok(r.changes.includes('ingest:a'));
    assert.deepEqual(r.stale, ['plaud:sync']);
    assert.equal(r.scripts['plaud:sync'], 'kioku plaud');
  });

  test('idempotent', () => {
    const once = mergeScripts({}, managedScripts(['a', 'b'])).scripts;
    const twice = mergeScripts(once, managedScripts(['a', 'b']));
    assert.deepEqual(twice.scripts, once);
    assert.deepEqual(twice.changes, []);
  });
});

describe('.gitignore', () => {
  test('ajoute le bloc a la fin, garde les lignes maison', () => {
    const out = mergeGitignore('node_modules/\n', gitignoreBlock());
    assert.ok(out.startsWith('node_modules/\n'));
    assert.match(out, /tools\/dashboard\/dashboard-\*\.html/);
  });

  test('remplace un bloc existant, en place, et reste idempotent', () => {
    const first = mergeGitignore('a\n', gitignoreBlock());
    const withTail = `${first}b\n`;
    const plaud = mergeGitignore(withTail, gitignoreBlock({ plaud: true }));
    assert.match(plaud, /^a\n/);
    assert.match(plaud, /\.lock\.json\n# <<< kioku\nb\n$/);
    assert.equal(mergeGitignore(plaud, gitignoreBlock({ plaud: true })), plaud);
  });

  test('l etat local des circuits (verrou commun et son miroir, file, photo) est ignore dans tout coffre, module Plaud ou non', () => {
    for (const block of [gitignoreBlock(), gitignoreBlock({ plaud: true })]) {
      for (const line of ['tools/*/.lock.json', 'tools/*/.queue.json', 'tools/*/.snapshot.json']) {
        assert.equal(block.split('\n').filter((l) => l === line).length, 1, line);
      }
    }
    assert.doesNotMatch(gitignoreBlock(), /plaud/);
  });

  test('un bloc d une version anterieure (sans l etat des circuits) est complete, une seule fois', () => {
    const old = `node_modules/\n${BLOCK_START}\ninbox/\n.env\n${BLOCK_END}\nmaison/\n`;
    const once = mergeGitignore(old, gitignoreBlock());
    assert.equal(once.split('\n').filter((l) => l === 'tools/*/.lock.json').length, 1);
    assert.match(once, /^node_modules\/\n/);
    assert.match(once, /\nmaison\/\n$/);
    assert.equal(mergeGitignore(once, gitignoreBlock()), once);
  });

  test('bloc ouvert sans fin, ou en double : erreur, rien n est devine', () => {
    assert.throws(() => mergeGitignore(`${BLOCK_START}\ninbox/\n`, gitignoreBlock()), /ouvert sans fin/);
    assert.throws(() => mergeGitignore(`${BLOCK_START}\n${BLOCK_END}\n${BLOCK_START}\n${BLOCK_END}\n`, gitignoreBlock()), /double/);
  });
});

describe('settings', () => {
  test('le coffre active kioku@dojo, sans version ni marketplace ; le reste conserve', () => {
    const before = { permissions: { allow: ['Bash(ls)'] }, enabledPlugins: { 'autre@x': true }, extraKnownMarketplaces: { x: { source: {} } } };
    const out = mergeSettings(before);
    assert.deepEqual(out.permissions, before.permissions);
    assert.deepEqual(out.extraKnownMarketplaces, { x: { source: {} } }, 'les marketplaces maison restent');
    assert.deepEqual(out.enabledPlugins, { 'autre@x': true, 'kioku@dojo': true });
    assert.doesNotMatch(JSON.stringify(out), /sha|repo/);
  });

  test('les anciens identifiants sont retires (kioku-pin, kioku@kioku-pin, marketplace kioku, kioku@kioku)', () => {
    const before = {
      extraKnownMarketplaces: { 'kioku-pin': { source: {} }, kioku: { source: { source: 'github', repo: 'o/kioku' }, autoUpdate: true } },
      enabledPlugins: { 'kioku@kioku-pin': true, 'kioku@kioku': true },
    };
    const out = mergeSettings(before);
    assert.equal(out.extraKnownMarketplaces, undefined, 'plus aucune marketplace declaree : la cle disparait');
    assert.deepEqual(out.enabledPlugins, { 'kioku@dojo': true });
  });

  test('idempotent', () => {
    const once = mergeSettings({ permissions: {} });
    assert.deepEqual(mergeSettings(once), once);
  });
});

describe('config', () => {
  test('ajout seul : une valeur posee n est jamais remplacee', () => {
    const r = mergeConfig({ version: 1, format: 1, domains: [], default_session: { mode: 'setup' }, modules: { plaud: { state: 'ailleurs' } } }, { domains: ['a'], plaud: true });
    assert.deepEqual(r.config.default_session, { mode: 'setup' });
    assert.deepEqual(r.config.modules.plaud, { state: 'ailleurs' });
    assert.deepEqual(r.added, ['modules.dashboard']);
  });

  test('format absent : ajoute au format courant du core ; present : jamais remplace', () => {
    assert.equal(mergeConfig({ version: 1, domains: [] }, { domains: ['a'] }).config.format, VAULT_FORMAT);
    assert.equal(mergeConfig({ version: 1, format: 7, domains: [] }, { domains: ['a'] }).config.format, 7);
  });
});

// Ancien format genere par init avant le relais : les scripts reels d'un coffre en service (domaines pro, perso, Plaud).
describe('migration : ancien format genere', () => {
  const H = '${KIOKU_HOME:-$HOME/kioku}';
  const COFFRE = {
    vault: `node ${H}/tools/vault.mjs`,
    pro: `node ${H}/tools/vault.mjs --domain pro`,
    perso: `node ${H}/tools/vault.mjs --domain perso`,
    'ingest:pro': `node ${H}/tools/vault.mjs --mode ingest --domain pro`,
    'ingest:perso': `node ${H}/tools/vault.mjs --mode ingest --domain perso`,
    triage: `node ${H}/tools/vault.mjs --mode triage`,
    setup: `node ${H}/tools/vault.mjs --mode setup`,
    doctor: `${H}/bin/kioku doctor --vault .`,
    'lint:pro': `node ${H}/tools/vault.mjs --lint --domain pro`,
    'lint:perso': `node ${H}/tools/vault.mjs --lint --domain perso`,
    undecided: `${H}/bin/kioku undecided`,
    'audit:pro': `${H}/bin/kioku audit pro`,
    'audit:perso': `${H}/bin/kioku audit perso`,
    dashboard: `node ${H}/tools/dashboard/run.mjs pro`,
    'dashboard:pro': `node ${H}/tools/dashboard/run.mjs pro`,
    'dashboard:perso': `node ${H}/tools/dashboard/run.mjs perso`,
    'dashboard:all': `node ${H}/tools/dashboard/run.mjs all`,
    'dashboard:serve': `node ${H}/tools/dashboard/serve.mjs pro`,
    'dashboard:serve:pro': `node ${H}/tools/dashboard/serve.mjs pro`,
    'dashboard:serve:perso': `node ${H}/tools/dashboard/serve.mjs perso`,
    'plaud:sync': `node ${H}/tools/plaud-sync/run.mjs --vault .`,
    'plaud:dry-run': `node ${H}/tools/plaud-sync/run.mjs --vault . --dry-run`,
    'plaud:pending': `node ${H}/tools/plaud-sync/run.mjs --vault . --skip-fetch`,
    'plaud:drop': `node ${H}/tools/plaud-sync/run.mjs --vault . --drop`,
  };

  test('les 24 scripts du coffre basculent tous, exactement vers ce que genere init', () => {
    const wanted = managedScripts(['pro', 'perso'], { plaud: true });
    const r = mergeScripts(COFFRE, wanted);
    assert.equal(Object.keys(COFFRE).length, 24);
    assert.deepEqual(r.kept, [], 'aucun vu comme maison');
    assert.deepEqual(r.stale, []);
    assert.deepEqual(r.scripts, wanted);
    assert.deepEqual(Object.keys(r.scripts).slice(0, 24), Object.keys(COFFRE), 'ordre des cles conserve');
  });

  test('la traduction seule (sans equivalent voulu) donne deja la forme courante', () => {
    const wanted = managedScripts(['pro', 'perso'], { plaud: true });
    for (const [k, v] of Object.entries(COFFRE)) assert.equal(legacyTranslation(v), wanted[k], k);
  });

  test('proche mais different : reste maison, intact', () => {
    const close = {
      pro: `node ${H}/tools/vault.mjs --domain pro && say fini`,
      perso: 'node ~/kioku/tools/vault.mjs --domain perso',
      triage: `node ${H}/tools/vault.mjs --mode triage; echo x`,
      doctor: `${H}/bin/kioku doctor --vault . | tee log.txt`,
      'dashboard:pro': `node "${H}/tools/dashboard/run.mjs" pro`,
    };
    const r = mergeScripts(close, managedScripts(['pro', 'perso']));
    for (const k of Object.keys(close)) {
      assert.equal(r.scripts[k], close[k], k);
      assert.equal(legacyTranslation(close[k]), null, k);
    }
    assert.deepEqual(r.kept.sort(), Object.keys(close).sort());
  });

  test('seconde passe : rien a changer', () => {
    const wanted = managedScripts(['pro', 'perso'], { plaud: true });
    const once = mergeScripts(COFFRE, wanted).scripts;
    const twice = mergeScripts(once, wanted);
    assert.deepEqual(twice.changes, []);
    assert.deepEqual(twice.kept, []);
    assert.deepEqual(twice.stale, []);
  });

  test('ancien format sans equivalent voulu : traduit, signale', () => {
    const r = mergeScripts({ 'dashboard:vieux': `node ${H}/tools/dashboard/run.mjs perso` }, managedScripts(['pro']));
    assert.equal(r.scripts['dashboard:vieux'], 'kioku dashboard perso');
    assert.deepEqual(r.stale, ['dashboard:vieux']);
  });
});

describe('config : ajout sans reformater', () => {
  test('cle de premier niveau inseree avant la derniere accolade, le reste intact', () => {
    const text = '{\n  "version": 1,\n  "modules": { "dashboard": {} }\n}\n';
    const expected = { version: 1, modules: { dashboard: {} }, format: 1 };
    const out = appendTopLevelKeys(text, { format: 1 }, expected);
    assert.equal(out, '{\n  "version": 1,\n  "modules": { "dashboard": {} },\n  "format": 1\n}\n');
  });
  test('resultat different de l objet attendu : null (l appelant reecrit tout)', () => {
    assert.equal(appendTopLevelKeys('{ "a": 1 }', { b: 2 }, { a: 1, b: 3 }), null);
    assert.equal(appendTopLevelKeys('pas du json', { b: 2 }, { b: 2 }), null);
  });
});
