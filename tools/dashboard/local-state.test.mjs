/**
 * Tests de lecture des etats locaux : U2
 * `node --test tools/dashboard/local-state.test.mjs`
 * Coffre factice dans un dossier temporaire, aucun fichier reel n'est lu.
 */

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { beforeEach, afterEach, describe, test } from 'node:test';

import { readLocalState } from './local-state.mjs';

let vault;
const put = (rel, text) => {
  const file = path.join(vault, rel);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, text);
};

beforeEach(() => {
  vault = mkdtempSync(path.join(tmpdir(), 'local-state-test-'));
});
afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
});

describe('U2 : Lecture des etats locaux de la machine', () => {
  test('couvre AE3 : aucun fichier d etat, tout est inconnu (jamais zero)', () => {
    const res = readLocalState(vault);

    assert.equal(res.scope, 'local');
    assert.equal(res.queue.status, 'unknown');
    assert.equal(res.queue.count, null);
    assert.equal(res.snapshot.status, 'unknown');
    assert.equal(res.lock.status, 'unknown');
    assert.equal(res.inboxArbitration.status, 'unknown');
  });

  test('fichier de file present avec liste vide : etat zero, pas inconnu', () => {
    put('tools/plaud-sync/.queue.json', '[]');

    const res = readLocalState(vault);

    assert.equal(res.queue.status, 'empty');
    assert.equal(res.queue.count, 0);
  });

  test('fichier de file present avec deux entrees : etat deux', () => {
    put('tools/plaud-sync/.queue.json', JSON.stringify([
      { file: 'meetings/note1.md', domain: 'pro' },
      { file: 'meetings/note2.md', domain: 'perso' }
    ]));

    const res = readLocalState(vault);

    assert.equal(res.queue.status, 'present');
    assert.equal(res.queue.count, 2);
  });

  test('fichier JSON illisible : etat corrupt nomme, pas d exception ni de zero silencieux', () => {
    put('tools/plaud-sync/.queue.json', '{ json invalide');

    const res = readLocalState(vault);

    assert.equal(res.queue.status, 'corrupt');
    assert.equal(res.queue.count, null);
    assert.ok(res.queue.error);
  });

  test('verrou detenu par un PID mort : rapporte comme stale', () => {
    put('tools/plaud-sync/.lock.json', JSON.stringify({ pid: 99999999, started: '2026-09-24T10:00:00.000Z' }));

    const res = readLocalState(vault);

    assert.equal(res.lock.status, 'stale');
    assert.equal(res.lock.pid, 99999999);
  });

  test('verrou detenu par un PID vivant : rapporte comme active', () => {
    put('tools/plaud-sync/.lock.json', JSON.stringify({ pid: process.pid, started: '2026-09-24T10:00:00.000Z' }));

    const res = readLocalState(vault);

    assert.equal(res.lock.status, 'active');
    assert.equal(res.lock.pid, process.pid);
  });

  test('files de Plaud et du mail : additionnees, detaillees par circuit ; le verrou dit circuit mail', () => {
    put('tools/plaud-sync/.queue.json', JSON.stringify([{ domain: 'pro', rel: 'a.md' }]));
    put('tools/mail-sync/.queue.json', JSON.stringify([{ domain: 'pro', rel: 'emails/b.md' }, { domain: 'pro', rel: 'pdfs/c.pdf.md' }]));
    put('tools/mail-sync/.snapshot.json', JSON.stringify({ pro: ['x.md'] }));
    const res = readLocalState(vault);
    assert.equal(res.queue.count, 3);
    assert.deepEqual(res.queue.byCircuit, { plaud: 1, mail: 2 });
    assert.equal(res.snapshot.status, 'present');
  });

  test('file du mail seule : vue (plus d etat inconnu parce que Plaud n a pas de file)', () => {
    put('tools/mail-sync/.queue.json', JSON.stringify([]));
    assert.equal(readLocalState(vault).queue.status, 'empty');
  });

  test('verrou commun du coffre (tools/connectors/) : lu en priorite, avec celui qui le tient', () => {
    put('tools/plaud-sync/.lock.json', JSON.stringify({ pid: 99999999, started: 'miroir' }));
    put('tools/connectors/.lock.json', JSON.stringify({ pid: process.pid, started: '2026-11-06T10:00:00.000Z', owner: 'circuit mail' }));

    const res = readLocalState(vault);

    assert.equal(res.lock.status, 'active');
    assert.equal(res.lock.owner, 'circuit mail');
  });

  test('inbox/a-trancher avec 3 fichiers : compte sans lire le contenu ni exposer les noms', () => {
    put('inbox/a-trancher/note-1.md', 'secret content');
    put('inbox/a-trancher/note-2.md', 'secret content 2');
    put('inbox/a-trancher/note-3.txt', 'autre fichier');

    const res = readLocalState(vault);

    assert.equal(res.inboxArbitration.status, 'present');
    assert.equal(res.inboxArbitration.count, 3);
    assert.equal(res.inboxArbitration.files, undefined);
  });

  test('silo pro/perso : filtrage des compteurs snapshot au domaine specifie', () => {
    put(
      'tools/plaud-sync/.snapshot.json',
      JSON.stringify({
        pro: ['meeting-1', 'meeting-2'],
        perso: ['perso-1'],
      })
    );

    const resPro = readLocalState(vault, 'pro');
    assert.equal(resPro.snapshot.status, 'present');
    assert.deepEqual(resPro.snapshot.counts, { pro: 2 });
    assert.equal(resPro.snapshot.counts.perso, undefined);

    const resPerso = readLocalState(vault, 'perso');
    assert.equal(resPerso.snapshot.status, 'present');
    assert.deepEqual(resPerso.snapshot.counts, { perso: 1 });
    assert.equal(resPerso.snapshot.counts.pro, undefined);
  });
});
