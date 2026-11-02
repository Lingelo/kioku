/**
 * Refus de demarrer sans garde (plan core/data, U12) : hook du projet, plugin active mais absent, SHA different.
 * `node --test tools/startup-guard.test.mjs`
 */

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';

import { startupRefusal } from './startup-guard.mjs';
import { declareFakeGuard, writeTestConfig } from './test-vault.mjs';

const SHA = 'a'.repeat(40);
let root;
let vault;
let home;
beforeEach(() => {
  root = realpathSync(mkdtempSync(path.join(tmpdir(), 'startup-guard-')));
  vault = path.join(root, 'coffre');
  home = path.join(root, 'home');
  writeTestConfig(vault);
  mkdirSync(path.join(home, '.claude', 'plugins'), { recursive: true });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const pinPlugin = (sha = SHA) => {
  mkdirSync(path.join(vault, '.claude'), { recursive: true });
  writeFileSync(
    path.join(vault, '.claude', 'settings.json'),
    JSON.stringify({
      extraKnownMarketplaces: { 'kioku-pin': { source: { source: 'settings', name: 'kioku-pin', plugins: [{ name: 'kioku', source: { source: 'github', repo: 'x/kioku', sha } }] } } },
      enabledPlugins: { 'kioku@kioku-pin': true },
    }),
  );
};
const install = ({ sha = SHA, projectPath = vault, scope = 'project' } = {}) => {
  const installPath = path.join(home, '.claude', 'plugins', 'cache', 'kioku-pin', 'kioku', sha.slice(0, 12));
  mkdirSync(path.join(installPath, 'hooks'), { recursive: true });
  writeFileSync(path.join(installPath, 'hooks', 'guard.mjs'), '// garde\n');
  writeFileSync(
    path.join(home, '.claude', 'plugins', 'installed_plugins.json'),
    JSON.stringify({ version: 2, plugins: { 'kioku@kioku-pin': [{ scope, projectPath, installPath, gitCommitSha: sha }] } }),
  );
};

describe('refus de demarrer', () => {
  test('hook du projet vers une garde presente : demarrage permis', () => {
    declareFakeGuard(vault);
    assert.equal(startupRefusal(vault, { home }), null);
  });

  test('aucune garde : refus', () => {
    assert.match(startupRefusal(vault, { home }), /garde absente/);
  });

  test('plugin active, installe pour ce coffre au SHA epingle : demarrage permis', () => {
    pinPlugin();
    install();
    assert.equal(startupRefusal(vault, { home }), null);
  });

  test('plugin active mais pas installe : refus qui donne la commande d installation', () => {
    pinPlugin();
    assert.match(startupRefusal(vault, { home }), /claude plugin install kioku@kioku-pin --scope project/);
  });

  test('plugin installe pour un autre coffre seulement : refus', () => {
    pinPlugin();
    install({ projectPath: path.join(root, 'autre') });
    assert.match(startupRefusal(vault, { home }), /pas installe/);
  });

  test('plugin installe a un autre SHA que celui epingle : refus qui donne la commande de mise a jour', () => {
    pinPlugin('b'.repeat(40));
    install();
    assert.match(startupRefusal(vault, { home }), /claude plugin update kioku@kioku-pin/);
  });

  test('format d installation inconnu : refus (echec ferme)', () => {
    pinPlugin();
    writeFileSync(path.join(home, '.claude', 'plugins', 'installed_plugins.json'), JSON.stringify(['?']));
    assert.match(startupRefusal(vault, { home }), /format inconnu|illisible/);
  });
});
