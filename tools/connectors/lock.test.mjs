/**
 * Tests du verrou commun du coffre : `node --test tools/connectors/lock.test.mjs`
 * Ce qui est neuf par rapport a tools/plaud-sync/lock.test.mjs : le chemin canonique, le miroir de transition, et le
 * fait que n'importe quel lanceur (rotate-log, upgrade, un second connecteur) bute sur le meme verrou.
 * Coffre factice dans un dossier temporaire ; aucun processus reel n'est tue.
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { acquire, isAlive, legacyLockPath, lockPath, readLock, release } from './lock.mjs';

const LOCK = pathToFileURL(new URL('./lock.mjs', import.meta.url).pathname).href;

let vault;
const deadPid = () => {
  for (let pid = 4_194_300; pid > 4_000_000; pid--) if (!isAlive(pid)) return pid;
  throw new Error('aucun PID libre trouve');
};
const put = (file, value) => {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value));
};

beforeEach(() => {
  vault = mkdtempSync(path.join(tmpdir(), 'connectors-lock-'));
});
afterEach(() => rmSync(vault, { recursive: true, force: true }));

describe('chemins', () => {
  test('canonique sous tools/connectors/, ancien sous tools/plaud-sync/', () => {
    assert.equal(path.relative(vault, lockPath(vault)), path.join('tools', 'connectors', '.lock.json'));
    assert.equal(path.relative(vault, legacyLockPath(vault)), path.join('tools', 'plaud-sync', '.lock.json'));
  });
});

describe('prise : les deux fichiers, meme contenu', () => {
  test('coffre neuf : les deux dossiers sont crees, les deux fichiers portent le meme PID et la meme heure', () => {
    const r = acquire(vault, { pid: 4242, now: () => '2026-11-05T10:00:00.000Z' });
    assert.deepEqual(r, { ok: true, stale: null });
    const want = { pid: 4242, started: '2026-11-05T10:00:00.000Z' };
    assert.deepEqual(JSON.parse(readFileSync(lockPath(vault), 'utf8')), want);
    assert.deepEqual(JSON.parse(readFileSync(legacyLockPath(vault), 'utf8')), want);
  });

  test('rendre supprime les deux ; le coffre redevient libre', () => {
    acquire(vault, { pid: process.pid });
    release(vault, process.pid);
    assert.equal(existsSync(lockPath(vault)), false);
    assert.equal(existsSync(legacyLockPath(vault)), false);
    assert.equal(acquire(vault, { pid: process.pid }).ok, true);
  });

  test('rendre ne supprime que ce qui est a nous, fichier par fichier', () => {
    put(legacyLockPath(vault), { pid: 777, started: 'autre' });
    put(lockPath(vault), { pid: process.pid, started: 'moi' });
    release(vault, process.pid);
    assert.equal(existsSync(lockPath(vault)), false);
    assert.equal(readLock(legacyLockPath(vault)).pid, 777);
  });
});

describe('transition : un ancien processus ne connait que tools/plaud-sync/.lock.json', () => {
  test('ancien fichier tenu par un vivant : refus, et le verrou canonique pris au premier tour est rendu', () => {
    put(legacyLockPath(vault), { pid: process.pid, started: '2026-11-05T09:00:00.000Z' });
    const r = acquire(vault, { pid: 4242 });
    assert.equal(r.ok, false);
    assert.equal(r.held.pid, process.pid);
    assert.equal(r.held.started, '2026-11-05T09:00:00.000Z');
    assert.equal(existsSync(lockPath(vault)), false, 'un refus ne laisse pas de moitie de verrou');
    assert.equal(readLock(legacyLockPath(vault)).pid, process.pid, 'le verrou de l ancien processus reste');
  });

  test('un nouveau lanceur tient l ancien fichier aussi : un ancien processus (prise wx sur ce seul fichier) echoue', () => {
    acquire(vault, { pid: process.pid });
    assert.throws(() => writeFileSync(legacyLockPath(vault), '{}', { flag: 'wx' }), { code: 'EEXIST' });
  });

  test('ancien fichier perime (processus mort) : repris, et signale', () => {
    const mort = deadPid();
    put(legacyLockPath(vault), { pid: mort, started: 'vieux' });
    const r = acquire(vault, { pid: 4242 });
    assert.equal(r.ok, true);
    assert.equal(r.stale.pid, mort);
    assert.equal(readLock(legacyLockPath(vault)).pid, 4242);
  });
});

describe('verrou canonique', () => {
  test('tenu par un vivant : refus, l ancien fichier n est pas touche', () => {
    put(lockPath(vault), { pid: process.pid, started: 'x' });
    const r = acquire(vault, { pid: 4242 });
    assert.equal(r.ok, false);
    assert.equal(r.held.pid, process.pid);
    assert.equal(existsSync(legacyLockPath(vault)), false);
  });

  test('perime (processus mort), tronque ou sans PID : repris', () => {
    for (const content of [{ pid: deadPid(), started: 'x' }, '{"pid": 4', { started: 'x' }, '']) {
      put(lockPath(vault), content);
      const r = acquire(vault, { pid: 4242 });
      assert.equal(r.ok, true, JSON.stringify(content));
      release(vault, 4242);
    }
  });

  test('le perime du canonique est signale en priorite', () => {
    const a = deadPid();
    put(lockPath(vault), { pid: a, started: 'x' });
    assert.equal(acquire(vault, { pid: 4242 }).stale.pid, a);
  });
});

describe('un verrou pour tous les lanceurs', () => {
  test('deux lanceurs differents (circuit Plaud, puis un second connecteur ou rotate-log) : le second est refuse', () => {
    assert.equal(acquire(vault, { pid: process.pid }).ok, true);
    const second = acquire(vault, { pid: 4242 });
    assert.equal(second.ok, false);
    assert.equal(second.held.pid, process.pid);
  });

  test('deux coffres ne se bloquent pas', () => {
    const autre = mkdtempSync(path.join(tmpdir(), 'connectors-lock-autre-'));
    try {
      acquire(vault, { pid: process.pid });
      assert.equal(acquire(autre, { pid: 4242 }).ok, true);
    } finally {
      rmSync(autre, { recursive: true, force: true });
    }
  });
});

describe('erreurs disque', () => {
  test('miroir impossible a ecrire : erreur levee, le verrou canonique est rendu', { skip: process.platform === 'win32' || process.getuid?.() === 0 }, () => {
    const legacy = path.dirname(legacyLockPath(vault));
    mkdirSync(legacy, { recursive: true });
    chmodSync(legacy, 0o500); // lecture seule : la creation du fichier echoue (EACCES)
    try {
      assert.throws(() => acquire(vault, { pid: 4242 }), { code: 'EACCES' });
      assert.equal(existsSync(lockPath(vault)), false);
    } finally {
      chmodSync(legacy, 0o700);
    }
  });
});

// Les trois proprietes du verrou a deux fichiers, avec de VRAIS processus : un enfant prend tout ou partie du verrou,
// puis se tue par SIGKILL (aucun gestionnaire 'exit' ne tourne, comme un kill -9 ou une coupure). spawnSync attend sa
// fin : quand il rend la main, le PID de l'enfant est mort.
describe('verrou a deux fichiers : echec, arret brutal, liberation', { skip: process.platform === 'win32' }, () => {
  /** Lance un enfant qui execute `body` (lock.mjs importe sous `L`), puis se tue ; rend son PID. */
  const killedChild = (body) => {
    const code = `const L = await import(${JSON.stringify(LOCK)}); const vault = ${JSON.stringify(vault)};\n${body}\nprocess.kill(process.pid, 'SIGKILL');`;
    const r = spawnSync(process.execPath, ['--input-type=module', '-e', code], { encoding: 'utf8' });
    assert.equal(r.signal, 'SIGKILL', r.stderr);
    assert.equal(isAlive(r.pid), false);
    return r.pid;
  };

  test('(a) echec a prendre le second fichier : le premier est rendu, rien ne reste a nous', () => {
    put(legacyLockPath(vault), { pid: process.pid, started: 'ancien run.mjs' });
    const r = acquire(vault, { pid: 4242 });
    assert.equal(r.ok, false);
    assert.equal(existsSync(lockPath(vault)), false);
    // Et le lanceur suivant, une fois l'ancien parti, passe sans rien nettoyer.
    rmSync(legacyLockPath(vault));
    assert.equal(acquire(vault, { pid: 4243 }).ok, true);
  });

  test('(b) tue ENTRE les deux ecritures (canonique ecrit, miroir absent) : le lancement suivant reprend, rien ne bloque', () => {
    const pid = killedChild(`L.acquireFile(L.lockPath(vault), JSON.stringify({ pid: process.pid, started: 'x' }), process.pid);`);
    assert.equal(readLock(lockPath(vault)).pid, pid, 'le canonique orphelin est bien la');
    assert.equal(existsSync(legacyLockPath(vault)), false, 'le miroir n a pas ete ecrit');
    const r = acquire(vault, { pid: 4242 });
    assert.equal(r.ok, true);
    assert.equal(r.stale.pid, pid, 'la reprise est signalee avec le PID mort');
    assert.equal(readLock(lockPath(vault)).pid, 4242);
    assert.equal(readLock(legacyLockPath(vault)).pid, 4242);
  });

  test('(b) tue APRES les deux ecritures : les deux orphelins sont repris', () => {
    const pid = killedChild(`if (!L.acquire(vault).ok) process.exit(3);`);
    assert.equal(readLock(lockPath(vault)).pid, pid);
    assert.equal(readLock(legacyLockPath(vault)).pid, pid);
    const r = acquire(vault, { pid: 4242 });
    assert.equal(r.ok, true);
    assert.equal(r.stale.pid, pid);
    assert.equal(readLock(legacyLockPath(vault)).pid, 4242);
  });

  test('(b) miroir orphelin seul (canonique deja rendu, tue pendant release) : repris aussi', () => {
    const pid = killedChild(`L.acquire(vault); L.releaseFile(L.lockPath(vault), process.pid);`);
    assert.equal(existsSync(lockPath(vault)), false);
    assert.equal(readLock(legacyLockPath(vault)).pid, pid);
    const r = acquire(vault, { pid: 4242 });
    assert.equal(r.ok, true);
    assert.equal(r.stale.pid, pid);
  });

  test('(c) liberation : les deux fichiers retires', () => {
    assert.equal(acquire(vault, { pid: 4242 }).ok, true);
    release(vault, 4242);
    assert.equal(existsSync(lockPath(vault)), false);
    assert.equal(existsSync(legacyLockPath(vault)), false);
  });
});
