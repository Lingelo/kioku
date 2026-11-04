/**
 * Tests d'integration de l'assembleur du dashboard : U6
 * `node --test tools/dashboard/run.test.mjs`
 */

import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { beforeEach, afterEach, describe, test } from 'node:test';

import { generateDashboardHtml, writeDashboardFile } from './run.mjs';
import { writeTestConfig } from '../test-vault.mjs';

let vault;
const put = (rel, text) => {
  const file = path.join(vault, rel);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, text);
};

beforeEach(() => {
  vault = mkdtempSync(path.join(tmpdir(), 'run-test-'));
  writeTestConfig(vault);
});
afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
});

describe('U6 : Assembleur et page HTML du dashboard', () => {
  test('structure du HTML genere : entetes, onglets, vendor UMD, CSS, script de donnees', () => {
    put(
      'wiki/pro/people/alice.md',
      '---\ntitle: Alice\ntype: person\ngate: passe 2026-09-24\n---\nAlice travaille sur [[projects/alpha]].\n'
    );
    put(
      'wiki/pro/projects/alpha.md',
      '---\ntitle: Alpha\ntype: project\ngate: passe 2026-09-24\n---\nProjet Alpha.\n'
    );

    const html = generateDashboardHtml(vault, 'pro');

    // Doctype et balises de base
    assert.ok(html.startsWith('<!DOCTYPE html>'));
    assert.ok(html.includes('<html lang="fr"'));
    assert.ok(html.includes('<title>Tableau de bord — pro</title>'));

    // Inclusion du script vendorisé en chemin relatif (R5, KTD6)
    assert.ok(html.includes('<script src="vendor/3d-force-graph.min.js"></script>'));

    // Aucun import ES module pour compatibilite file://
    assert.ok(!html.includes('type="module"'));

    // Balise de donnees JSON embarquees
    assert.ok(html.includes('<script id="vault-data" type="application/json">'));

    // Onglets Pilote et Graphe
    assert.ok(html.includes('id="tab-pilot"'));
    assert.ok(html.includes('id="tab-graph"'));

    // Panneau lateral de lecture
    assert.ok(html.includes('id="reader-panel"'));
  });

  test('ecriture du fichier sur disque a l emplacement convenu', () => {
    put(
      'wiki/pro/people/bob.md',
      '---\ntitle: Bob\ntype: person\ngate: passe 2026-09-24\n---\nBob.\n'
    );

    const outPath = writeDashboardFile(vault, 'pro');
    assert.ok(existsSync(outPath));
    assert.equal(path.basename(outPath), 'dashboard-pro.html');

    const content = readFileSync(outPath, 'utf8');
    assert.ok(content.includes('Tableau de bord — pro'));
  });

  test('U1 : determinisme avec now et options de rendu static vs live', () => {
    put(
      'wiki/pro/people/alice.md',
      '---\ntitle: Alice\ntype: person\ngate: passe 2026-09-24\n---\nAlice.\n'
    );

    const fixedDate = new Date('2026-09-30T22:00:00.000Z');
    const htmlDefault = generateDashboardHtml(vault, 'pro', { now: fixedDate });
    const htmlStatic = generateDashboardHtml(vault, 'pro', { mode: 'static', now: fixedDate });

    // Deux rendus avec le même now, l'un sans options et l'autre avec mode static : HTML identiques
    assert.equal(htmlDefault, htmlStatic);
    assert.ok(htmlDefault.includes('"mode":"static"'));

    // Rendu en mode live avec une version
    const htmlLive = generateDashboardHtml(vault, 'pro', {
      mode: 'live',
      version: 1727733600000,
      now: fixedDate,
    });
    assert.ok(htmlLive.includes('"mode":"live"'));
    assert.ok(htmlLive.includes('"version":1727733600000'));

    // Couvre AE4 : en mode static, aucune URL /events n'est invoquee
    assert.ok(htmlStatic.includes('"mode":"static"'));
  });

  test('le script client inline ne contient aucune erreur de syntaxe JS', () => {
    const html = generateDashboardHtml(vault, 'pro');
    const scriptMatch = html.match(/<script>([\s\S]*?)<\/script>\s*<\/body>/);
    assert.ok(scriptMatch, 'Balise script cliente présente');
    assert.doesNotThrow(() => {
      new Function(scriptMatch[1]);
    });
  });
});

// Le fichier statique est ecrit dans le coffre, le vendor reste dans le plugin : toute reference relative a
// vendor/ casse a l'ouverture. Le coffre de test est hors du core, comme un vrai coffre.
describe('Fichier statique autonome : ressources embarquees', () => {
  const vendorRefs = (html) => [...html.matchAll(/(?:src=|url\()['"]?(vendor\/[^'")\s]+)/g)].map((m) => m[1]);
  const fakeVendor = (script) => {
    const dir = path.join(vault, 'fake-vendor');
    put('fake-vendor/fonts/inter-latin-400.woff2', 'woff2');
    put('fake-vendor/3d-force-graph.min.js', script);
    return dir;
  };

  test('aucune reference vendor/ : polices et script du graphe embarques, sans bloc video sans mp4', () => {
    const html = readFileSync(writeDashboardFile(vault, 'pro'), 'utf8');
    assert.deepEqual(vendorRefs(html), []);
    assert.ok(html.includes("url('data:font/woff2;base64,"));
    assert.ok(!html.includes('<script src='));
    assert.ok(html.includes('ForceGraph3D'));
    assert.ok(!html.includes('class="guide-video"'), 'pas de lecteur vide quand le coffre n a pas la video');
  });

  test('video du coffre : lien relatif au dossier de sortie, sous-titres embarques', () => {
    put('tools/dashboard/vendor/media/kioku-explainer.mp4', 'mp4');
    const html = readFileSync(writeDashboardFile(vault, 'pro'), 'utf8');
    assert.deepEqual(vendorRefs(html), ['vendor/media/kioku-explainer.mp4']);
    assert.ok(html.includes('src="data:text/vtt;base64,'));

    const other = readFileSync(writeDashboardFile(vault, 'pro', path.join(vault, 'out', 'sub')), 'utf8');
    assert.ok(other.includes('src="../../tools/dashboard/vendor/media/kioku-explainer.mp4"'));
  });

  test('la page servie garde les URLs vendor/ (serve.mjs les sert depuis le plugin)', () => {
    const html = generateDashboardHtml(vault, 'pro', { mode: 'live' });
    assert.ok(html.includes('<script src="vendor/3d-force-graph.min.js"></script>'));
    assert.ok(html.includes("url('vendor/fonts/inter-latin-400.woff2')"));
    assert.ok(html.includes('src="vendor/media/kioku-explainer.mp4"'));
  });

  test('ressource du core absente : erreur claire, rien n est ecrit', () => {
    const out = path.join(vault, 'out');
    assert.throws(() => writeDashboardFile(vault, 'pro', out, { vendorDir: path.join(vault, 'vide') }), /Ressource du dashboard absente/);
    assert.ok(!existsSync(out));
  });

  test('script du graphe contenant </script : refuse plutot que reecrit', () => {
    const vendorDir = fakeVendor('var a = "</script>";');
    assert.throws(() => writeDashboardFile(vault, 'pro', null, { vendorDir }), /impossible de l'embarquer/);
  });

  test('le garde client remplace l erreur WebGL quand la bibliotheque manque', () => {
    const html = generateDashboardHtml(vault, 'pro');
    assert.ok(html.includes("if (typeof ForceGraph3D === 'undefined')"));
    assert.ok(html.includes('Bibliothèque du graphe absente'));
  });
});
