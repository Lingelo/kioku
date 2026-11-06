/**
 * Le hook du plugin (hooks/hooks.json) doit echouer FERME : sans `node` dans le PATH de Claude Code, le shell sort en 127,
 * que Claude Code traite comme non bloquant (la session tournerait sans garde). `|| exit 2` en fait un refus.
 * `node --test hooks/hooks.test.mjs`
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const COMMAND = JSON.parse(readFileSync(path.join(ROOT, 'hooks', 'hooks.json'), 'utf8')).hooks.PreToolUse[0].hooks[0].command;
// Claude Code lance la commande par un shell (un 127 « command not found » en est la trace). Windows : sans objet ici.
const SH = process.platform === 'win32' || !existsSync('/bin/sh') ? false : '/bin/sh';

const run = (searchPath, payload) => {
  const vault = realpathSync(mkdtempSync(path.join(tmpdir(), 'hooks-json-')));
  try {
    writeFileSync(path.join(vault, 'kioku.config.json'), JSON.stringify({ version: 1, domains: [{ id: 'a' }, { id: 'b' }] }));
    const env = { PATH: searchPath, CLAUDE_PLUGIN_ROOT: ROOT, CLAUDE_PROJECT_DIR: vault, VAULT_MODE: 'query', VAULT_DOMAIN: 'a', HOME: vault };
    return spawnSync(SH, ['-c', COMMAND], { input: JSON.stringify({ ...payload, cwd: vault }), env, encoding: 'utf8' });
  } finally {
    rmSync(vault, { recursive: true, force: true });
  }
};
const read = (file_path) => ({ tool_name: 'Read', tool_input: { file_path } });

test('hooks.json : la commande porte le repli `|| exit 2`', () => {
  assert.match(COMMAND, /\|\| exit 2$/);
});

test('node introuvable dans le PATH : refus (2), pas une session sans garde', { skip: SH ? false : 'pas de /bin/sh (Windows)' }, () => {
  const r = run('/nonexistent-kioku-bin', read('wiki/a/x.md'));
  assert.equal(r.status, 2, r.stderr);
});

test('node present : la garde decide (autorise 0, refuse 2)', { skip: SH ? false : 'pas de /bin/sh (Windows)' }, () => {
  const bin = path.dirname(process.execPath);
  assert.equal(run(bin, read('wiki/a/x.md')).status, 0);
  assert.equal(run(bin, read('wiki/b/x.md')).status, 2);
});
