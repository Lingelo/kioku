/**
 * Tests de la deduplication : `node --test tools/plaud-sync/dedup.test.mjs`
 * Coffre factice dans un dossier temporaire, contenus inventes : aucun fichier reel n'est lu.
 */

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { addToRegistry, classify, legacyDomain, loadRegistry, plaudIdOf, scanKnown, sha, withPlaudId } from './dedup.mjs';

const BODY = '# Point equipe\n\nMon, 01 Jan 26\n\nContenu invente pour le test.\n';
const OTHER = '# Autre note\n\nTue, 02 Jan 26\n\nUn autre contenu invente.\n';

let vault;
const put = (rel, text) => {
  const file = path.join(vault, rel);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, text);
};
const ctx = () => ({ known: scanKnown(vault), registry: loadRegistry(vault) });

before(() => {
  vault = mkdtempSync(path.join(tmpdir(), 'plaud-dedup-'));
  mkdirSync(path.join(vault, 'tools', 'plaud-sync'), { recursive: true });
  writeFileSync(path.join(vault, 'tools', 'plaud-sync', 'seen.json'), '[]\n');
});
after(() => rmSync(vault, { recursive: true, force: true }));

describe('empreinte et frontmatter', () => {
  test("ajouter plaud_id ne change pas l'empreinte", () => {
    assert.equal(sha(withPlaudId(BODY, 'of_abc')), sha(BODY));
    assert.equal(plaudIdOf(withPlaudId(BODY, 'of_abc')), 'of_abc');
  });
  test('les fins de ligne Windows ne changent pas l\'empreinte', () => {
    assert.equal(sha(BODY.replace(/\n/g, '\r\n')), sha(BODY));
  });
  test('un contenu different a une empreinte differente', () => assert.notEqual(sha(BODY), sha(OTHER)));
});

describe('titre tronque autrement (brut ancien sans id, autre nom)', () => {
  test("id et nom ne concordent pas, le contenu attrape le doublon", () => {
    put('raw/perso/meetings/2026-01-01-nom-court.md', BODY);
    const c = ctx();
    const note = { id: 'of_nouveau', fileName: '2026-01-01-nom-long-tronque-autrement.md' };
    assert.equal(classify(note, c), null, 'avant get_note, rien ne le signale');
    assert.equal(classify({ ...note, markdown: BODY }, c), 'connu:contenu');
  });
});

describe('note retitree (id present dans un brut)', () => {
  test("l'id suffit, meme si le titre, le nom et le contenu ont change", () => {
    put('raw/pro/meetings/2026-01-05-ancien-titre.md', withPlaudId(OTHER, 'of_retitre'));
    const verdict = classify(
      { id: 'of_retitre', fileName: '2026-01-05-nouveau-titre.md', markdown: '# Nouveau titre\n\nFri, 05 Jan 26\n\nTexte regenere.\n' },
      ctx(),
    );
    assert.equal(verdict, 'connu:id');
  });
});

describe('note ecartee (seen.json)', () => {
  test('--skip consigne l\'id, puis la note est ecartee sans etre relue', () => {
    assert.equal(classify({ id: 'of_ecarte', fileName: '2026-01-06-x.md' }, ctx()), null);
    assert.equal(addToRegistry(vault, 'of_ecarte', 'ecarte', '2026-01-06'), true);
    assert.equal(classify({ id: 'of_ecarte', fileName: '2026-01-06-x.md' }, ctx()), 'ecarte:registre');
  });
  test("consigner deux fois le meme id ne duplique pas l'entree", () => {
    assert.equal(addToRegistry(vault, 'of_ecarte', 'ecarte'), false);
    assert.equal(loadRegistry(vault).filter((e) => e.id === 'of_ecarte').length, 1);
  });
  test("le registre ne porte que id, domaine et date", () => {
    for (const e of loadRegistry(vault)) assert.deepEqual(Object.keys(e).sort(), ['date', 'domaine', 'id']);
  });
});

describe('note deja rangee dans un domaine, re-proposee', () => {
  test('raw/pro : connue, sans regarder le domaine que le tri lui donnerait', () => {
    put('raw/pro/meetings/2026-01-07-reunion-pro.md', BODY.replace('Point equipe', 'Reunion pro'));
    const md = BODY.replace('Point equipe', 'Reunion pro');
    assert.equal(classify({ id: 'of_pro', fileName: '2026-01-07-autre-nom.md', markdown: md }, ctx()), 'connu:contenu');
  });
  test('raw/perso : connue de la meme facon', () => {
    const md = OTHER.replace('Autre note', 'Reunion perso');
    put('raw/perso/meetings/2026-01-08-reunion-perso.md', md);
    assert.equal(classify({ id: 'of_perso', fileName: '2026-01-08-autre-nom.md', markdown: md }, ctx()), 'connu:contenu');
  });
  test("inbox/a-trancher : une note parquee n'est pas redeposee", () => {
    put('inbox/a-trancher/2026-01-09-parquee.md', withPlaudId('# Parquee\n\nSat, 09 Jan 26\n\nTexte.\n', 'of_parque'));
    assert.equal(classify({ id: 'of_parque', fileName: '2026-01-09-parquee.md' }, ctx()), 'connu:id');
  });
  test('une vraie nouveaute passe', () => {
    assert.equal(classify({ id: 'of_neuf', fileName: '2026-02-01-neuf.md', markdown: '# Neuf\n\nautre\n' }, ctx()), null);
  });
});

describe('amorcage : domaine du brut existant', () => {
  test('par contenu, puis par nom ; rien pour un fichier de inbox/', () => {
    const { known } = ctx();
    assert.equal(legacyDomain({ fileName: 'x.md', markdown: BODY }, known), 'perso');
    assert.equal(legacyDomain({ fileName: '2026-01-07-reunion-pro.md', markdown: undefined }, known), 'pro');
    put('inbox/2026-03-01-en-attente.md', '# En attente\n\nSun, 01 Mar 26\n\nTexte.\n');
    assert.equal(legacyDomain({ fileName: '2026-03-01-en-attente.md', markdown: undefined }, ctx().known), null);
    assert.equal(legacyDomain({ fileName: 'inconnu.md', markdown: '# Inconnu\n' }, known), null);
  });
});
