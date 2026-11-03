/**
 * Le relais `kioku` du PATH (bin/kioku-relay.mjs) : quel core il lance, et quand il refuse.
 * `node --test tools/relay.test.mjs`
 * HOME factice, faux cores (un tools/kioku.mjs qui affiche son chemin) : aucun fichier reel n'est lu.
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, test } from 'node:test';

import { resolveCore } from '../bin/kioku-relay.mjs';
import { writeTestConfig } from './test-vault.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RELAY = path.join(HERE, '..', 'bin', 'kioku-relay.mjs');

let root;
let vault;
let home;
beforeEach(() => {
  root = realpathSync(mkdtempSync(path.join(tmpdir(), 'kioku-relay-')));
  vault = path.join(root, 'coffre');
  home = path.join(root, 'home');
  writeTestConfig(vault);
  mkdirSync(path.join(home, '.claude', 'plugins'), { recursive: true });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

/** Un faux core : tools/kioku.mjs affiche « core=<dossier> args=<arguments> » ; format lu = `format`. */
const fakeCore = (dir, format = 1) => {
  mkdirSync(path.join(dir, 'tools'), { recursive: true });
  mkdirSync(path.join(dir, 'hooks'), { recursive: true });
  writeFileSync(path.join(dir, 'hooks', 'guard.mjs'), '// garde\n');
  writeFileSync(path.join(dir, 'hooks', 'format.json'), JSON.stringify({ vault: format }));
  writeFileSync(path.join(dir, 'tools', 'kioku.mjs'), `console.log('core=${dir} args=' + process.argv.slice(2).join(' '));\n`);
  return dir;
};
/** Installations kioku@kioku vues par Claude Code. */
const install = (entries) => {
  const plugins = {
    'kioku@dojo': entries.map(({ sha = 'a'.repeat(40), scope = 'user', projectPath, format = 1, lastUpdated = '2026-11-03T10:00:00Z' }) => ({
      scope,
      projectPath,
      installPath: fakeCore(path.join(home, '.claude', 'plugins', 'cache', 'dojo', 'kioku', sha.slice(0, 12)), format),
      gitCommitSha: sha,
      lastUpdated,
    })),
  };
  writeFileSync(path.join(home, '.claude', 'plugins', 'installed_plugins.json'), JSON.stringify({ version: 2, plugins }));
  return plugins['kioku@dojo'].map((i) => i.installPath);
};
const setVaultFormat = (format) => {
  const file = path.join(vault, 'kioku.config.json');
  writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, 'utf8')), format }));
};
const relay = (args, { cwd = vault, kiokuHome } = {}) => {
  const env = { ...process.env, HOME: home };
  delete env.KIOKU_HOME;
  if (kiokuHome !== undefined) env.KIOKU_HOME = kiokuHome;
  return spawnSync(process.execPath, [RELAY, ...args], { cwd, env, encoding: 'utf8' });
};

describe('KIOKU_HOME pose : le core local, avant le plugin', () => {
  test('prioritaire meme quand le plugin est installe ; note sur stderr', () => {
    install([{}]);
    const local = fakeCore(path.join(root, 'clone'));
    const r = relay(['session', 'a'], { kiokuHome: local });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, new RegExp(`core=${local} args=session a`));
    assert.match(r.stderr, /core local KIOKU_HOME=/);
  });

  test('KIOKU_HOME sans tools/kioku.mjs : refus, aucun repli sur le plugin', () => {
    install([{}]);
    mkdirSync(path.join(root, 'vide'));
    const r = relay(['doctor'], { kiokuHome: path.join(root, 'vide') });
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /KIOKU_HOME/);
    assert.doesNotMatch(r.stdout, /core=/);
  });

  test('KIOKU_HOME vide : traite comme absent', () => {
    const [dir] = install([{}]);
    assert.match(relay(['doctor'], { kiokuHome: '' }).stdout, new RegExp(`core=${dir}`));
  });
});

describe('sans KIOKU_HOME : le plugin kioku@dojo de la marketplace', () => {
  test('installe au niveau utilisateur : relaye, dans un coffre comme hors coffre', () => {
    const [dir] = install([{}]);
    assert.match(relay(['dashboard', 'a', '--serve']).stdout, new RegExp(`core=${dir} args=dashboard a --serve`));
    const empty = path.join(root, 'neuf');
    mkdirSync(empty);
    assert.match(relay(['init', '.'], { cwd: empty }).stdout, new RegExp(`core=${dir} args=init \\.`));
  });

  test('plusieurs installations qui s appliquent : la plus recente', () => {
    const [, recent] = install([
      { sha: '1'.repeat(40), lastUpdated: '2026-11-01T00:00:00Z' },
      { sha: '2'.repeat(40), scope: 'project', projectPath: vault, lastUpdated: '2026-11-03T00:00:00Z' },
    ]);
    assert.match(relay(['doctor']).stdout, new RegExp(`core=${recent}`));
  });

  test('installe seulement pour un autre projet : refus', () => {
    install([{ scope: 'project', projectPath: path.join(root, 'autre') }]);
    const r = relay(['session', 'a']);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /claude plugin install kioku@dojo --scope user/);
  });

  test('pas installe : refus avec la commande d installation ; aucun repli sur ~/kioku', () => {
    fakeCore(path.join(home, 'kioku'));
    const r = relay(['session', 'a']);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /claude plugin marketplace add <owner>\/dojo/);
    assert.doesNotMatch(r.stdout, /core=/);
  });

  test('installed_plugins.json illisible : refus (echec ferme)', () => {
    writeFileSync(path.join(home, '.claude', 'plugins', 'installed_plugins.json'), '{ casse');
    assert.notEqual(relay(['session', 'a']).status, 0);
  });

  test('les anciens identifiants (kioku@kioku-pin, kioku@kioku) ne sont plus un core', () => {
    for (const id of ['kioku@kioku-pin', 'kioku@kioku']) {
      const dir = fakeCore(path.join(home, '.claude', 'plugins', 'cache', id.split('@')[1], 'kioku', 'x'));
      writeFileSync(
        path.join(home, '.claude', 'plugins', 'installed_plugins.json'),
        JSON.stringify({ version: 2, plugins: { [id]: [{ scope: 'user', installPath: dir, gitCommitSha: 'x' }] } }),
      );
      assert.notEqual(relay(['session', 'a']).status, 0, id);
    }
  });
});

describe('format : le core doit savoir lire le coffre', () => {
  test('coffre au format 2, plugin au format 1 : refus avec la commande de mise a jour', () => {
    install([{ format: 1 }]);
    setVaultFormat(2);
    const r = relay(['session', 'a']);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /exige le format 2.*ne lit que le format 1/);
    assert.match(r.stderr, /claude plugin update kioku@dojo/);
  });

  test('coffre plus ancien que le core : relaye (le core lit les formats anterieurs)', () => {
    const [dir] = install([{ format: 3 }]);
    setVaultFormat(1);
    assert.match(relay(['doctor']).stdout, new RegExp(`core=${dir}`));
  });

  test('coffre sans "format" : vaut 1', () => {
    const [dir] = install([{ format: 1 }]);
    assert.match(relay(['doctor']).stdout, new RegExp(`core=${dir}`));
  });

  test('KIOKU_HOME trop ancien pour le coffre : refus aussi', () => {
    setVaultFormat(2);
    const r = relay(['doctor'], { kiokuHome: fakeCore(path.join(root, 'clone'), 1) });
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /KIOKU_HOME=.*exige le format 2/);
  });
});

describe('pose par le script d installation : copie hors du core, lancee par un lien symbolique', () => {
  test('refuse (code non nul) sans core ; relaie avec KIOKU_HOME', () => {
    const relayDir = path.join(root, 'relay');
    const binDir = path.join(root, 'bin');
    mkdirSync(relayDir);
    mkdirSync(binDir);
    for (const [from, name] of [[RELAY, 'kioku-relay.mjs'], [path.join(HERE, 'plugin-install.mjs'), 'plugin-install.mjs']]) {
      writeFileSync(path.join(relayDir, name), readFileSync(from));
    }
    symlinkSync(path.join(relayDir, 'kioku-relay.mjs'), path.join(binDir, 'kioku'));
    const run = (extra) => {
      const env = { ...process.env, HOME: home, ...extra };
      if (!extra.KIOKU_HOME) delete env.KIOKU_HOME;
      return spawnSync(process.execPath, [path.join(binDir, 'kioku'), 'doctor'], { cwd: vault, env, encoding: 'utf8' });
    };
    const refused = run({});
    assert.notEqual(refused.status, 0, 'jamais un code 0 silencieux');
    assert.match(refused.stderr, /kioku :/);
    const local = fakeCore(path.join(root, 'clone'));
    assert.match(run({ KIOKU_HOME: local }).stdout, /core=.* args=doctor/);
  });
});

describe('resolveCore (sans processus)', () => {
  test('rend { core } ou { error }, jamais une valeur par defaut', () => {
    assert.ok(resolveCore({ cwd: vault, env: { HOME: home } }).error);
    const [dir] = install([{}]);
    assert.equal(resolveCore({ cwd: vault, env: { HOME: home } }).core, dir);
  });
});
