/**
 * Tests de la file commune : `node --test tools/connectors/pending.test.mjs`
 * Le fond (etats neuf / argent / candidats) est couvert par tools/plaud-sync/pending.test.mjs, qui passe par le point
 * d'entree Plaud. Ici : ce que le socle ajoute, le dossier d'etat passe par --state, et son controle.
 * Coffre factice, contenus inventes.
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { writeTestConfig } from '../test-vault.mjs';
import { isMain, validState } from './pending.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PENDING = path.join(HERE, 'pending.mjs');
const RAW = 'r' + 'aw';
let vault;
const put = (rel, text) => {
  const file = path.join(vault, rel);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, text);
};
const run = (...args) => spawnSync(process.execPath, [PENDING, ...args], { env: { ...process.env, CLAUDE_PROJECT_DIR: vault }, encoding: 'utf8' });

beforeEach(() => {
  vault = mkdtempSync(path.join(tmpdir(), 'connectors-pending-'));
  writeTestConfig(vault);
});
afterEach(() => rmSync(vault, { recursive: true, force: true }));

describe('validState', () => {
  test('un dossier relatif au coffre est admis', () => {
    for (const s of ['tools/plaud-sync', 'tools/mail', 'etat']) assert.equal(validState(s), true, s);
  });
  test('absolu, remontee, vide ou segment vide : refuse', () => {
    for (const s of ['/tmp/x', '../x', 'tools/../..', 'tools\\..\\x', '', 'tools//x', undefined, null, 3]) assert.equal(validState(s), false, String(s));
  });
});

describe('--state', () => {
  test('sans --state : refus, code 1, rien n est ecrit', () => {
    const r = run('snapshot');
    assert.equal(r.status, 1);
    assert.match(r.stderr, /--state attend un dossier relatif au coffre/);
    assert.equal(existsSync(path.join(vault, 'tools')), false);
  });

  test('--state avec remontee : refus, rien n est ecrit hors du coffre', () => {
    const r = run('--state', '../hors', 'snapshot');
    assert.equal(r.status, 1);
    assert.equal(existsSync(path.join(path.dirname(vault), 'hors')), false);
  });

  test('l etat va dans le dossier donne : deux connecteurs, deux files distinctes', () => {
    run('--state', 'tools/a', 'snapshot');
    put(`${RAW}/pro/emails/2026-11-05-fil.md`, '# invente\n');
    assert.equal(run('--state', 'tools/a', 'queue').status, 0);
    assert.deepEqual(JSON.parse(readFileSync(path.join(vault, 'tools', 'a', '.queue.json'), 'utf8')), [{ domain: 'pro', rel: 'emails/2026-11-05-fil.md' }]);
    assert.equal(existsSync(path.join(vault, 'tools', 'b', '.queue.json')), false);
    assert.equal(run('--state', 'tools/b', 'list').stdout, '');
    assert.equal(run('--state', 'tools/a', 'list').stdout, 'pro\temails/2026-11-05-fil.md\tneuf\n');
  });

  test('--state peut suivre la commande', () => {
    put(`${RAW}/perso/x.md`, '# invente\n');
    assert.equal(run('add', 'perso', 'x.md', '--state', 'tools/a').status, 0);
    assert.equal(run('list', '--state', 'tools/a').stdout, 'perso\tx.md\tneuf\n');
  });

  test('commande inconnue : usage, code 1', () => {
    const r = run('--state', 'tools/a', 'quoi');
    assert.equal(r.status, 1);
    assert.match(r.stderr, /usage : pending\.mjs --state/);
  });

  test('configuration absente : code 1, rien n est ecrit', () => {
    rmSync(path.join(vault, 'kioku.config.json'));
    assert.equal(run('--state', 'tools/a', 'snapshot').status, 1);
    assert.equal(existsSync(path.join(vault, 'tools', 'a')), false);
  });
});

describe('isMain', () => {
  test('un import n est pas le script lance ; un chemin absent non plus', () => {
    assert.equal(isMain(new URL('./pending.mjs', import.meta.url).href, fileURLToPath(import.meta.url)), false);
    assert.equal(isMain(new URL('./pending.mjs', import.meta.url).href, '/nulle/part.mjs'), false);
    assert.equal(isMain(new URL('./pending.mjs', import.meta.url).href, undefined), false);
    assert.equal(isMain(new URL('./pending.mjs', import.meta.url).href, PENDING), true);
  });
});
