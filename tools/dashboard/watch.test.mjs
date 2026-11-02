/**
 * tools/dashboard/watch.test.mjs
 *
 * Tests unitaires de la surveillance native du coffre (watch.mjs, U3).
 * `node --test tools/dashboard/watch.test.mjs`
 */

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';

import { createWatcher as createWatcherRaw } from './watch.mjs';
import { writeTestConfig } from '../test-vault.mjs';

let vault;
// Chaque watcher ouvert par un test est ferme dans afterEach, meme si une assertion a echoue avant sa derniere ligne.
const opened = [];
const createWatcher = (...args) => {
  const w = createWatcherRaw(...args);
  opened.push(w);
  return w;
};
const put = (rel, text = 'contenu') => {
  const file = path.join(vault, rel);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, text);
};

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

beforeEach(() => {
  vault = mkdtempSync(path.join(tmpdir(), 'watch-test-'));
  writeTestConfig(vault);
  // Creer la structure minimale du domaine pro pour initialiser les watchers
  mkdirSync(path.join(vault, 'wiki', 'pro'), { recursive: true });
  mkdirSync(path.join(vault, 'wiki', 'perso'), { recursive: true });
  mkdirSync(path.join(vault, '.candidats', 'wiki', 'pro'), { recursive: true });
  mkdirSync(path.join(vault, 'tools', 'plaud-sync'), { recursive: true });
  mkdirSync(path.join(vault, '.verdicts'), { recursive: true });
});

afterEach(() => {
  while (opened.length) opened.pop().close();
  rmSync(vault, { recursive: true, force: true });
});

describe('U3 : Surveillance native du coffre (watch.mjs)', () => {
  test('couvre AE3 : dix ecritures rapides dans wiki/pro/ declenchent un seul rappel regroupe', async () => {
    let callCount = 0;
    const watcher = createWatcher(vault, 'pro', {
      debounceMs: 60,
      heartbeatMs: 0,
      onChanged: () => {
        callCount++;
      },
    });

    await watcher.ready;
    // Stabilisation apres demarrage
    await delay(100);
    callCount = 0;

    // 10 ecritures rapides
    for (let i = 0; i < 10; i++) {
      put(`wiki/pro/page-${i}.md`, `Page ${i}`);
    }

    // Attendre le debounce
    await delay(180);
    assert.equal(callCount, 1, 'Dix ecritures rapides doivent etre regroupees en 1 seul rappel');

    watcher.close();
  });

  test('silo strict : ecriture dans wiki/perso/ ne declenche aucun rappel sous surveillance pro', async () => {
    let callCount = 0;
    const watcher = createWatcher(vault, 'pro', {
      debounceMs: 50,
      heartbeatMs: 0,
      onChanged: () => {
        callCount++;
      },
    });

    await watcher.ready;
    await delay(80);
    callCount = 0;

    // Ecriture dans le domaine perso
    put('wiki/perso/secret.md', 'Secret perso');

    await delay(120);
    assert.equal(callCount, 0, 'Une ecriture perso ne doit declencher aucun rappel pro');

    watcher.close();
  });

  test('journal du domaine : une entree dans wiki/pro/log.md ne declenche aucun rappel, index.md si', async () => {
    put('wiki/pro/log.md', '# Journal\n');
    put('wiki/pro/index.md', '# Index\n');
    let callCount = 0;
    const watcher = createWatcher(vault, 'pro', {
      debounceMs: 50,
      heartbeatMs: 0,
      onChanged: () => {
        callCount++;
      },
    });

    await watcher.ready;
    await delay(80);
    callCount = 0;

    put('wiki/pro/log.md', '# Journal\n## [2026-10-03 10:00] query | "x"\n');
    await delay(150);
    assert.equal(callCount, 0, 'le journal n est pas affiche : pas de bandeau');

    // Sous charge, macOS peut livrer en retard l'evenement des fichiers poses avant le demarrage : on repart de zero
    // juste avant l'ecriture qui compte, et on attend son rappel au lieu d'un delai fixe.
    callCount = 0;
    put('wiki/pro/index.md', '# Index\n- [[projects/atlas]] — x\n');
    for (let i = 0; i < 100 && callCount === 0; i++) await delay(20);
    assert.ok(callCount >= 1, 'l index nourrit les anomalies : bandeau');

    watcher.close();
  });

  test('archives du journal (wiki/pro/log/<mois>.md, rotate-log) : aucun rappel', async () => {
    put('wiki/pro/log.md', '# Journal\n');
    let callCount = 0;
    const watcher = createWatcher(vault, 'pro', {
      debounceMs: 50,
      heartbeatMs: 0,
      onChanged: () => {
        callCount++;
      },
    });

    await watcher.ready;
    await delay(80);
    callCount = 0;

    put('wiki/pro/log/2026-09.md.tmp', '---\ntype: log\n---\n');
    put('wiki/pro/log/2026-09.md', '---\ntype: log\n---\n');
    put('wiki/pro/log.md.tmp', '# Journal\n');
    await delay(150);
    assert.equal(callCount, 0, 'une rotation du journal ne change pas la page : pas de bandeau');

    watcher.close();
  });

  test('sous-dossier cree apres le demarrage puis ecrit declenche un rappel', async () => {
    let callCount = 0;
    const watcher = createWatcher(vault, 'pro', {
      debounceMs: 50,
      heartbeatMs: 0,
      onChanged: () => {
        callCount++;
      },
    });

    await watcher.ready;
    await delay(80);
    callCount = 0;

    // Creation d'un sous-dossier et d'un fichier dedans
    put('.candidats/wiki/pro/people/nouveau.md', 'Nouveau candidat');

    await delay(150);
    assert.ok(callCount >= 1, 'L ecriture dans un sous-dossier candidat doit declencher un rappel');

    watcher.close();
  });

  test('fichiers d etat plaud-sync : .lock.json cree puis supprime declenche les rappels', async () => {
    let callCount = 0;
    const watcher = createWatcher(vault, 'pro', {
      debounceMs: 50,
      heartbeatMs: 0,
      onChanged: () => {
        callCount++;
      },
    });

    await watcher.ready;
    await delay(80);
    callCount = 0;

    // 1. Creation du lock
    put('tools/plaud-sync/.lock.json', JSON.stringify({ pid: 123 }));
    await delay(120);
    assert.equal(callCount, 1, 'Creation de .lock.json doit declencher 1 rappel');

    // 2. Suppression du lock
    unlinkSync(path.join(vault, 'tools', 'plaud-sync', '.lock.json'));
    await delay(120);
    assert.equal(callCount, 2, 'Suppression de .lock.json doit declencher un second rappel');

    // 3. Fichier ignore dans tools/plaud-sync (autre que queue, snapshot, lock)
    put('tools/plaud-sync/autre-fichier.txt', 'Ignoré');
    await delay(120);
    assert.equal(callCount, 2, 'Un fichier non surveille dans plaud-sync ne declenche rien');

    watcher.close();
  });

  test('.verdicts/ : ne declenche que pour les empreintes des candidates pro', async () => {
    let callCount = 0;
    const proCandidateHashes = new Set(['hash-pro-valide', 'hash-autre']);

    const watcher = createWatcher(vault, 'pro', {
      debounceMs: 50,
      heartbeatMs: 0,
      getCandidateHashes: () => proCandidateHashes,
      onChanged: () => {
        callCount++;
      },
    });

    await watcher.ready;
    await delay(80);
    callCount = 0;

    // 1. Verdict pour une candidate inconnue ou d un autre domaine
    put('.verdicts/hash-inconnu.json', JSON.stringify({ verdict: 'ok' }));
    await delay(120);
    assert.equal(callCount, 0, 'Un verdict non candidat ne declenche rien');

    // 2. Verdict pour une candidate pro connue
    put('.verdicts/hash-pro-valide.json', JSON.stringify({ verdict: 'ok' }));
    await delay(120);
    assert.equal(callCount, 1, 'Un verdict correspondant a une candidate pro declenche 1 rappel');

    watcher.close();
  });

  test('dossier quarantine/pro absent au depart : arme au battement periodique et declenche', async () => {
    let callCount = 0;
    // Note : quarantine/pro n'a pas ete cree dans beforeEach
    const watcher = createWatcher(vault, 'pro', {
      debounceMs: 40,
      heartbeatMs: 80, // Intervalle court pour le test
      onChanged: () => {
        callCount++;
      },
    });

    await watcher.ready;
    await delay(60);
    callCount = 0;

    // Creation du dossier de quarantaine
    put('quarantine/pro/note.json', JSON.stringify({ at: '2026-09-30' }));

    // Attendre le battement + debounce
    await delay(200);
    assert.ok(callCount >= 1, 'L apparition et l ecriture dans quarantine/pro doit declencher un rappel');

    watcher.close();
  });

  test('arret du watcher : close() empeche tout rappel ulterieur', async () => {
    let callCount = 0;
    const watcher = createWatcher(vault, 'pro', {
      debounceMs: 40,
      heartbeatMs: 0,
      onChanged: () => {
        callCount++;
      },
    });

    await watcher.ready;
    watcher.close();

    put('wiki/pro/nouvelle.md', 'Apres arret');
    await delay(100);
    assert.equal(callCount, 0, 'Aucun rappel ne doit etre emis apres close()');
  });
});
