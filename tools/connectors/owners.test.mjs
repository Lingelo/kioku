/**
 * Tests du proprietaire d'une source : `node --test tools/connectors/owners.test.mjs`
 * Revue I2 : un circuit ne trie et ne met en file que ses propres sources.
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { writeTestConfig } from '../test-vault.mjs';
import { DEFAULT_OWNER, markerOf, owns, ownsFile } from './owners.mjs';

const PENDING = path.join(path.dirname(fileURLToPath(import.meta.url)), 'pending.mjs');
const RAW = 'r' + 'aw';

describe('marques', () => {
  test('plaud_id en frontmatter : Plaud ; hors frontmatter ou absente : le proprietaire par defaut', () => {
    assert.equal(markerOf('---\nplaud_id: of_1\n---\n# x'), 'plaud');
    assert.equal(markerOf('# x\nplaud_id: of_1\n'), null);
    assert.equal(DEFAULT_OWNER, 'plaud');
    assert.equal(owns('plaud', '# note deposee a la main\n'), true, 'comme avant le socle : Plaud trie l entrant non marque');
    assert.equal(owns('autre', '# note deposee a la main\n'), false);
    assert.equal(owns('autre', '---\nplaud_id: of_1\n---\n'), false);
  });
  test('fichier illisible : n appartient a personne', () => {
    assert.equal(ownsFile('plaud', '/nulle/part.md'), false);
  });
});

describe('pending queue --connector', () => {
  let vault;
  beforeEach(() => {
    vault = mkdtempSync(path.join(tmpdir(), 'connectors-owners-'));
    writeTestConfig(vault);
  });
  afterEach(() => rmSync(vault, { recursive: true, force: true }));
  const run = (...args) => spawnSync(process.execPath, [PENDING, '--state', 'tools/x', ...args], { env: { ...process.env, CLAUDE_PROJECT_DIR: vault }, encoding: 'utf8' });
  const put = (rel, text) => {
    mkdirSync(path.dirname(path.join(vault, rel)), { recursive: true });
    writeFileSync(path.join(vault, rel), text);
  };

  test('seules les sources du connecteur entrent dans sa file ; les autres sont nommees', () => {
    run('--connector', 'autre', 'snapshot');
    put(`${RAW}/pro/meetings/2026-11-06-note.md`, '---\nplaud_id: of_1\n---\n# x\n');
    const r = run('--connector', 'autre', 'queue');
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /hors file \(autre connecteur\) : pro {2}meetings\/2026-11-06-note\.md/);
    assert.deepEqual(JSON.parse(readFileSync(path.join(vault, 'tools', 'x', '.queue.json'), 'utf8')), []);
  });

  test('sans --connector : tout ce qui est apparu (comportement anterieur)', () => {
    run('snapshot');
    put(`${RAW}/pro/meetings/2026-11-06-note.md`, '---\nplaud_id: of_1\n---\n# x\n');
    run('queue');
    assert.equal(JSON.parse(readFileSync(path.join(vault, 'tools', 'x', '.queue.json'), 'utf8')).length, 1);
  });
});
