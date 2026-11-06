/**
 * Tests de la denylist du depot core (plan core/data, U11) : `node --test tools/denylist-check.test.mjs`
 * Depots git jetables dans des dossiers temporaires, termes fictifs : aucun fichier du coffre reel n'est lu.
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, test } from 'node:test';

import { fold, loadDenylist, matchers, scan } from './denylist-check.mjs';

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'denylist-check.mjs');

let root;
let repo;
let list;
beforeEach(() => {
  root = realpathSync(mkdtempSync(path.join(tmpdir(), 'denylist-test-')));
  repo = path.join(root, 'core');
  list = path.join(root, 'denylist.txt');
  writeFileSync(list, '# termes prives (fictifs)\nInitech\nBob Lambda\nZed\n');
  const run = (...a) => spawnSync('git', a, { cwd: root, encoding: 'utf8' });
  run('init', '-q', '-b', 'main', repo);
  // Hermetique : une signature de commit configuree sur le poste (commit.gpgsign + agent SSH) ferait echouer les commits
  // de test des qu'on lance la suite sans agent (env -i). Le depot de test ne signe pas.
  run('-C', repo, 'config', 'commit.gpgsign', 'false');
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const git = (...args) => {
  const r = spawnSync('git', args, {
    cwd: repo,
    encoding: 'utf8',
    env: { ...process.env, GIT_AUTHOR_NAME: 'Alice', GIT_AUTHOR_EMAIL: 'alice@example.org', GIT_COMMITTER_NAME: 'Alice', GIT_COMMITTER_EMAIL: 'alice@example.org' },
  });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.trim();
};
const commit = (file, text, message = 'ajout', author) => {
  mkdirSync(path.dirname(path.join(repo, file)), { recursive: true });
  writeFileSync(path.join(repo, file), text);
  git('add', file);
  return author ? git('-c', `user.name=${author}`, 'commit', '-q', '--author', `${author} <x@example.org>`, '-m', message) : git('commit', '-q', '-m', message);
};
const check = (args, { input = '', env = {} } = {}) =>
  spawnSync(process.execPath, [SCRIPT, ...args], { cwd: repo, input, encoding: 'utf8', env: { ...process.env, KIOKU_DENYLIST: list, ...env } });

describe('la liste', () => {
  test('commentaires et lignes vides ignores', () => {
    assert.deepEqual(loadDenylist({ KIOKU_DENYLIST: list }), ['Initech', 'Bob Lambda', 'Zed']);
  });
  test('variable absente, fichier introuvable, liste vide : refus nomme', () => {
    assert.throws(() => loadDenylist({}), /KIOKU_DENYLIST n'est pas defini/);
    assert.throws(() => loadDenylist({ KIOKU_DENYLIST: path.join(root, 'absent.txt') }), /introuvable/);
    writeFileSync(list, '# rien\n\n');
    assert.throws(() => loadDenylist({ KIOKU_DENYLIST: list }), /vide/);
  });
});

describe('la recherche', () => {
  test('insensible a la casse et aux accents', () => {
    assert.equal(fold('Élodie'), 'elodie');
    assert.equal(scan([{ where: 'x', text: 'chez INITECH' }], ['initech']).length, 1);
    assert.equal(scan([{ where: 'x', text: 'chez Élodie' }], ['elodie']).length, 1);
  });
  test('un terme court se cherche en mot entier, pas au milieu d un autre mot', () => {
    const [zed] = matchers(['Zed']);
    assert.ok(zed.test('selon Zed, le 10/09'));
    assert.ok(!zed.test('un zedonk'), 'pas au milieu d un mot');
  });
  test('un terme compose se cherche en sous-chaine', () => {
    assert.equal(scan([{ where: 'x', text: 'avec Bob Lambda hier' }], ['Bob Lambda']).length, 1);
  });
});

describe('les commandes', () => {
  test('tree : un terme dans un fichier suivi est trouve et nomme', () => {
    commit('a.md', 'Projet chez Initech.\n');
    const r = check(['tree']);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /« Initech » : fichier a\.md/);
    assert.doesNotMatch(r.stderr, /Projet chez/, 'la ligne entiere n est jamais recopiee');
  });

  test('tree : rien trouve, code 0', () => {
    commit('a.md', 'Projet chez Acme.\n');
    assert.equal(check(['tree']).status, 0);
  });

  test('tree : le contenu sous vendor/ n est pas lu, son nom l est', () => {
    commit('lib/vendor/three.min.js', 'var Initech=1;\n');
    assert.equal(check(['tree']).status, 0, 'code tiers : contenu ignore');
    commit('vendor/initech.js', 'x\n');
    assert.match(check(['tree']).stderr, /« Initech » : chemin vendor\/initech\.js/);
  });

  test('range : un nom de fichier prive est trouve ; le contenu sous vendor/ ne l est pas', () => {
    commit('a.md', 'x\n');
    const base = git('rev-parse', 'HEAD');
    commit('vendor/lib.js', 'var Zed=1;\n');
    assert.equal(check(['range', `${base}..HEAD`]).status, 0);
    commit('notes-initech.md', 'propre\n');
    assert.match(check(['range', `${base}..HEAD`]).stderr, /« Initech » : chemin notes-initech\.md/);
  });

  test('pre-push : sha distant inconnu (force-push apres reecriture) : tout ce qui est pousse est controle', () => {
    commit('a.md', 'Projet Initech\n');
    const head = git('rev-parse', 'HEAD');
    const unknown = 'f'.repeat(40);
    const r = check(['pre-push', 'origin'], { input: `refs/heads/main ${head} refs/heads/main ${unknown}\n` });
    assert.equal(r.status, 1, r.stderr);
    assert.match(r.stderr, /« Initech »/);
    commit('a.md', 'Projet Acme\n', 'retrait');
    const clean = git('rev-parse', 'HEAD');
    assert.equal(check(['pre-push', 'origin'], { input: `refs/heads/main ${clean} refs/heads/main ${unknown}\n` }).status, 1, 'l historique entier est lu');
  });

  test('range : un terme dans un message de commit est trouve', () => {
    commit('a.md', 'x\n');
    const base = git('rev-parse', 'HEAD');
    commit('b.md', 'propre\n', 'reprise du travail de Bob Lambda');
    const r = check(['range', `${base}..HEAD`]);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /« Bob Lambda » : message/);
  });

  test('range : un terme dans le nom d auteur est trouve', () => {
    commit('a.md', 'x\n');
    const base = git('rev-parse', 'HEAD');
    commit('b.md', 'propre\n', 'ajout', 'Zed');
    assert.match(check(['range', `${base}..HEAD`]).stderr, /« Zed » : auteur/);
  });

  test('range : seules les lignes ajoutees comptent, pas celles qui partent', () => {
    commit('a.md', 'Initech\n');
    const base = git('rev-parse', 'HEAD');
    commit('a.md', 'Acme\n', 'retrait du terme');
    assert.equal(check(['range', `${base}..HEAD`]).status, 0);
  });

  test('pre-push : branche neuve (sha distant nul) controlee depuis la racine', () => {
    commit('a.md', 'chez Initech\n');
    const head = git('rev-parse', 'HEAD');
    const r = check(['pre-push', 'origin', 'url'], { input: `refs/heads/main ${head} refs/heads/main ${'0'.repeat(40)}\n` });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /push refuse/);
  });

  test('pre-push : suppression de ref (sha local nul) : rien a controler', () => {
    commit('a.md', 'chez Initech\n');
    const r = check(['pre-push', 'origin', 'url'], { input: `(delete) ${'0'.repeat(40)} refs/heads/vieille ${git('rev-parse', 'HEAD')}\n` });
    assert.equal(r.status, 0);
  });

  test('pre-push : un nom de branche prive est refuse', () => {
    commit('a.md', 'propre\n');
    const head = git('rev-parse', 'HEAD');
    const r = check(['pre-push', 'origin', 'url'], { input: `refs/heads/client-initech ${head} refs/heads/client-initech ${'0'.repeat(40)}\n` });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /ref/);
  });

  test('history : tout l historique, y compris un terme retire depuis', () => {
    commit('a.md', 'chez Initech\n');
    commit('a.md', 'chez Acme\n', 'nettoyage');
    assert.equal(check(['tree']).status, 0, 'l arbre courant est propre');
    const r = check(['history']);
    assert.equal(r.status, 1, 'l historique garde le terme');
    assert.match(r.stderr, /« Initech » : contenu a\.md/);
  });

  test('liste absente : code 2, rien ne passe', () => {
    commit('a.md', 'propre\n');
    const env = { ...process.env };
    delete env.KIOKU_DENYLIST;
    const r = spawnSync(process.execPath, [SCRIPT, 'tree'], { cwd: repo, encoding: 'utf8', env });
    assert.equal(r.status, 2);
    assert.match(r.stderr, /KIOKU_DENYLIST/);
  });

  test('commande inconnue : code 2', () => {
    assert.equal(check(['nimporte']).status, 2);
  });
});
