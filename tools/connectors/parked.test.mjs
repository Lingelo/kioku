/**
 * Tests des sources parquees, cote socle : `node --test tools/connectors/parked.test.mjs`
 * L'ecart Plaud (plaud_id, seen.json) est couvert par tools/plaud-sync/drop.test.mjs. Ici, un connecteur factice :
 * identifiant `faux_id:` et registre en memoire, pour verifier que le socle ne suppose rien de Plaud.
 */

import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';
import { companionOf, dropParkedWith, logReason, mdIn, park, parkedDir, pruneReasons, reasonsPath } from './parked.mjs';

let vault;
let registry;
const faux = () => ({
  idOf: (text) => text.match(/^faux_id: (\S+)$/m)?.[1] ?? null,
  register: (id) => (registry.includes(id) ? false : (registry.push(id), true)),
  noId: 'pas de faux_id',
});
const inbox = (name) => path.join(vault, 'inbox', name);

beforeEach(() => {
  vault = mkdtempSync(path.join(tmpdir(), 'connectors-parked-'));
  registry = [];
  mkdirSync(parkedDir(vault), { recursive: true });
});
afterEach(() => rmSync(vault, { recursive: true, force: true }));

test('park deplace la source de l entrant et consigne la raison datee', () => {
  writeFileSync(inbox('a.md'), 'x');
  park(vault, 'a.md', 'source mixte');
  assert.equal(existsSync(inbox('a.md')), false);
  assert.equal(existsSync(path.join(parkedDir(vault), 'a.md')), true);
  assert.match(readFileSync(reasonsPath(vault), 'utf8'), /^- a\.md \(\d{4}-\d\d-\d\d\) : source mixte\n$/);
});

test('logReason cree le dossier s il manque', () => {
  rmSync(parkedDir(vault), { recursive: true });
  logReason(vault, 'b.md', 'r', '2026-11-05');
  assert.equal(readFileSync(reasonsPath(vault), 'utf8'), '- b.md (2026-11-05) : r\n');
});

test('mdIn ignore _raisons.md, les autres extensions et un dossier absent', () => {
  for (const f of ['a.md', '_raisons.md', 'b.txt']) writeFileSync(path.join(parkedDir(vault), f), '');
  assert.deepEqual(mdIn(parkedDir(vault)), ['a.md']);
  assert.deepEqual(mdIn(path.join(vault, 'absent')), []);
});

test('ecart : registre du connecteur d abord, puis fichier et raison', () => {
  writeFileSync(path.join(parkedDir(vault), 'a.md'), '---\nfaux_id: f1\n---\n');
  writeFileSync(reasonsPath(vault), '- a.md (2026-11-05) : r\n- ab.md (2026-11-05) : r\n');
  assert.deepEqual(dropParkedWith(vault, 'a.md', faux()), { ok: true, id: 'f1', registered: true });
  assert.deepEqual(registry, ['f1']);
  assert.equal(existsSync(path.join(parkedDir(vault), 'a.md')), false);
  assert.equal(readFileSync(reasonsPath(vault), 'utf8'), '- ab.md (2026-11-05) : r\n');
});

test('sans identifiant : la raison du connecteur, rien n est touche', () => {
  writeFileSync(path.join(parkedDir(vault), 'b.md'), 'sans id');
  assert.deepEqual(dropParkedWith(vault, 'b.md', faux()), { ok: false, reason: 'pas de faux_id' });
  assert.equal(existsSync(path.join(parkedDir(vault), 'b.md')), true);
  assert.deepEqual(registry, []);
});

test('le registre qui leve : le fichier reste (une source supprimee non consignee reviendrait)', () => {
  writeFileSync(path.join(parkedDir(vault), 'c.md'), 'faux_id: f3\n');
  const broken = { ...faux(), register: () => { throw new Error('registre illisible'); } };
  assert.throws(() => dropParkedWith(vault, 'c.md', broken), /registre illisible/);
  assert.equal(existsSync(path.join(parkedDir(vault), 'c.md')), true);
});

test('chemins, absents et fichiers _ refuses', () => {
  for (const name of ['../x.md', 'sub/x.md', 'absent.md', '_raisons.md', '', 'x.txt']) assert.equal(dropParkedWith(vault, name, faux()).ok, false, name);
});

test('pruneReasons sans _raisons.md : 0, rien n est cree', () => {
  assert.equal(pruneReasons(vault), 0);
  assert.equal(existsSync(reasonsPath(vault)), false);
});

test('compagnon : x.pdf.md -> x.pdf ; une note sans extension interne (Plaud) n en a pas', () => {
  assert.equal(companionOf('2026-11-03-devis-0a1b.pdf.md'), '2026-11-03-devis-0a1b.pdf');
  assert.equal(companionOf('2026-11-03-reunion.md'), null);
  assert.equal(companionOf('x.pdf'), null);
});

test('park emmene le compagnon ; l ecart le supprime avec sa fiche', () => {
  writeFileSync(inbox('d.pdf'), '%PDF');
  writeFileSync(inbox('d.pdf.md'), 'faux_id: f9\n');
  park(vault, 'd.pdf.md', 'doute');
  assert.ok(existsSync(path.join(parkedDir(vault), 'd.pdf')));
  assert.ok(!existsSync(inbox('d.pdf')));
  assert.equal(dropParkedWith(vault, 'd.pdf.md', faux()).ok, true);
  assert.ok(!existsSync(path.join(parkedDir(vault), 'd.pdf')));
});
