/**
 * Tests du circuit commun : `node --test tools/connectors/circuit.test.mjs`
 *
 * Le deroule complet (tri, confirmation, fils, relances, rapport) est couvert par tools/plaud-sync/thread.test.mjs et
 * drop.test.mjs, qui passent par run.mjs, donc par ce circuit. Ici : la forme d'un connecteur, les fonctions pures, et
 * un connecteur FACTICE branche sur le circuit, pour verifier que le circuit ne suppose rien de Plaud (dossier d'etat,
 * registre, commandes citees) et qu'il prend le verrou commun.
 * Coffre factice, aucun appel reseau, aucune session : PATH reduit a node (la garde exige son interpreteur) et garde factice.
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, afterEach, before, beforeEach, describe, test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { declareFakeGuard, nodeOnlyPath, terminalEnv, testHome, writeTestConfig } from '../test-vault.mjs';
import { assertConnector, byDay, dropArgs, parseQueue } from './circuit.mjs';
import { legacyLockPath, lockPath } from './lock.mjs';

const CIRCUIT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'circuit.mjs');
const ok = { state: 'tools/faux', fetch: () => {}, drop: () => ({ ok: true }), commands: { run: 'r', drop: 'd', registry: 'g' } };

describe('assertConnector', () => {
  test('un connecteur complet passe', () => assert.equal(assertConnector(ok), ok));
  test('chaque manque est nomme', () => {
    assert.throws(() => assertConnector(null), /objet attendu/);
    assert.throws(() => assertConnector({ ...ok, state: '../x' }), /"state"/);
    assert.throws(() => assertConnector({ ...ok, fetch: 'x' }), /"fetch"/);
    assert.throws(() => assertConnector({ ...ok, drop: undefined }), /"drop"/);
    assert.throws(() => assertConnector({ ...ok, commands: { run: 'r' } }), /commands\.drop.*commands\.registry/);
  });
});

describe('fonctions pures', () => {
  test('parseQueue : etat neuf par defaut, candidates separees par des virgules, lignes vides ignorees', () => {
    assert.deepEqual(parseQueue('pro\ta.md\n\nperso\tb.md\tcandidats\tpeople/x.md,concepts/y.md\n'), [
      { domain: 'pro', rel: 'a.md', state: 'neuf', left: [] },
      { domain: 'perso', rel: 'b.md', state: 'candidats', left: ['people/x.md', 'concepts/y.md'] },
    ]);
    assert.deepEqual(parseQueue(undefined), []);
  });
  test('byDay : meme journee et meme domaine ensemble ; sans date, seule', () => {
    const e = (domain, rel) => ({ domain, rel });
    const groups = byDay([e('pro', 'm/2026-11-05-a.md'), e('perso', 'm/2026-11-05-b.md'), e('pro', 'm/2026-11-05-c.md'), e('pro', 'sans-date.md')]);
    assert.deepEqual(groups.map((g) => g.map((x) => x.rel)), [['m/2026-11-05-a.md', 'm/2026-11-05-c.md'], ['m/2026-11-05-b.md'], ['sans-date.md']]);
  });
  test('dropArgs : --drop a b c, --drop a --drop b, --drop seul', () => {
    assert.deepEqual(dropArgs(['--drop', 'a', 'b', '--yes']), ['a', 'b']);
    assert.deepEqual(dropArgs(['--drop', 'a', '--drop', 'b']), ['a', 'b']);
    assert.deepEqual(dropArgs(['--drop']), ['']);
    assert.deepEqual(dropArgs(['--yes']), []);
  });
});

describe('un connecteur factice branche sur le circuit', () => {
  let dir;
  let vault;
  let entry;
  before(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'connectors-faux-'));
    entry = path.join(dir, 'faux-run.mjs');
    // Le connecteur journalise (FAUX_LOG) ce que le circuit lui passe ; drop accepte ok.md, refuse le reste.
    writeFileSync(
      entry,
      [
        `import { appendFileSync } from 'node:fs';`,
        `import { runCircuit } from ${JSON.stringify(pathToFileURL(CIRCUIT).href)};`,
        `const LOG = process.env.FAUX_LOG;`,
        `await runCircuit({`,
        `  state: 'tools/faux',`,
        `  fetch: ({ argv, dryRun, title }) => { title('Faux -> inbox'); appendFileSync(LOG, JSON.stringify({ fetch: { dryRun, since: argv[argv.indexOf('--since') + 1] } }) + '\\n'); },`,
        `  drop: (vault, file) => (file === 'ok.md' ? { ok: true, id: 'f1', registered: false } : { ok: false, reason: 'pas de faux_id' }),`,
        `  commands: { run: 'kioku faux', drop: 'kioku faux --drop <fichier>', registry: 'faux.json' },`,
        `});`,
        '',
      ].join('\n'),
    );
  });
  after(() => rmSync(dir, { recursive: true, force: true }));
  beforeEach(() => {
    vault = mkdtempSync(path.join(tmpdir(), 'connectors-faux-vault-'));
    // Sans extension org : le circuit charge le registre des organisations avant le fetch, meme en dry-run (comme Plaud).
    writeTestConfig(vault, { version: 1, domains: [{ id: 'pro' }, { id: 'perso' }] });
    declareFakeGuard(vault);
  });
  afterEach(() => rmSync(vault, { recursive: true, force: true }));

  const log = () => path.join(vault, 'faux.log');
  const run = (args) =>
    spawnSync(process.execPath, [entry, '--vault', vault, ...args], {
      encoding: 'utf8',
      env: terminalEnv({ HOME: testHome(vault), FAUX_LOG: log(), PATH: nodeOnlyPath(vault) }),
    });
  const fetches = () => (existsSync(log()) ? readFileSync(log(), 'utf8').trim().split('\n').map((l) => JSON.parse(l).fetch) : []);

  test('--dry-run : le fetch du connecteur est appele en dry-run avec ses options, aucun verrou, aucune session', () => {
    const r = run(['--dry-run', '--since', '2026-11-01']);
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(fetches(), [{ dryRun: true, since: '2026-11-01' }]);
    assert.match(r.stdout, /== Faux -> inbox/);
    assert.match(r.stdout, /Dry-run : aucune session lancee/);
    assert.equal(existsSync(lockPath(vault)), false);
  });

  test('--drop : l ecart passe par le connecteur, les messages citent SON registre ; verrou rendu a la sortie', () => {
    mkdirSync(path.join(vault, 'inbox', 'a-trancher'), { recursive: true });
    const r = run(['--drop', 'ok.md', 'non.md']);
    assert.equal(r.status, 2, r.stderr);
    assert.match(r.stdout, /ecarte {3}ok\.md {2}\(f1, deja dans faux\.json\)/);
    assert.match(r.stdout, /1 \/ 2 ecartee\(s\)\. faux\.json est versionne/);
    assert.match(r.stderr, /REFUSE {3}non\.md : pas de faux_id/);
    assert.deepEqual(fetches(), [], 'ecarter ne depose rien');
    assert.equal(existsSync(lockPath(vault)), false);
    assert.equal(existsSync(legacyLockPath(vault)), false);
  });

  test('verrou tenu par un autre lanceur vivant (ancien fichier) : refus code 1, avant tout fetch', () => {
    mkdirSync(path.dirname(legacyLockPath(vault)), { recursive: true });
    writeFileSync(legacyLockPath(vault), JSON.stringify({ pid: process.pid, started: '2026-11-05T08:00:00.000Z' }));
    const r = run(['--skip-fetch']);
    assert.equal(r.status, 1);
    assert.match(r.stderr, new RegExp(`un autre lancement est en cours sur ce coffre : un circuit de capture \\(Plaud ou version anterieure du core, PID ${process.pid}\\) tourne, depuis 2026-11-05T08:00:00\\.000Z`));
    assert.match(r.stderr, /tools\/connectors\/\.lock\.json/);
    assert.deepEqual(fetches(), []);
    assert.equal(existsSync(lockPath(vault)), false, 'le refus ne laisse pas de verrou canonique');
  });

  test('--decide vers un domaine non declare : refus nomme, avant le verrou', () => {
    const r = run(['--skip-fetch', '--decide', 'x.md=autre']);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /--decide attend <fichier>=<pro\|perso>/);
    assert.equal(existsSync(lockPath(vault)), false);
  });

  test('N4 : lance depuis une session (CLAUDECODE ou VAULT_MODE), le circuit refuse de demarrer, dry-run compris', () => {
    for (const extra of [{ CLAUDECODE: '1' }, { VAULT_MODE: 'triage' }, { VAULT_MODE: 'ingest', VAULT_DOMAIN: 'pro' }]) {
      for (const args of [['--dry-run'], ['--skip-fetch'], ['--init-structure']]) {
        const r = spawnSync(process.execPath, [entry, '--vault', vault, ...args], { encoding: 'utf8', env: terminalEnv({ HOME: testHome(vault), FAUX_LOG: log(), PATH: nodeOnlyPath(vault), ...extra }) });
        assert.equal(r.status, 1, `${JSON.stringify(extra)} ${args}`);
        assert.match(r.stderr, /se lance depuis le terminal de l'utilisateur, jamais depuis une session Claude Code/);
      }
    }
    assert.deepEqual(fetches(), [], 'rien n a ete depose');
    assert.equal(existsSync(path.join(vault, 'wiki')), false, 'ni squelette');
  });

  test('N4 : le circuit parent tourne ; la session de tri qu il lance ne peut pas relancer un circuit', () => {
    const bin = mkdtempSync(path.join(tmpdir(), 'faux-claude-relance-'));
    try {
      const relance = path.join(vault, 'relance.txt');
      writeFileSync(
        path.join(bin, 'claude'),
        `#!/bin/bash\n"${process.execPath}" "${entry}" --vault . --dry-run > /dev/null 2> "${relance}.err"; echo "$? VAULT_MODE=$VAULT_MODE" > "${relance}"\nexit 0\n`,
      );
      chmodSync(path.join(bin, 'claude'), 0o755);
      mkdirSync(path.join(vault, 'inbox'), { recursive: true });
      writeFileSync(path.join(vault, 'inbox', '2026-11-06-note.md'), '# note inventee\n');
      const r = spawnSync(process.execPath, [entry, '--vault', vault, '--skip-fetch'], { encoding: 'utf8', env: terminalEnv({ HOME: testHome(vault), FAUX_LOG: log(), PATH: `${bin}${path.delimiter}${process.env.PATH}` }) });
      assert.match(r.stdout, /Tri de 1 source/, `le parent, lance du terminal, demarre : ${r.stderr}`);
      assert.equal(readFileSync(relance, 'utf8').trim(), '1 VAULT_MODE=triage', 'la session de tri a VAULT_MODE et sa relance est refusee');
      assert.match(readFileSync(`${relance}.err`, 'utf8'), /jamais depuis une session Claude Code/);
      assert.deepEqual(fetches(), [], 'la relance n a rien depose');
    } finally {
      rmSync(bin, { recursive: true, force: true });
    }
  });

  test('hors coffre : refus, rien n est cree', () => {
    rmSync(path.join(vault, 'kioku.config.json'));
    const r = run(['--dry-run']);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /kioku\.config\.json absent ou invalide/);
    assert.deepEqual(fetches(), []);
  });
});
