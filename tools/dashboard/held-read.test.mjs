/**
 * Tests de lecture de la quarantaine et de la gate : U3
 * `node --test tools/dashboard/held-read.test.mjs`
 * Coffre factice dans un dossier temporaire, aucun fichier reel n'est lu.
 */

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { beforeEach, afterEach, describe, test } from 'node:test';

import { readHeldAndCandidates, computeCandidateHash } from './held-read.mjs';

let vault;
const put = (rel, text) => {
  const file = path.join(vault, rel);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, text);
};

beforeEach(() => {
  vault = mkdtempSync(path.join(tmpdir(), 'held-read-test-'));
});
afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
});

describe('U3 : Lecture de la quarantaine et de la gate', () => {
  test('quarantaine et candidates vides : listes vides, zero element', () => {
    const res = readHeldAndCandidates(vault, 'pro');

    assert.equal(res.quarantine.length, 0);
    assert.equal(res.candidates.length, 0);
    assert.equal(res.totalPendingCount, 0);
  });

  test('entrees de quarantaine : page retenue et pointeur de source, sans texte copie', () => {
    put(
      'quarantine/pro/people-alice.json',
      JSON.stringify({
        code: 'jugement-personne',
        note: 'Portrait a verifier',
        target: 'wiki/pro/people/alice.md',
        at: '2026-09-24',
        hash: 'abc12345',
      })
    );
    put('quarantine/pro/people-alice.md', 'CONTENU SENSIBLE A NE PAS RECOPIER DANS LE DASHBOARD');

    put(
      'quarantine/pro/source-audio.json',
      JSON.stringify({
        code: 'insulte',
        raw: 'raw/pro/meetings/2026-09-24-meeting.mp3',
        at: '2026-09-24',
        pointeur: true,
      })
    );

    const res = readHeldAndCandidates(vault, 'pro');

    assert.equal(res.quarantine.length, 2);

    const qPage = res.quarantine.find((q) => q.id === 'people-alice');
    assert.ok(qPage);
    assert.equal(qPage.code, 'jugement-personne');
    assert.equal(qPage.target, 'wiki/pro/people/alice.md');
    assert.equal(qPage.type, 'held_page');
    assert.equal(qPage.command, 'kioku decide pro people-alice drop');
    // Le texte de la page retenue ne doit pas etre recopié
    assert.equal(qPage.body, undefined);

    const qSource = res.quarantine.find((q) => q.id === 'source-audio');
    assert.ok(qSource);
    assert.equal(qSource.code, 'insulte');
    assert.equal(qSource.type, 'held_source');
    assert.equal(qSource.command, 'kioku decide pro source-audio drop');
  });

  test('candidate avec verdict ok : prete pour promote', () => {
    const content = '---\ntitle: Bob\ntype: person\n---\nBob est dev.\n';
    put('.candidats/wiki/pro/people/bob.md', content);

    const hash = computeCandidateHash(vault, 'pro', 'people', 'bob', content);
    put(
      `.verdicts/${hash}.json`,
      JSON.stringify({ verdict: 'ok', file: '.candidats/wiki/pro/people/bob.md', at: '2026-09-24' })
    );

    const res = readHeldAndCandidates(vault, 'pro');

    assert.equal(res.candidates.length, 1);
    const c = res.candidates[0];
    assert.equal(c.slug, 'bob');
    assert.equal(c.folder, 'people');
    assert.equal(c.status, 'ready_to_promote');
    assert.equal(c.verdict, 'ok');
    assert.equal(c.command, 'kioku promote .candidats/wiki/pro/people/bob.md');
  });

  test('candidate avec verdict hold : retenue par relecteur', () => {
    const content = '---\ntitle: Charlie\ntype: person\n---\nTexte litigieux.\n';
    put('.candidats/wiki/pro/people/charlie.md', content);

    const hash = computeCandidateHash(vault, 'pro', 'people', 'charlie', content);
    put(
      `.verdicts/${hash}.json`,
      JSON.stringify({ verdict: 'hold', code: 'diffamation', file: '.candidats/wiki/pro/people/charlie.md' })
    );

    const res = readHeldAndCandidates(vault, 'pro');

    assert.equal(res.candidates.length, 1);
    const c = res.candidates[0];
    assert.equal(c.status, 'held_by_reviewer');
    assert.equal(c.verdict, 'hold');
  });

  test('candidate sans verdict : en attente de relecture', () => {
    put('.candidats/wiki/pro/concepts/api.md', '---\ntitle: API\ntype: concept\n---\nDefinition.\n');

    const res = readHeldAndCandidates(vault, 'pro');

    assert.equal(res.candidates.length, 1);
    const c = res.candidates[0];
    assert.equal(c.status, 'awaiting_verdict');
    assert.equal(c.verdict, 'none');
    assert.equal(c.command, 'kioku check .candidats/wiki/pro/concepts/api.md');
  });

  test('l empreinte est insensible aux fins de ligne Windows \\r\\n', () => {
    const contentUnix = '---\ntitle: Diana\ntype: person\n---\nTexte.\n';
    const contentWindows = '---\r\ntitle: Diana\r\ntype: person\r\n---\r\nTexte.\r\n';

    const hash1 = computeCandidateHash(vault, 'pro', 'people', 'diana', contentUnix);
    const hash2 = computeCandidateHash(vault, 'pro', 'people', 'diana', contentWindows);

    assert.equal(hash1, hash2);
  });

  test('candidate source : l empreinte integre la fiche argent', () => {
    const sourceContent = '---\ntitle: Source 1\ntype: source\n---\nResume source.\n';
    const silverContent = '---\nraw: meetings/1.md\n---\nArgent.\n';

    put('silver/pro/source-1.md', silverContent);

    const hashWithSilver = computeCandidateHash(vault, 'pro', 'sources', 'source-1', sourceContent);

    // Comparaison avec hash direct
    const rawExpected = `${sourceContent}\u0000${silverContent}`;
    const expectedHash = createHash('sha256').update(rawExpected).digest('hex');

    assert.equal(hashWithSilver, expectedHash);
  });
});
