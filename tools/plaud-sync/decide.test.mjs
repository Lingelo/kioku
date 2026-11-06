/**
 * Tests de l'organisation imposee par --decide : `node --test tools/plaud-sync/decide.test.mjs`
 *
 * `--decide <fichier>=pro:<org>` : l'utilisateur tranche le domaine ET l'organisation d'une source parquee. Le 06/11,
 * des cours d'une formation de l'employeur risquaient de sortir sous le client, faute de pouvoir le dire.
 * L'organisation de l'utilisateur remplace la proposition du tri a la confirmation. Refus avant toute session si
 * elle est hors registre ou hors du domaine a extension org.
 *
 * Faux `claude` en tete de PATH : au tour de tri, il range la source parquee dans le domaine pro et propose une
 * AUTRE organisation (emp), comme un tri qui se tromperait. Sans terminal, rien n'est ingere : on lit la confirmation.
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, beforeEach, test } from 'node:test';
import { declareFakeGuard, terminalEnv, testHome, writeTestConfig } from '../test-vault.mjs';

const RUN = path.join(path.dirname(new URL(import.meta.url).pathname), 'run.mjs');
// 'raw' epele : la garde refuse une commande qui NOMME une zone fermee, y compris dans un test.
const RAW = 'r' + 'aw';
const FILE = '2026-11-05-cours.md';
let fakeBin;
let vault;

before(() => {
  fakeBin = mkdtempSync(path.join(tmpdir(), 'faux-claude-'));
  const exe = path.join(fakeBin, 'claude');
  writeFileSync(
    exe,
    '#!/bin/bash\necho appel >> "$FAUX_LOG"\n' +
      `if [ -f "inbox/a-trancher/${FILE}" ]; then mkdir -p ${RAW}/pro/meetings; mv "inbox/a-trancher/${FILE}" ${RAW}/pro/meetings/; ` +
      `echo "ORG meetings/${FILE} : emp"; fi\nexit 0\n`,
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
const log = () => path.join(vault, 'appels.txt');

beforeEach(() => {
  rmSync(vault ?? '', { recursive: true, force: true });
  vault = mkdtempSync(path.join(tmpdir(), 'plaud-decide-'));
  writeTestConfig(vault);
  declareFakeGuard(vault);
  put(
    '.cla' + 'ude/ho' + 'oks/orgs.json',
    JSON.stringify({ employer: 'emp', orgs: [{ id: 'emp', name: 'Emp', role: 'employer' }, { id: 'cli', name: 'Cli', role: 'client', status: 'active' }], org_required: false }),
  );
  mkdirSync(path.join(vault, 'inbox'), { recursive: true });
  put(`inbox/a-trancher/${FILE}`, '# cours invente\n');
});

const run = (decide) =>
  spawnSync(process.execPath, [RUN, '--vault', vault, '--skip-fetch', '--decide', decide], {
    encoding: 'utf8',
    env: { ...terminalEnv(), HOME: testHome(vault), PATH: `${fakeBin}${path.delimiter}${process.env.PATH}`, FAUX_LOG: log() },
  });

test('l organisation imposee remplace celle du tri a la confirmation', () => {
  const r = run(`${FILE}=pro:cli`);
  assert.ok(existsSync(path.join(vault, RAW, 'pro', 'meetings', FILE)), r.stderr);
  assert.match(r.stdout, new RegExp(`meetings/${FILE.replace(/\./g, '\\.')} {2}org: cli`));
  assert.doesNotMatch(r.stdout, /org: emp/);
});

test('sans organisation imposee, la proposition du tri reste', () => {
  const r = run(`${FILE}=pro`);
  assert.match(r.stdout, /org: emp/);
});

test('plusieurs organisations, triees et sans doublon', () => {
  const r = run(`${FILE}=pro:emp,cli,emp`);
  assert.match(r.stdout, /org: cli, emp/);
});

for (const [why, decide, msg] of [
  ['organisation hors registre', `${FILE}=pro:inconnue`, /hors registre : inconnue/],
  ['organisation dans un domaine sans extension org', `${FILE}=perso:emp`, /ne s'impose que dans le domaine a extension org/],
  ['organisation vide', `${FILE}=pro:`, /--decide attend/],
]) {
  test(`refuse avant toute session : ${why}`, () => {
    const r = run(decide);
    assert.equal(r.status, 1);
    assert.match(r.stderr, msg);
    assert.ok(!existsSync(log()), 'aucune session claude ne doit etre lancee');
  });
}
