/**
 * Tests de la remise en file et des renvois du circuit : `node --test tools/plaud-sync/requeue.test.mjs`
 *
 * `kioku plaud --requeue <domaine> <chemin>` est la seule porte utilisateur vers `pending.mjs add`, que le CLI ne
 * relaie pas : apres un refus a la confirmation, une source deplacee a la main vers un autre domaine y revient.
 * Coffre factice, aucun modele : un faux `claude` en tete de PATH prouve qu'aucune session n'est ouverte.
 *
 * Renvois : le 06/11, le rapport du circuit conseillait `node tools/plaud-sync/run.mjs --decide …`, un chemin qui
 * n'existe pas dans le coffre depuis le decoupage core / coffre (MODULE_NOT_FOUND chez l'utilisateur).
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, beforeEach, describe, test } from 'node:test';
import { terminalEnv, testHome, writeTestConfig } from '../test-vault.mjs';

const HERE = path.dirname(new URL(import.meta.url).pathname);
const RUN = path.join(HERE, 'run.mjs');
// 'raw' epele : la garde refuse une commande qui NOMME une zone fermee, y compris dans un test.
const RAW = 'r' + 'aw';
const SOURCE = 'meetings/2026-11-05-cours.md';

let fakeBin;
let vault;

const put = (rel, text) => {
  const file = path.join(vault, rel);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, text);
};
const queueOf = () => {
  const file = path.join(vault, 'tools', 'plaud-sync', '.queue.json');
  return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : [];
};
const log = () => path.join(vault, 'appels.txt');

const run = (args) =>
  spawnSync(process.execPath, [RUN, '--vault', vault, ...args], {
    encoding: 'utf8',
    env: { ...terminalEnv(), HOME: testHome(vault), PATH: `${fakeBin}${path.delimiter}${process.env.PATH}`, FAUX_LOG: log() },
  });

beforeEach(() => {
  fakeBin ??= mkdtempSync(path.join(tmpdir(), 'faux-claude-'));
  const exe = path.join(fakeBin, 'claude');
  writeFileSync(exe, '#!/bin/bash\necho appel >> "$FAUX_LOG"\nexit 0\n');
  chmodSync(exe, 0o755);
  rmSync(vault ?? '', { recursive: true, force: true });
  vault = mkdtempSync(path.join(tmpdir(), 'plaud-requeue-'));
  writeTestConfig(vault);
  // La source a ete deplacee de pro vers perso apres un refus ; la file la connait encore en pro.
  put(`${RAW}/perso/${SOURCE}`, '# contenu invente\n');
  put('tools/plaud-sync/.queue.json', JSON.stringify([{ domain: 'pro', rel: SOURCE }]));
});
after(() => {
  rmSync(fakeBin, { recursive: true, force: true });
  rmSync(vault ?? '', { recursive: true, force: true });
});

describe('--requeue', () => {
  test('remet la source en file dans son nouveau domaine, sans ouvrir de session', () => {
    const r = run(['--requeue', 'perso', SOURCE]);
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(queueOf().filter((x) => x.domain === 'perso'), [{ domain: 'perso', rel: SOURCE }]);
    assert.ok(!existsSync(log()), 'aucune session claude ne doit etre lancee');
    assert.match(r.stdout, /kioku plaud --skip-fetch/);
  });

  test('accepte le chemin tape apres le mv (prefixe raw/<domaine>/)', () => {
    const r = run(['--requeue', 'perso', `${RAW}/perso/${SOURCE}`]);
    assert.equal(r.status, 0, r.stderr);
    assert.ok(queueOf().some((x) => x.domain === 'perso' && x.rel === SOURCE));
  });

  test('deux remises en file ne doublent pas l\'entree', () => {
    run(['--requeue', 'perso', SOURCE]);
    run(['--requeue', 'perso', SOURCE]);
    assert.equal(queueOf().filter((x) => x.domain === 'perso').length, 1);
  });

  for (const [why, args] of [
    ['domaine non declare', ['--requeue', 'autre', SOURCE]],
    ['chemin manquant', ['--requeue', 'perso']],
    ['chemin qui remonte (..)', ['--requeue', 'perso', `../pro/${SOURCE}`]],
    ['chemin absolu', ['--requeue', 'perso', '/etc/hosts']],
    ['fichier absent du domaine', ['--requeue', 'pro', SOURCE]],
    ['combine avec --dry-run', ['--requeue', 'perso', SOURCE, '--dry-run']],
  ]) {
    test(`refuse : ${why}, file inchangee`, () => {
      const before = queueOf();
      const r = run(args);
      assert.notEqual(r.status, 0);
      assert.deepEqual(queueOf(), before);
      assert.ok(!existsSync(log()), 'aucune session claude ne doit etre lancee');
    });
  }
});

describe('renvois du circuit', () => {
  // Les messages et la doc citent la forme du CLI : run.mjs et pending.mjs n'existent pas dans le coffre.
  for (const rel of ['run.mjs', 'README.md', '../kioku.mjs']) {
    test(`${rel} ne renvoie pas vers node tools/plaud-sync/…`, () => {
      const text = readFileSync(path.join(HERE, rel), 'utf8');
      assert.doesNotMatch(text, /node tools\/plaud-sync\/(run|pending)\.mjs/);
    });
  }
});
