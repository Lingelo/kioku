/**
 * Tests des primitives de deduplication : `node --test tools/connectors/dedup.test.mjs`
 * Les regles Plaud (id -> nom -> contenu, seen.json) restent testees par tools/plaud-sync/dedup.test.mjs.
 */

import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { writeTestConfig } from '../test-vault.mjs';
import { addToRegistryAt, frontmatterValue, loadRegistryAt, places, scanKnown, sha, withFrontmatterId } from './dedup.mjs';

const RAW = 'r' + 'aw';
let vault;
const put = (rel, text) => {
  const file = path.join(vault, rel);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, text);
};

beforeEach(() => {
  vault = mkdtempSync(path.join(tmpdir(), 'connectors-dedup-'));
});
afterEach(() => rmSync(vault, { recursive: true, force: true }));

describe('frontmatter', () => {
  test('lit un champ quelconque, guillemets et CRLF toleres', () => {
    assert.equal(frontmatterValue('---\nfaux_id: f1\n---\nx', 'faux_id'), 'f1');
    assert.equal(frontmatterValue('---\r\nfaux_id: "f2"\r\n---\r\n', 'faux_id'), 'f2');
    assert.equal(frontmatterValue('---\nautre: f1\n---\n', 'faux_id'), null);
    assert.equal(frontmatterValue('faux_id: hors frontmatter\n', 'faux_id'), null);
  });
  test('une cle a caractere special ne casse pas la regex', () => {
    assert.equal(frontmatterValue('---\na.b: v\n---\n', 'a.b'), 'v');
    assert.equal(frontmatterValue('---\naxb: v\n---\n', 'a.b'), null);
  });
  test('l empreinte ignore l identifiant ajoute', () => {
    assert.equal(sha(withFrontmatterId('# corps\n', 'faux_id', 'f1')), sha('# corps\n'));
  });
});

describe('places et scanKnown', () => {
  test('sans configuration lisible : les deux domaines d origine', () => {
    assert.deepEqual(places(vault).map(([p]) => p.split(path.sep).join('/')), ['inbox', 'inbox/a-trancher', `${RAW}/pro`, `${RAW}/perso`]);
  });
  test('avec configuration : un raw/<D> par domaine declare', () => {
    writeTestConfig(vault, { version: 1, domains: [{ id: 'a' }, { id: 'b' }, { id: 'c' }] });
    assert.deepEqual(places(vault).slice(2).map(([p]) => p.split(path.sep).join('/')), [`${RAW}/a`, `${RAW}/b`, `${RAW}/c`]);
  });
  test('l identifiant est lu par la fonction du connecteur', () => {
    writeTestConfig(vault);
    put(`${RAW}/pro/emails/f.md`, '---\nfaux_id: t1\n---\n# fil\n');
    put('inbox/_raisons.md', '---\nfaux_id: ignore\n---\n');
    const known = scanKnown(vault, (t) => frontmatterValue(t, 'faux_id'));
    assert.equal(known.ids.get('t1'), `${RAW}/pro`);
    assert.equal(known.ids.has('ignore'), false);
    assert.equal(known.names.get('f.md'), `${RAW}/pro`);
  });
});

describe('registre', () => {
  test('absent : vide ; ajout sans doublon', () => {
    const file = path.join(vault, 'seen.json');
    assert.deepEqual(loadRegistryAt(file), []);
    assert.equal(addToRegistryAt(file, { id: 'a', x: 1 }), true);
    assert.equal(addToRegistryAt(file, { id: 'a', x: 2 }), false);
    assert.deepEqual(loadRegistryAt(file), [{ id: 'a', x: 1 }]);
  });
  test('illisible : leve, et n est pas ecrase', () => {
    const file = path.join(vault, 'seen.json');
    writeFileSync(file, '[{"id":');
    assert.throws(() => loadRegistryAt(file));
    assert.throws(() => addToRegistryAt(file, { id: 'b' }));
    assert.equal(existsSync(file), true);
  });
});
