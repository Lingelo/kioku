/**
 * Tests unitaires de l'onglet Graphe 3D et panneau de lecture : U8
 * `node --test tools/dashboard/graph.test.mjs`
 */

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { beforeEach, afterEach, describe, test } from 'node:test';

import { generateDashboardHtml } from './run.mjs';
import { writeTestConfig } from '../test-vault.mjs';

let vault;
const put = (rel, text) => {
  const file = path.join(vault, rel);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, text);
};

beforeEach(() => {
  vault = mkdtempSync(path.join(tmpdir(), 'graph-test-'));
  writeTestConfig(vault);
});
afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
});

describe('U8 : Onglet Graphe 3D et panneau de lecture', () => {
  test('R15, R16, R17 : conteneur 3D, script vendor UMD et gestionnaire de simulation a ressorts', () => {
    put('wiki/pro/people/alice.md', '---\ntitle: Alice\ntype: person\ngate: passe 2026-09-24\n---\nAlice.\n');
    put('wiki/pro/projects/alpha.md', '---\ntitle: Alpha\ntype: project\ngate: passe 2026-09-24\n---\nAlpha cite [[people/alice]].\n');

    const html = generateDashboardHtml(vault, 'pro');

    // Conteneur 3D et bibliotheque UMD locale (R5, R15)
    assert.ok(html.includes('id="graph-container"'));
    assert.ok(html.includes('<script src="vendor/3d-force-graph.min.js"></script>'));

    // Coloration et simulation (R16, R17) : le rechauffement pendant le drag puis le
    // refroidissement sont faits par 3d-force-graph. graphInstance.d3AlphaTarget n'existe pas
    // sur l'instance : l'appeler depuis onNodeDrag/onNodeDragEnd laissait le drag accroche.
    assert.ok(html.includes('ForceGraph3D'));
    assert.ok(!html.includes('graphInstance.d3AlphaTarget('));
    assert.ok(html.includes('folderColors'));

    // Fin de drag : le pointerup synthetique de la bibliotheque est ignore par les OrbitControls
    assert.ok(html.includes('navControls._onPointerUp'));
    assert.ok(html.includes('!e.isTrusted'));
  });

  test('R18, R19, R20 : panneau lateral de lecture avec rendu HTML et bouton de fermeture', () => {
    put(
      'wiki/pro/people/bob.md',
      '---\ntitle: Bob Martin\ntype: person\ngate: passe 2026-09-24\n---\nBob est lead tech sur **Atlas**.\n'
    );

    const html = generateDashboardHtml(vault, 'pro');

    // Panneau lateral et bouton fermer (R18, R19)
    assert.ok(html.includes('id="reader-panel"'));
    assert.ok(html.includes('id="reader-title"'));
    assert.ok(html.includes('id="reader-body"'));
    assert.ok(html.includes('closeReaderPanel()'));

    // R20 : Le contenu pre-rendu est integre dans les donnees avec balises HTML lisibles (strong autour de Atlas)
    assert.ok(html.includes('strong>Atlas'));
  });

  test('R21, R22 : wikilinks dans le panneau de lecture avec resolution et cibles absentes', () => {
    put(
      'wiki/pro/people/charlie.md',
      '---\ntitle: Charlie\ntype: person\ngate: passe 2026-09-24\n---\nCharlie connait [[people/alice]] et [[people/fantome|Inconnu]].\n'
    );
    put('wiki/pro/people/alice.md', '---\ntitle: Alice\ntype: person\ngate: passe 2026-09-24\n---\nAlice.\n');

    const html = generateDashboardHtml(vault, 'pro');

    // Lien valide resolu
    assert.ok(html.includes('class=\\"wikilink\\" data-target=\\"people/alice\\"'));
    // Lien fantome / cible inexistante (R22)
    assert.ok(html.includes('class=\\"wikilink wikilink-broken\\"'));
    // Gestionnaire de focus de noeud au clic sur un wikilink (R21)
    assert.ok(html.includes('focusNodeInGraph'));
  });

  test('Routes dans le hash et rechargement a chaud par identifiant de demarrage', () => {
    const html = generateDashboardHtml(vault, 'pro');
    // Routes : pas de regex dans le script (les antislashs seraient consommes par la chaine template)
    assert.ok(html.includes("const ROUTE_TO_TAB = { pilote: 'pilot', graphe: 'graph', guide: 'guide', question: 'question' }"));
    assert.ok(html.includes("window.addEventListener('hashchange', applyRoute)"));
    assert.ok(html.includes("href=\"#/page/'"));
    assert.ok(html.includes('decodeURIComponent(h)'));
    // Rechargement : un autre boot recu par SSE recharge la page, sous node --watch seulement
    assert.ok(html.includes('data.boot !== firstBoot'));
    assert.ok(html.includes('if (data.dev === true) {'));
    assert.ok(html.includes('window.location.reload()'));
    // Rendu WebGL suspendu hors de l'onglet graphe
    assert.ok(html.includes("document.addEventListener('visibilitychange', syncGraphAnimation)"));
    assert.ok(html.includes('graphInstance.pauseAnimation()'));
  });

  test('Ergonomie : recherche avec noeuds relies et securite de relachement du drag', () => {
    put('wiki/pro/projects/atlas.md', '---\ntitle: Atlas\ntype: project\ngate: passe 2026-09-24\n---\nProjet Atlas.\n');

    const html = generateDashboardHtml(vault, 'pro');

    // Option de recherche avec noeuds relies
    assert.ok(html.includes('id="include-neighbors"'));
    assert.ok(html.includes('neighborIds'));
    assert.ok(html.includes('isNeighbor'));
    assert.ok(html.includes('[relié]'));

    // Filets de securite pour le relachement garanti du drag
    assert.ok(html.includes('setPointerCapture'));
    assert.ok(html.includes('releasePointerCapture'));
    assert.ok(html.includes('window.addEventListener(\'pointerup\''));

    // Mise en valeur du noeud focus (token --graph-focus, cuivre akagane) et centrage avec prise en compte du panneau lateral
    assert.ok(html.includes('focusedNodeId'));
    assert.ok(html.includes('--graph-focus'));
    assert.ok(html.includes('graphPalette.focus'));
    assert.ok(html.includes('recenterOnActiveNode'));
    assert.ok(html.includes('offsetRatio'));
  });

  test('Mode d\'emploi de la KB : onglet guide, architecture medaillon et commandes', () => {
    put('wiki/pro/projects/atlas.md', '---\ntitle: Atlas\ntype: project\ngate: passe 2026-09-24\n---\nProjet Atlas.\n');

    const html = generateDashboardHtml(vault, 'pro');

    // Bouton de navigation et conteneur de l'onglet guide
    assert.ok(html.includes('id="btn-guide"'));
    assert.ok(html.includes('switchTab(\'guide\')'));
    assert.ok(html.includes('id="tab-guide"'));

    // Contenu pedagogique : medaillon (bronze, argent, or) et regles de la gate
    assert.ok(html.includes('Architecture Médaillon'));
    assert.ok(html.includes('raw/pro/'));
    assert.ok(html.includes('silver/pro/'));
    assert.ok(html.includes('wiki/pro/'));
    assert.ok(html.includes('Portrait vs Retour de travail'));
    assert.ok(html.includes('npm run pro'));
  });

  test('U4, R9, R10, R11, R12 : palette de recherche modale, bascule 2D/3D et zoom', () => {
    put(
      'wiki/pro/concepts/adk.md',
      '---\ntitle: Agent Development Kit\ntype: concept\ngate: passe 2026-09-24\nupdated: 2026-09-28\naliases: ["ADK", "Kit Agent"]\n---\nADK.\n'
    );
    put('wiki/pro/index.md', '- [[concepts/adk]] — ADK\n');

    const html = generateDashboardHtml(vault, 'pro');

    // R9, KTD4 : Palette de recherche globale modale
    assert.ok(html.includes('id="search-palette"'));
    assert.ok(html.includes('id="search-palette-input"'));
    assert.ok(html.includes('openSearchPalette()'));
    assert.ok(html.includes('closeSearchPalette()'));

    // R10, KTD3 : 1-hop depth
    assert.ok(html.includes('id="include-neighbors"'));
    assert.ok(html.includes('is1HopActive'));

    // R11, R12 : Bascule 2D / 3D et zoom
    assert.ok(html.includes('id="btn-toggle-2d"'));
    assert.ok(html.includes('toggle2D()'));
    assert.ok(html.includes('zoomIn()'));
    assert.ok(html.includes('zoomOut()'));
    assert.ok(html.includes('resetGraphView()'));
  });

  test('U4, R13, AE7 : metadonnees topologie completes et inspecteur sans fausse date si updated manque', () => {
    // 1. Page recente avec updated et aliases
    put(
      'wiki/pro/concepts/test-updated.md',
      '---\ntitle: Test\ntype: concept\ngate: passe 2026-09-24\nupdated: 2026-09-29\naliases: ["MonAlias"]\n---\nTest.\n'
    );
    // 2. Page heritee sans gate ni updated (AE7)
    put(
      'wiki/pro/people/ancien.md',
      '---\ntitle: Ancien\ntype: person\n---\nAncien.\n'
    );
    put('wiki/pro/index.md', '- [[concepts/test-updated]]\n- [[people/ancien]]\n');

    const html = generateDashboardHtml(vault, 'pro');

    // Verification dans le script de donnees que les champs sont bien serialises
    assert.ok(html.includes('"aliases":["MonAlias"]'));
    assert.ok(html.includes('"updated":"2026-09-29"'));
    assert.ok(html.includes('"gate":"passe 2026-09-24"'));

    // Pour l'ancien sans updated, la valeur vaut null
    assert.ok(html.includes('"updated":null'));

    // AE7 : Le script de l'inspecteur ne doit afficher la mention de mise à jour que si updated existe
    assert.ok(html.includes("if (node.updated)"));
    assert.ok(html.includes("Mis à jour le ' + escapeHtml(node.updated)"));
  });
});
