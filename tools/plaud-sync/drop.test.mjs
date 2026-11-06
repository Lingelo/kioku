/**
 * Tests de l'ecart d'une source parquee : `node --test tools/plaud-sync/drop.test.mjs`
 * Coffre factice dans un dossier temporaire, contenus inventes : aucun fichier reel n'est lu.
 *
 * Ce qui est verifie avant tout : une source ecartee ne revient pas (son id est dans seen.json et le fetch la
 * classe « ecarte:registre »), et une source sans plaud_id n'est jamais supprimee.
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { beforeEach, afterEach, test } from 'node:test';
import { classify, loadRegistry, scanKnown, withPlaudId } from './dedup.mjs';
import { dropParked, parseEmptyLines, pruneReasons } from './drop.mjs';
import { terminalEnv, writeTestConfig } from '../test-vault.mjs';

const RUN = path.join(path.dirname(new URL(import.meta.url).pathname), 'run.mjs');
const BODY ='# Note inventee\n\nContenu invente pour le test.\n';
let vault;
const parked = (name) => path.join(vault, 'inbox', 'a-trancher', name);
const put = (name, text) => writeFileSync(parked(name), text);

beforeEach(() => {
  vault = mkdtempSync(path.join(tmpdir(), 'plaud-drop-'));
  writeTestConfig(vault);
  mkdirSync(path.join(vault, 'tools', 'plaud-sync'), { recursive: true });
  mkdirSync(path.join(vault, 'inbox', 'a-trancher'), { recursive: true });
  writeFileSync(path.join(vault, 'tools', 'plaud-sync', 'seen.json'), '[]\n');
});
afterEach(() => rmSync(vault, { recursive: true, force: true }));

test('consigne l id comme ecarte, supprime le fichier : le fetch ne le redepose plus', () => {
  put('a.md', withPlaudId(BODY, 'of_aaa'));
  const r = dropParked(vault, 'a.md');
  assert.deepEqual(r, { ok: true, id: 'of_aaa', registered: true });
  assert.equal(existsSync(parked('a.md')), false);
  assert.equal(loadRegistry(vault)[0].domaine, 'ecarte');
  const label = classify({ id: 'of_aaa', fileName: 'a.md', markdown: BODY }, { known: scanKnown(vault), registry: loadRegistry(vault) });
  assert.equal(label, 'ecarte:registre');
});

test('retire seulement la ligne du fichier dans _raisons.md', () => {
  put('a.md', withPlaudId(BODY, 'of_aaa'));
  put('_raisons.md', '- a.md (2026-10-20) : raison A\n- ab.md (2026-10-20) : raison B\n');
  dropParked(vault, 'a.md');
  assert.equal(readFileSync(parked('_raisons.md'), 'utf8'), '- ab.md (2026-10-20) : raison B\n');
});

test('pruneReasons retire les raisons des fichiers qui ne sont plus parques, garde le reste', () => {
  put('reste.md', BODY);
  put('_raisons.md', '# Raisons\n- parti.md (2026-10-20) : tranche\n- reste.md (2026-10-20) : en attente\n');
  assert.equal(pruneReasons(vault), 1);
  assert.equal(readFileSync(parked('_raisons.md'), 'utf8'), '# Raisons\n- reste.md (2026-10-20) : en attente\n');
  assert.equal(pruneReasons(vault), 0);
});

test('sans plaud_id : refuse et ne supprime rien', () => {
  put('b.md', BODY);
  const r = dropParked(vault, 'b.md');
  assert.equal(r.ok, false);
  assert.equal(existsSync(parked('b.md')), true);
  assert.deepEqual(loadRegistry(vault), []);
});

test('refuse un chemin, un fichier absent ou _raisons.md', () => {
  put('_raisons.md', '');
  for (const name of ['../x.md', 'sub/x.md', 'absent.md', '_raisons.md', '']) assert.equal(dropParked(vault, name).ok, false, name);
  assert.equal(existsSync(parked('_raisons.md')), true);
});

test('run.mjs --drop a b c : ecarte chaque fichier, refuse celui sans id, ne lance ni fetch ni session', () => {
  put('a.md', withPlaudId(BODY, 'of_aaa'));
  put('b.md', withPlaudId(BODY, 'of_bbb'));
  put('c.md', BODY);
  mkdirSync(path.join(vault, '.cla' + 'ude', 'ho' + 'oks'), { recursive: true });
  writeFileSync(path.join(vault, '.cla' + 'ude', 'ho' + 'oks', 'gu' + 'ard.mjs'), '');
  // PATH vide : un appel a claude ou au MCP Plaud echouerait au lieu de passer inapercu.
  const r = spawnSync(process.execPath, [RUN, '--vault', vault, '--drop', 'a.md', 'b.md', 'c.md'], { encoding: 'utf8', env: terminalEnv({ PATH: '' }) });
  assert.equal(r.status, 2, r.stderr);
  assert.match(r.stdout, /2 \/ 3 ecartee/);
  assert.match(r.stderr, /REFUSE {3}c\.md/);
  assert.deepEqual(loadRegistry(vault).map((e) => e.id), ['of_aaa', 'of_bbb']);
  assert.equal(existsSync(parked('c.md')), true);
});

test('parseEmptyLines : ne retient que les notes parquees, par leur nom, dans l ordre et sans doublon', () => {
  const out = [
    'VIDE a.md : test de connexion audio',
    'VIDE a-trancher/b.md : fragment d une phrase',
    'VIDE inbox\\a-trancher\\c.md : silence',
    'VIDE invente.md : nom que la session a imagine',
    'VIDE rangee.md : rangee dans un domaine, pas parquee',
    'ABSTENTION d.md : source mixte',
    '  VIDE e.md : indentee, pas une ligne de protocole',
    'VIDE a.md : doublon',
  ].join('\n');
  const empties = parseEmptyLines(out, ['a.md', 'b.md', 'c.md', 'd.md', 'e.md']);
  assert.deepEqual([...empties], [
    ['a.md', 'test de connexion audio'],
    ['b.md', 'fragment d une phrase'],
    ['c.md', 'silence'],
  ]);
});

test('parseEmptyLines : sortie vide ou absente, rien a proposer', () => {
  assert.equal(parseEmptyLines('', ['a.md']).size, 0);
  assert.equal(parseEmptyLines(undefined, ['a.md']).size, 0);
  assert.equal(parseEmptyLines('VIDE a.md : x', []).size, 0);
});

test('id deja consigne : supprime quand meme, sans doublon dans seen.json', () => {
  writeFileSync(path.join(vault, 'tools', 'plaud-sync', 'seen.json'), JSON.stringify([{ id: 'of_aaa', domaine: 'ecarte', date: '2026-10-01' }]));
  put('a.md', withPlaudId(BODY, 'of_aaa'));
  assert.deepEqual(dropParked(vault, 'a.md'), { ok: true, id: 'of_aaa', registered: false });
  assert.equal(loadRegistry(vault).length, 1);
});
