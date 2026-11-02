/**
 * Tests de cloisonnement strict pro / perso : U6, R14, KTD5
 * `node --test tools/dashboard/silo.test.mjs`
 *
 * Verifie qu'un dashboard genere pour un domaine ne contient AUCUNE donnee
 * de l'autre domaine (ni chemin, ni slug, ni contenu, ni candidat).
 */

import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { beforeEach, afterEach, describe, test } from 'node:test';

import { generateDashboardHtml, resolveDomains } from './run.mjs';
import { TEST_CONFIG, writeTestConfig } from '../test-vault.mjs';

let vault;
const put = (rel, text) => {
  const file = path.join(vault, rel);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, text);
};

beforeEach(() => {
  vault = mkdtempSync(path.join(tmpdir(), 'silo-test-'));
  writeTestConfig(vault);
});
afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
});

describe('U6 / R14 : Cloisonnement strict pro / perso dans le dashboard', () => {
  test('le dashboard pro ne contient aucune trace du domaine perso', () => {
    // 1. Donnees pro
    put(
      'wiki/pro/projects/projet-secret-pro.md',
      '---\ntitle: Projet Secret Pro\ntype: project\ngate: passe 2026-09-24\n---\nContenu pro confidentiel.\n'
    );
    put(
      'quarantine/pro/quarantaine-pro.json',
      JSON.stringify({ code: 'diffamation', target: 'wiki/pro/people/suspect.md' })
    );

    // 2. Donnees perso
    put(
      'wiki/perso/people/dr-martin-perso.md',
      '---\ntitle: Dr Martin Perso\ntype: person\ngate: passe 2026-09-24\n---\nDonnee medicale privee perso.\n'
    );
    put(
      'quarantine/perso/quarantaine-perso.json',
      JSON.stringify({ code: 'sensible', target: 'wiki/perso/people/enfant.md' })
    );
    put(
      'silver/perso/consultation-perso.md',
      '---\nraw: raw/perso/med/fiche.pdf\n---\nResume consultation medicale perso.\n'
    );

    // Generation du HTML pro
    const htmlPro = generateDashboardHtml(vault, 'pro');

    // Verifications positives sur le pro
    assert.ok(htmlPro.includes('Projet Secret Pro'));
    assert.ok(htmlPro.includes('projet-secret-pro'));
    assert.ok(htmlPro.includes('wiki/pro/people/suspect.md'));

    // Verifications de non-contamination par le perso (R14, KTD5)
    assert.ok(!htmlPro.includes('dr-martin-perso'));
    assert.ok(!htmlPro.includes('Dr Martin Perso'));
    assert.ok(!htmlPro.includes('Donnee medicale privee perso'));
    assert.ok(!htmlPro.includes('quarantaine-perso'));
    assert.ok(!htmlPro.includes('consultation-perso'));
    assert.ok(!htmlPro.includes('wiki/perso'));
    assert.ok(!htmlPro.includes('raw/perso'));
    assert.ok(!htmlPro.includes('silver/perso'));
    assert.ok(!htmlPro.includes('quarantine/perso'));
  });

  test('le dashboard perso ne contient aucune trace du domaine pro', () => {
    // Donnees pro
    put(
      'wiki/pro/projects/strategie-globex.md',
      '---\ntitle: Strategie Globex\ntype: project\ngate: passe 2026-09-24\n---\nSecrets d\'entreprise pro.\n'
    );

    // Donnees perso
    put(
      'wiki/perso/projects/maison-travaux.md',
      '---\ntitle: Maison Travaux\ntype: project\ngate: passe 2026-09-24\n---\nDevis fenetres perso.\n'
    );

    // Generation du HTML perso
    const htmlPerso = generateDashboardHtml(vault, 'perso');

    // Verifications positives sur le perso
    assert.ok(htmlPerso.includes('Maison Travaux'));
    assert.ok(htmlPerso.includes('maison-travaux'));

    // Verifications de non-contamination par le pro (R14, KTD5)
    assert.ok(!htmlPerso.includes('strategie-globex'));
    assert.ok(!htmlPerso.includes('Strategie Globex'));
    assert.ok(!htmlPerso.includes('Secrets d\'entreprise pro'));
    assert.ok(!htmlPerso.includes('wiki/pro'));
    assert.ok(!htmlPerso.includes('raw/pro'));
    assert.ok(!htmlPerso.includes('silver/pro'));
    assert.ok(!htmlPerso.includes('quarantine/pro'));
  });
});

describe('Silo de session : resolveDomains refuse de sortir du domaine de la session', () => {
  const session = (extra = {}) => ({ CLAUDECODE: '1', ...extra });

  test('hors session Claude, tous les domaines restent accessibles', () => {
    assert.deepEqual(resolveDomains(undefined, {}, vault), ['pro']);
    assert.deepEqual(resolveDomains('perso', {}, vault), ['perso']);
    assert.deepEqual(resolveDomains('all', {}, vault), ['pro', 'perso']);
  });

  test('en session, le domaine de la session est le defaut', () => {
    assert.deepEqual(resolveDomains(undefined, session({ VAULT_DOMAIN: 'perso' }), vault), ['perso']);
    assert.deepEqual(resolveDomains('pro', session({ VAULT_DOMAIN: 'pro' }), vault), ['pro']);
  });

  test('en session, all est refuse quel que soit le domaine', () => {
    assert.throws(() => resolveDomains('all', session({ VAULT_DOMAIN: 'pro' }), vault), /silo/);
    assert.throws(() => resolveDomains('all', session({ VAULT_DOMAIN: 'perso' }), vault), /silo/);
  });

  test('en session, l autre domaine est refuse', () => {
    assert.throws(() => resolveDomains('perso', session({ VAULT_DOMAIN: 'pro' }), vault), /silo/);
    assert.throws(() => resolveDomains('pro', session({ VAULT_DOMAIN: 'perso' }), vault), /silo/);
  });

  test('session sans VAULT_DOMAIN : le default_session de la configuration, comme la garde', () => {
    writeTestConfig(vault, { ...TEST_CONFIG, default_session: { mode: 'query', domain: 'pro' } });
    assert.deepEqual(resolveDomains(undefined, session(), vault), ['pro']);
    assert.throws(() => resolveDomains('perso', session(), vault), /silo/);
    assert.throws(() => resolveDomains('all', session(), vault), /silo/);
  });

  test('VAULT_DOMAIN pose hors Claude suffit a activer le silo', () => {
    assert.throws(() => resolveDomains('all', { VAULT_DOMAIN: 'pro' }, vault), /silo/);
  });

  test('VAULT_DOMAIN invalide ou domaine inconnu : refus', () => {
    assert.throws(() => resolveDomains('pro', session({ VAULT_DOMAIN: 'autre' }), vault), /VAULT_DOMAIN invalide/);
    assert.throws(() => resolveDomains('xyz', {}, vault), /Domaine inconnu/);
  });
});

describe('U5 : domaines lus dans la configuration du coffre', () => {
  const session = (extra = {}) => ({ CLAUDECODE: '1', ...extra });
  const THREE = { version: 1, domains: [{ id: 'a' }, { id: 'b' }, { id: 'c' }], default_session: { mode: 'query', domain: 'b' } };

  test('all = tous les domaines declares, dans l ordre ; sans argument hors session : le premier', () => {
    writeTestConfig(vault, THREE);
    assert.deepEqual(resolveDomains('all', {}, vault), ['a', 'b', 'c']);
    assert.deepEqual(resolveDomains(undefined, {}, vault), ['a']);
    assert.throws(() => resolveDomains('pro', {}, vault), /Domaine inconnu : pro.*\[a\|b\|c\|all\]/);
  });

  test('session sans VAULT_DOMAIN : le default_session de la configuration, sinon refus', () => {
    writeTestConfig(vault, THREE);
    assert.deepEqual(resolveDomains(undefined, session(), vault), ['b']);
    assert.throws(() => resolveDomains('a', session(), vault), /silo/);
    writeTestConfig(vault, { version: 1, domains: [{ id: 'a' }, { id: 'b' }] });
    assert.throws(() => resolveDomains(undefined, session(), vault), /sans default_session/);
  });

  test('configuration absente : refus nomme', () => {
    rmSync(path.join(vault, 'kioku.config.json'));
    assert.throws(() => resolveDomains('pro', {}, vault), /configuration du coffre absente/);
    assert.throws(() => generateDashboardHtml(vault, 'pro'), /configuration du coffre absente/);
  });

  test('trois domaines : le dashboard de a ne porte rien de b ni de c', () => {
    writeTestConfig(vault, THREE);
    put('wiki/a/concepts/ok.md', '---\ntype: concept\ntitle: Ok\n---\n\n[[b/concepts/x]] et [[c/concepts/y]].\n');
    put('wiki/b/concepts/secret-b.md', '---\ntype: concept\ntitle: SECRET_B\n---\n\nSECRET_B\n');
    put('wiki/c/concepts/secret-c.md', '---\ntype: concept\ntitle: SECRET_C\n---\n\nSECRET_C\n');
    const html = generateDashboardHtml(vault, 'a');
    assert.ok(!html.includes('SECRET_B') && !html.includes('SECRET_C'));
    assert.ok(!html.includes('secret-b') && !html.includes('secret-c'));
    assert.throws(() => generateDashboardHtml(vault, 'pro'), /Domaine inconnu/);
  });
});
