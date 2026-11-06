/**
 * Tests de la proposition d'organisation du circuit Plaud : `node --test tools/plaud-sync/org-proposals.test.mjs`
 * Registre et configuration factices dans un dossier temporaire, organisations fictives : aucun fichier reel n'est lu.
 */

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { describeOrgs, loadOrgs, orgLabel, orgTarget, parseOrgLines, triagePrompt } from './org-proposals.mjs';
import { writeTestConfig } from '../test-vault.mjs';

const HERE = path.dirname(new URL(import.meta.url).pathname);
let vault;
const registry = (orgs) => {
  const file = path.join(vault, '.cla' + 'ude', 'hooks', 'orgs.json');
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify({ employer: 'acme', orgs, org_required: false }));
  return loadOrgs(vault);
};
const BASE = [
  { id: 'acme', name: 'ACME', role: 'employer' },
  { id: 'globex', name: "Globex d'Or", role: 'client', status: 'active' },
];
const SCOPE = { domains: [{ id: 'pro' }, { id: 'perso' }], orgDomain: 'pro' };

beforeEach(() => {
  vault = mkdtempSync(path.join(tmpdir(), 'org-proposals-'));
  writeTestConfig(vault);
});
afterEach(() => rmSync(vault, { recursive: true, force: true }));

describe('prompt du tri depuis le registre', () => {
  test('demande une ligne VIDE pour une note sans contenu, sans jamais rien supprimer', () => {
    for (const p of [triagePrompt(registry(BASE), ['a.md'], [], SCOPE), triagePrompt(null, ['a.md'], [], { domains: SCOPE.domains, orgDomain: null })]) {
      assert.match(p, /VIDE <fichier> : <raison en une phrase>/);
      assert.match(p, /une note courte qui porte une decision, une date ou une action n'est pas vide/);
      assert.match(p, /Ne supprime jamais rien/);
      assert.doesNotMatch(p, /["\n]/, 'une seule ligne, sans guillemets (cmd.exe)');
    }
  });

  test('transmet l organisation imposee par --decide et interdit de renommer', () => {
    const p = triagePrompt(registry(BASE), ['a.md'], [{ file: 'a.md', domain: 'pro', orgIds: ['acme'] }, { file: 'b.md', domain: 'perso', orgIds: null }], SCOPE);
    assert.match(p, /sans renommer le fichier/);
    assert.match(p, /a\.md -> pro \(organisation acme, a reprendre telle quelle dans sa ligne ORG\)/);
    assert.match(p, /b\.md -> perso(?! \()/);
    assert.doesNotMatch(p, /["\n]/);
  });

  test('cite l employeur et le client du registre', () => {
    const p = triagePrompt(registry(BASE), ['a.md'], [], SCOPE);
    assert.match(p, /employeur ACME \[acme\]/);
    assert.match(p, /clients Globex d'Or \[globex\]/);
    assert.match(p, /ORG <chemin relatif a raw\/pro\/>/);
    assert.match(p, /mission de l'employeur chez un autre client/, 'une mission de l employeur ailleurs ne fait pas abstenir le tri');
    assert.doesNotMatch(p, /"/, 'une seule ligne sans guillemets (cmd.exe)');
  });

  test('un client ajoute au registre est cite sans changement de code, une mission passee est marquee', () => {
    const reg = registry([...BASE.slice(0, 1), { ...BASE[1], status: 'past' }, { id: 'initech', name: 'Initech', role: 'client', status: 'active' }]);
    assert.match(describeOrgs(reg), /Globex d'Or \[globex\] \(mission passee\), Initech \[initech\]/);
  });

  test('les decisions explicites de l utilisateur sont transmises', () => {
    assert.match(triagePrompt(registry(BASE), ['a.md'], [{ file: 'a.md', domain: 'pro' }], SCOPE), /a\.md -> pro/);
  });

  test('aucun nom d organisation ecrit en dur dans le circuit', () => {
    // Les noms a proscrire sont ceux du registre reel ; on les lit dans la config du coffre qui porte ce depot,
    // jamais en dur dans ce test. Sans registre lisible (clone neuf), rien a comparer.
    const vaultRoot = path.resolve(HERE, '..', '..');
    let names = [];
    try {
      const target = orgTarget(vaultRoot);
      if (target) names = loadOrgs(vaultRoot, target.registry).orgs.flatMap((o) => [o.name, ...o.aliases]);
    } catch {
      names = [];
    }
    for (const name of readdirSync(HERE).filter((n) => n.endsWith('.mjs') && !n.endsWith('.test.mjs'))) {
      const text = readFileSync(path.join(HERE, name), 'utf8').toLowerCase();
      for (const org of names) assert.ok(!text.includes(org.toLowerCase()), `${name} cite ${org}`);
    }
  });
});

describe('U5 : domaines lus dans la configuration', () => {
  test('le prompt liste les domaines declares et borne le rangement a raw/<domaines>/', () => {
    const scope = { domains: [{ id: 'a', description: 'travail' }, { id: 'b' }, { id: 'c' }], orgDomain: 'a' };
    const p = triagePrompt(registry(BASE), ['x.md'], [], scope);
    assert.match(p, /parmi a \(travail\), b, c/);
    assert.match(p, /raw\/<a\|b\|c>\//);
    assert.match(p, /ORG <chemin relatif a raw\/a\/>/);
    assert.doesNotMatch(p, /\bpro\b|\bperso\b/);
  });

  test('aucun domaine a extension org : pas de ligne ORG demandee, pas de registre cite', () => {
    const p = triagePrompt(null, ['x.md'], [], { domains: [{ id: 'a' }, { id: 'b' }], orgDomain: null });
    assert.doesNotMatch(p, /ORG |employeur/);
    assert.match(p, /parmi a, b/);
  });

  test('orgTarget : le premier domaine a extension org, ou null', () => {
    assert.deepEqual(orgTarget(vault), { domain: 'pro', registry: path.join(vault, '.claude', 'hooks', 'orgs.json') });
    writeTestConfig(vault, { version: 1, domains: [{ id: 'a' }, { id: 'b', extensions: { org: { registry: 'etat/o.json' } } }] });
    assert.equal(orgTarget(vault).domain, 'b');
    writeTestConfig(vault, { version: 1, domains: [{ id: 'a' }] });
    assert.equal(orgTarget(vault), null);
  });

  test('parseOrgLines retire le prefixe du domaine a extension org, pas celui d un autre', () => {
    const reg = registry(BASE);
    const p = parseOrgLines(`ORG ${'r' + 'aw'}/b/x.md : acme\nORG ${'r' + 'aw'}/pro/y.md : acme\n`, reg, () => {}, 'b');
    assert.deepEqual([...p.keys()].sort(), [`${'r' + 'aw'}/pro/y.md`, 'x.md']);
  });
});

describe('lignes ORG de la sortie du tri', () => {
  test('une ligne valide donne une proposition triee', () => {
    const reg = registry(BASE);
    const p = parseOrgLines('bla\nORG meetings/x.md : acme, globex\nABSTENTION y.md : doute\n', reg, undefined, 'pro');
    assert.deepEqual(p.get('meetings/x.md'), ['acme', 'globex']);
    assert.equal(p.size, 1);
  });

  test('chemin complet ou a antislash : ramene au chemin relatif a raw/pro/ de la file', () => {
    const reg = registry(BASE);
    const p = parseOrgLines(`ORG ${'r' + 'aw'}/pro/meetings/a.md : globex\nORG ./meetings/b.md : acme\nORG meetings\\c.md : globex\n`, reg, undefined, 'pro');
    assert.deepEqual([...p.keys()].sort(), ['meetings/a.md', 'meetings/b.md', 'meetings/c.md']);
  });

  test('un identifiant hors registre fait ignorer la ligne, avec un avertissement', () => {
    const warnings = [];
    const p = parseOrgLines('ORG meetings/x.md : globex,initech\n', registry(BASE), (m) => warnings.push(m), 'pro');
    assert.equal(p.size, 0);
    assert.match(warnings[0], /hors registre initech/);
  });

  test('affichage : proposition ou decision laissee a l ingestion', () => {
    assert.equal(orgLabel(['acme', 'globex']), 'org: acme, globex');
    assert.equal(orgLabel(undefined), "org: a decider a l'ingestion");
  });
});
