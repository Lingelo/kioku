/**
 * Tests de l'ecart propose des notes vides : `node --test tools/plaud-sync/empty.test.mjs`
 *
 * Le tri parque une note sans contenu (test audio, fragment) avec une ligne `VIDE <fichier> : <raison>` ; run.mjs
 * la propose a l'ecart avant la confirmation d'ingestion. Ecarter est irreversible (seen.json) : sans terminal ou
 * avec --yes, rien n'est ecarte. Le chemin interactif (terminal, « o ») n'est pas teste ici : spawnSync ne donne pas
 * de TTY ; la suppression elle-meme est celle de dropParked, testee dans drop.test.mjs.
 *
 * Faux `claude` en tete de PATH : au tour de tri, il parque les fichiers nommes dans $FAUX_VIDES et ecrit leurs
 * lignes VIDE, comme le ferait la session. Coffre factice, contenus inventes, aucun modele.
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, beforeEach, test } from 'node:test';
import { withPlaudId } from './dedup.mjs';
import { declareFakeGuard, terminalEnv, testHome, writeTestConfig } from '../test-vault.mjs';

const RUN = path.join(path.dirname(new URL(import.meta.url).pathname), 'run.mjs');
let fakeBin;
let vault;

before(() => {
  fakeBin = mkdtempSync(path.join(tmpdir(), 'faux-claude-'));
  const exe = path.join(fakeBin, 'claude');
  writeFileSync(
    exe,
    '#!/bin/bash\nmkdir -p inbox/a-trancher\n' +
      'for f in $FAUX_VIDES; do mv "inbox/$f" inbox/a-trancher/ 2>/dev/null; echo "VIDE $f : test de connexion invente"; done\n' +
      'for f in $FAUX_ABST; do mv "inbox/$f" inbox/a-trancher/ 2>/dev/null; echo "ABSTENTION $f : source mixte inventee"; done\n' +
      'exit 0\n',
  );
  chmodSync(exe, 0o755);
});
after(() => {
  rmSync(fakeBin, { recursive: true, force: true });
  rmSync(vault ?? '', { recursive: true, force: true });
});

const put = (rel, text) => {
  const file = path.join(vault, rel);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, text);
};
const parked = (f) => path.join(vault, 'inbox', 'a-trancher', f);

beforeEach(() => {
  rmSync(vault ?? '', { recursive: true, force: true });
  vault = mkdtempSync(path.join(tmpdir(), 'plaud-vide-'));
  writeTestConfig(vault);
  declareFakeGuard(vault);
  put(
    '.cla' + 'ude/ho' + 'oks/orgs.json',
    JSON.stringify({ employer: 'emp', orgs: [{ id: 'emp', name: 'Emp', role: 'employer' }], org_required: false }),
  );
  put('tools/plaud-sync/seen.json', '[]\n');
  put('inbox/2026-11-05-vide.md', withPlaudId('bonjour\n', 'of_vide'));
  put('inbox/2026-11-05-mixte.md', withPlaudId('# note inventee\n', 'of_mixte'));
});

const run = (args = [], env = {}) =>
  spawnSync(process.execPath, [RUN, '--vault', vault, '--skip-fetch', ...args], {
    encoding: 'utf8',
    env: { ...terminalEnv(), HOME: testHome(vault), PATH: `${fakeBin}${path.delimiter}${process.env.PATH}`, FAUX_VIDES: '', FAUX_ABST: '', ...env },
  });

test('sans terminal : la note vide est listee avec sa raison et reste parquee, seen.json intact', () => {
  const r = run([], { FAUX_VIDES: '2026-11-05-vide.md', FAUX_ABST: '2026-11-05-mixte.md' });
  assert.match(r.stdout, /1 note\(s\) sans contenu selon le tri/);
  assert.match(r.stdout, /2026-11-05-vide\.md {2}\(\d+ octets\) : test de connexion invente/);
  assert.match(r.stdout, /Pas de terminal : elles restent parquees/);
  assert.ok(existsSync(parked('2026-11-05-vide.md')));
  assert.equal(readFileSync(path.join(vault, 'tools', 'plaud-sync', 'seen.json'), 'utf8'), '[]\n');
  // La raison est consignee comme celle d'un indecis, marquee « sans contenu ».
  assert.match(readFileSync(parked('_raisons.md'), 'utf8'), /- 2026-11-05-vide\.md \(\d{4}-\d{2}-\d{2}\) : sans contenu : test de connexion invente/);
  // Une abstention n'est jamais proposee a l'ecart.
  assert.doesNotMatch(r.stdout, /2026-11-05-mixte\.md {2}\(/);
});

test('--yes n\'ecarte rien', () => {
  const r = run(['--yes'], { FAUX_VIDES: '2026-11-05-vide.md' });
  assert.match(r.stdout, /--yes n'ecarte rien/);
  assert.ok(existsSync(parked('2026-11-05-vide.md')));
  assert.equal(readFileSync(path.join(vault, 'tools', 'plaud-sync', 'seen.json'), 'utf8'), '[]\n');
});

test('une source tranchee par --decide n\'est jamais proposee a l\'ecart, meme dite vide', () => {
  rmSync(path.join(vault, 'inbox', '2026-11-05-mixte.md'));
  mkdirSync(path.join(vault, 'inbox', 'a-trancher'), { recursive: true });
  // Deja parquee lors d'un tri precedent ; l'utilisateur la tranche, la session la redit vide et la reparque.
  writeFileSync(parked('2026-11-05-vide.md'), withPlaudId('bonjour\n', 'of_vide'));
  rmSync(path.join(vault, 'inbox', '2026-11-05-vide.md'));
  const r = run(['--decide', '2026-11-05-vide.md=pro'], { FAUX_VIDES: '2026-11-05-vide.md' });
  assert.ok(existsSync(parked('2026-11-05-vide.md')), 'le faux tri doit avoir laisse la note parquee');
  assert.doesNotMatch(r.stdout, /sans contenu selon le tri/);
});

test('aucune ligne VIDE : pas de question', () => {
  const r = run([], { FAUX_ABST: '2026-11-05-vide.md 2026-11-05-mixte.md' });
  assert.doesNotMatch(r.stdout, /sans contenu selon le tri/);
});
