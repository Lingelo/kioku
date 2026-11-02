/**
 * Tests du verrou du lanceur : `node --test tools/plaud-sync/lock.test.mjs`
 * Coffre factice dans un dossier temporaire ; aucun processus reel n'est tue, aucun run.mjs n'est lance.
 */

import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { beforeEach, afterEach, describe, test } from 'node:test';
import { acquire, isAlive, lockPath, release } from './lock.mjs';

let vault;
// Un PID libre : on part tres haut et on descend jusqu'a en trouver un qui n'existe pas.
const deadPid = () => {
  for (let pid = 4_194_300; pid > 4_000_000; pid--) if (!isAlive(pid)) return pid;
  throw new Error('aucun PID libre trouve');
};

beforeEach(() => {
  vault = mkdtempSync(path.join(tmpdir(), 'plaud-lock-'));
  mkdirSync(path.join(vault, 'tools', 'plaud-sync'), { recursive: true });
});
afterEach(() => rmSync(vault, { recursive: true, force: true }));

describe('isAlive', () => {
  test('le processus courant est vivant', () => assert.equal(isAlive(process.pid), true));
  test('un PID inexistant ne l\'est pas', () => assert.equal(isAlive(deadPid()), false));
  test('un PID invalide ne l\'est pas', () => {
    for (const pid of [0, -1, 1.5, NaN, undefined, null, 'abc']) assert.equal(isAlive(pid), false);
  });
});

describe('prise et liberation', () => {
  test('un coffre libre donne le verrou, avec le PID et l\'heure', () => {
    const r = acquire(vault, { pid: 4242, now: () => '2026-09-22T10:00:00.000Z' });
    assert.equal(r.ok, true);
    assert.equal(r.stale, null);
    assert.deepEqual(JSON.parse(readFileSync(lockPath(vault), 'utf8')), { pid: 4242, started: '2026-09-22T10:00:00.000Z' });
  });

  test('le dossier d\'etat est cree s\'il manque (coffre neuf, --vault)', () => {
    const neuf = mkdtempSync(path.join(tmpdir(), 'plaud-lock-neuf-'));
    try {
      assert.equal(acquire(neuf, { pid: 1 }).ok, true);
      assert.equal(existsSync(lockPath(neuf)), true);
    } finally {
      rmSync(neuf, { recursive: true, force: true });
    }
  });

  test('rendre le verrou le supprime ; le coffre redevient libre', () => {
    acquire(vault, { pid: process.pid });
    release(vault, process.pid);
    assert.equal(existsSync(lockPath(vault)), false);
    assert.equal(acquire(vault, { pid: process.pid }).ok, true);
  });

  test('rendre un verrou qui n\'est pas le notre ne le supprime pas', () => {
    acquire(vault, { pid: process.pid });
    release(vault, 4242); // un autre lanceur croit liberer
    assert.equal(existsSync(lockPath(vault)), true);
    assert.equal(JSON.parse(readFileSync(lockPath(vault), 'utf8')).pid, process.pid);
  });

  test('rendre un verrou absent ne leve pas', () => assert.doesNotThrow(() => release(vault, process.pid)));
});

describe('le cas du 22/09 : un second lancement pendant une ingestion', () => {
  test('verrou tenu par un processus VIVANT : le second est refuse, avec le PID a tuer', () => {
    acquire(vault, { pid: process.pid, now: () => '2026-09-22T11:24:00.000Z' });
    const second = acquire(vault, { pid: 4242 });
    assert.equal(second.ok, false);
    assert.equal(second.held.pid, process.pid);
    assert.equal(second.held.started, '2026-09-22T11:24:00.000Z'); // le message dit depuis quand
  });

  test('le verrou du premier survit au refus du second', () => {
    acquire(vault, { pid: process.pid });
    acquire(vault, { pid: 4242 });
    assert.equal(JSON.parse(readFileSync(lockPath(vault), 'utf8')).pid, process.pid);
  });
});

describe('verrou perime : rien a supprimer a la main', () => {
  test('processus mort (run tue par kill) : le verrou est repris et signale', () => {
    const mort = deadPid();
    writeFileSync(lockPath(vault), JSON.stringify({ pid: mort, started: '2026-09-22T11:24:00.000Z' }));
    const r = acquire(vault, { pid: 4242 });
    assert.equal(r.ok, true);
    assert.equal(r.stale.pid, mort); // le lanceur l'affiche
    assert.equal(JSON.parse(readFileSync(lockPath(vault), 'utf8')).pid, 4242);
  });

  test('verrou tronque par un arret brutal : repris comme perime', () => {
    writeFileSync(lockPath(vault), '{"pid": 42');
    const r = acquire(vault, { pid: 4242 });
    assert.equal(r.ok, true);
    assert.equal(r.stale, null); // illisible : aucun PID a nommer
  });

  test('verrou sans PID exploitable : repris comme perime', () => {
    writeFileSync(lockPath(vault), JSON.stringify({ started: '2026-09-22T11:24:00.000Z' }));
    assert.equal(acquire(vault, { pid: 4242 }).ok, true);
  });

  test('notre propre PID deja au verrou (relance apres crash, meme PID) : repris', () => {
    writeFileSync(lockPath(vault), JSON.stringify({ pid: process.pid, started: 'vieux' }));
    const r = acquire(vault, { pid: process.pid, now: () => 'neuf' });
    assert.equal(r.ok, true);
    assert.equal(JSON.parse(readFileSync(lockPath(vault), 'utf8')).started, 'neuf');
  });
});

describe('deux coffres', () => {
  test('un verrou ne bloque pas l\'autre coffre', () => {
    const autre = mkdtempSync(path.join(tmpdir(), 'plaud-lock-autre-'));
    try {
      mkdirSync(path.join(autre, 'tools', 'plaud-sync'), { recursive: true });
      acquire(vault, { pid: process.pid });
      assert.equal(acquire(autre, { pid: 4242 }).ok, true);
    } finally {
      rmSync(autre, { recursive: true, force: true });
    }
  });
});
