/**
 * Tests de `kioku commit <domaine>` : chemins calcules par le code, refus d'une ingestion inachevee, silo respecte.
 * `node --test hooks/commit.test.mjs`
 * Coffre factice sous git dans un dossier temporaire ; aucune signature, aucun hook git de la machine.
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';

const VAULT_HOOK = path.resolve('hooks/vault.mjs');
let vault;

const put = (rel, text) => {
  const file = path.join(vault, rel);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, text);
};
// Environnement neutre : ni session heritee du shell, ni Claude Code (sauf si le test le pose), ni config git globale
// (signature, hooks) de la machine.
const baseEnv = () => {
  const env = { ...process.env, CLAUDE_PROJECT_DIR: vault, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
  for (const k of ['VAULT_MODE', 'VAULT_DOMAIN', 'CLAUDECODE']) delete env[k];
  return env;
};
const git = (...args) => spawnSync('git', ['-C', vault, ...args], { encoding: 'utf8', env: baseEnv() });
const commit = (env, ...args) =>
  spawnSync(process.execPath, [VAULT_HOOK, 'commit', ...args], { cwd: vault, env: { ...baseEnv(), ...env }, encoding: 'utf8' });
const session = (mode, domain) => ({ VAULT_MODE: mode, VAULT_DOMAIN: domain });
const committed = () => git('show', '--name-only', '--format=', 'HEAD').stdout.trim().split('\n').filter(Boolean).sort();
const gated = (title) => `---\ngate: passe 2026-11-05 juge=relecteur regles=v1\ntype: concept\ntitle: ${title}\n---\n\n## Vue d'ensemble\n\nRien.\n`;
const verdict = (relecteur, file) => JSON.stringify({ verdict: 'ok', file, relecteur });

beforeEach(() => {
  vault = realpathSync(mkdtempSync(path.join(tmpdir(), 'vault-commit-test-')));
  put('kioku.config.json', JSON.stringify({ version: 1, domains: [{ id: 'pro' }, { id: 'perso' }], default_session: { mode: 'query', domain: 'pro' } }));
  put('wiki/pro/log.md', '# Journal\n\n## [2026-11-01 10:00] schema | creation\n');
  put('wiki/perso/log.md', '# Journal\n');
  git('init', '-q');
  for (const [k, v] of [['user.name', 'Test'], ['user.email', 'test@example.invalid'], ['commit.gpgsign', 'false'], ['core.hooksPath', '/dev/null']]) {
    git('config', k, v);
  }
  git('add', '-A');
  git('commit', '-q', '-m', 'init');
});
afterEach(() => rmSync(vault, { recursive: true, force: true }));

describe('kioku commit', () => {
  test('commite les zones et les verdicts du domaine, rien d un autre domaine ni ce qui etait indexe ailleurs', () => {
    put('raw/pro/meetings/2026-11-05-a.md', 'brut');
    put('silver/pro/2026-11-05-a.md', 'argent');
    put('wiki/pro/concepts/zeta.md', gated('Zeta'));
    put('wiki/pro/log.md', '# Journal\n\n## [2026-11-01 10:00] schema | creation\n## [2026-11-05 09:00] ingest | Reunion A\n');
    put('quarantine/pro/source-a.json', '{}');
    put('.verdicts/aaa.json', verdict('pro', '.candidats/wiki/pro/concepts/zeta.md'));
    put('.verdicts/bbb.json', verdict('perso', '.candidats/wiki/perso/concepts/x.md'));
    put('.verdicts/ccc.json', JSON.stringify({ verdict: 'ok', file: '.candidats/wiki/pro/concepts/old.md' })); // avant le decoupage
    put('wiki/perso/concepts/x.md', gated('X'));
    put('notes.txt', 'a moi');
    git('add', 'notes.txt');

    const r = commit(session('ingest', 'pro'), 'pro');
    assert.equal(r.status, 0, r.stdout);
    assert.match(r.stdout, /commite/);
    assert.deepEqual(committed(), [
      '.verdicts/aaa.json',
      '.verdicts/ccc.json',
      'quarantine/pro/source-a.json',
      'raw/pro/meetings/2026-11-05-a.md',
      'silver/pro/2026-11-05-a.md',
      'wiki/pro/concepts/zeta.md',
      'wiki/pro/log.md',
    ]);
    assert.equal(git('log', '-1', '--format=%s').stdout.trim(), 'ingest(pro) : Reunion A');
    // l'autre domaine et le fichier indexe par l'utilisateur restent en attente
    const status = git('status', '--porcelain', '--untracked-files=all').stdout;
    assert.match(status, /^A  notes\.txt$/m);
    assert.match(status, /wiki\/perso\/concepts\/x\.md/);
    assert.match(status, /\.verdicts\/bbb\.json/);
    assert.doesNotMatch(r.stdout, /zeta/, 'la sortie ne cite pas de page');
  });

  test('plusieurs entrees du journal : sujet compte par type, corps liste les entrees', () => {
    put('wiki/pro/log.md', '# Journal\n\n## [2026-11-01 10:00] schema | creation\n## [2026-11-05 09:00] query | "a"\n## [2026-11-05 09:05] query | "b"\n## [2026-11-05 10:00] ingest | R\n');
    const r = commit(session('query', 'pro'), 'pro');
    assert.equal(r.status, 0, r.stdout);
    assert.equal(git('log', '-1', '--format=%s').stdout.trim(), 'pro : 3 entrees du journal (query 2, ingest 1)');
    assert.match(git('log', '-1', '--format=%b').stdout, /- \[2026-11-05 10:00\] ingest \| R/);
  });

  test('-m remplace le sujet', () => {
    put('wiki/pro/log.md', '# Journal\n\nx\n');
    assert.equal(commit(session('query', 'pro'), 'pro', '-m', 'lint(pro) : decisions').status, 0);
    assert.equal(git('log', '-1', '--format=%s').stdout.trim(), 'lint(pro) : decisions');
  });

  test('refuse si une candidate attend la gate', () => {
    put('.candidats/wiki/pro/concepts/zeta.md', 'brouillon');
    put('wiki/pro/log.md', '# Journal\n\nx\n');
    const r = commit(session('ingest', 'pro'), 'pro');
    assert.equal(r.status, 1);
    assert.match(r.stdout, /candidate/);
    assert.equal(git('rev-list', '--count', 'HEAD').stdout.trim(), '1');
  });

  test('refuse une nouvelle page de l or sans gate:', () => {
    put('wiki/pro/concepts/zeta.md', '---\ntype: concept\ntitle: Zeta\n---\n\nRien.\n');
    const r = commit(session('ingest', 'pro'), 'pro');
    assert.equal(r.status, 1);
    assert.match(r.stdout, /sans gate:/);
  });

  test('silo : une session pro ne commite pas perso ; setup et triage refuses', () => {
    put('wiki/perso/log.md', '# Journal\n\nx\n');
    assert.match(commit(session('query', 'pro'), 'perso').stdout, /la session est pro, pas perso/);
    assert.match(commit(session('setup', 'pro'), 'pro').stdout, /query ou ingest seulement/);
    assert.match(commit(session('triage', undefined), 'pro').stdout, /query ou ingest seulement/);
  });

  test('dans Claude Code sans variables : le default_session s applique', () => {
    put('wiki/perso/log.md', '# Journal\n\nx\n');
    assert.match(commit({ CLAUDECODE: '1' }, 'perso').stdout, /la session est pro, pas perso/);
  });

  test('terminal hors Claude Code : libre ; rien a commiter rend 0', () => {
    const r = commit({}, 'perso');
    assert.equal(r.status, 0, r.stdout);
    assert.match(r.stdout, /rien a commiter/);
  });

  test('--dry-run ne commite rien', () => {
    put('wiki/pro/log.md', '# Journal\n\nx\n');
    const r = commit(session('query', 'pro'), 'pro', '--dry-run');
    assert.equal(r.status, 0);
    assert.match(r.stdout, /simulation : 1 fichier/);
    assert.equal(git('rev-list', '--count', 'HEAD').stdout.trim(), '1');
  });

  test('usage : domaine inconnu ou -m sans message', () => {
    assert.equal(commit({}, 'travail').status, 1);
    assert.equal(commit({}, 'pro', '-m').status, 1);
  });
});
