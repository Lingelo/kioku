/**
 * Refus de demarrer sans garde : hook du projet, plugin active mais absent, core trop ancien pour le format du coffre.
 * `node --test tools/startup-guard.test.mjs`
 */

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';

import { startupRefusal } from './startup-guard.mjs';
import { declareFakeGuard, writeTestConfig } from './test-vault.mjs';

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

const enablePlugin = (id = 'kioku@dojo') => {
  mkdirSync(path.join(vault, '.claude'), { recursive: true });
  writeFileSync(path.join(vault, '.claude', 'settings.json'), JSON.stringify({ enabledPlugins: { [id]: true } }));
};
const install = ({ scope = 'user', projectPath, format = 1 } = {}) => {
  const installPath = path.join(home, '.claude', 'plugins', 'cache', 'dojo', 'kioku', 'abc123');
  mkdirSync(path.join(installPath, 'hooks'), { recursive: true });
  writeFileSync(path.join(installPath, 'hooks', 'guard.mjs'), '// garde\n');
  writeFileSync(path.join(installPath, 'hooks', 'format.json'), JSON.stringify({ vault: format }));
  writeFileSync(
    path.join(home, '.claude', 'plugins', 'installed_plugins.json'),
    JSON.stringify({ version: 2, plugins: { 'kioku@dojo': [{ scope, projectPath, installPath, gitCommitSha: 'a'.repeat(40) }] } }),
  );
};
const setVaultFormat = (format) => {
  const file = path.join(vault, 'kioku.config.json');
  writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, 'utf8')), format }));
};

describe('refus de demarrer', () => {
  test('hook du projet vers une garde presente : demarrage permis', () => {
    declareFakeGuard(vault);
    assert.equal(startupRefusal(vault, { home }), null);
  });

  test('aucune garde : refus', () => {
    assert.match(startupRefusal(vault, { home }), /garde absente/);
  });

  test('plugin active, installe au niveau utilisateur : demarrage permis', () => {
    enablePlugin();
    install();
    assert.equal(startupRefusal(vault, { home }), null);
  });

  test('plugin active mais pas installe : refus qui donne la commande d installation', () => {
    enablePlugin();
    const why = startupRefusal(vault, { home });
    assert.match(why, /claude plugin marketplace add <owner>\/dojo/);
    assert.match(why, /claude plugin install kioku@dojo --scope user/);
  });

  test('plugin installe pour un autre projet seulement : refus', () => {
    enablePlugin();
    install({ scope: 'project', projectPath: path.join(root, 'autre') });
    assert.match(startupRefusal(vault, { home }), /pas installe/);
  });

  test('plugin installe trop ancien pour le format du coffre : refus qui donne la commande de mise a jour', () => {
    enablePlugin();
    install({ format: 1 });
    setVaultFormat(2);
    const why = startupRefusal(vault, { home, core: path.join(home, '.claude', 'plugins', 'cache', 'dojo', 'kioku', 'abc123') });
    assert.match(why, /exige le format 2/);
    assert.match(why, /claude plugin update kioku@dojo/);
  });

  test('le core qui lance la session est trop ancien : refus, meme avec un hook du projet', () => {
    declareFakeGuard(vault);
    setVaultFormat(99);
    assert.match(startupRefusal(vault, { home }), /exige le format 99/);
  });

  test('format d installation inconnu : refus (echec ferme)', () => {
    enablePlugin();
    writeFileSync(path.join(home, '.claude', 'plugins', 'installed_plugins.json'), JSON.stringify(['?']));
    assert.match(startupRefusal(vault, { home }), /format inconnu|illisible/);
  });
});
