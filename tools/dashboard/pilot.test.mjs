/**
 * Tests unitaires de l'onglet Pilote : U7 (R6, R7, R8, R9, R10, R11, R12, R13)
 * `node --test tools/dashboard/pilot.test.mjs`
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
  vault = mkdtempSync(path.join(tmpdir(), 'pilot-test-'));
  writeTestConfig(vault);
});
afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
});

describe('U7 : Onglet Pilote', () => {
  test('R6 : l onglet pilote est actif par defaut', () => {
    put('wiki/pro/people/alice.md', '---\ntitle: Alice\ntype: person\ngate: passe 2026-09-24\n---\nAlice.\n');
    const html = generateDashboardHtml(vault, 'pro');

    assert.ok(html.includes('id="btn-pilot" class="tab-btn active"'));
    assert.ok(html.includes('id="tab-pilot" class="tab-content active"'));
  });

  test('R7 : distinction bronze sans argent vs argent sans or', () => {
    // 1. Source bronze recente sans fiche argent
    put('raw/pro/meetings/2026-09-28-reunion-nouvelle.md', 'Brut.');
    // 2. Fiche argent sans page or
    put('silver/pro/fiche-en-attente.md', '---\nraw: raw/pro/meetings/2026-09-25-existante.md\n---\nArgent.');
    put('raw/pro/meetings/2026-09-25-existante.md', 'Brut existant.');

    const html = generateDashboardHtml(vault, 'pro');

    // Section medaillon presente
    assert.ok(html.includes('Suivi de l\'ingestion (Médaillon)'));
    assert.ok(html.includes('Bronze sans fiche Argent'));
    assert.ok(html.includes('Argent en attente du Gold'));

    // Verification des items
    assert.ok(html.includes('2026-09-28-reunion-nouvelle.md'));
    assert.ok(html.includes('fiche-en-attente'));
  });

  test('R9 : separation nette anomalies exploitables vs dette technique avec les 3 compteurs bronze', () => {
    // Page heritee (dette) avec un lien mort : cible citee par deux sources heritees (§5.3)
    put('wiki/pro/people/ancien.md', '---\ntitle: Ancien\ntype: person\n---\nLien vers [[people/inconnu]].\n');
    put('wiki/pro/people/ancien-2.md', '---\ntitle: Ancien 2\ntype: person\n---\nLien vers [[people/inconnu]].\n');

    // Sources bronze anterieures au seed (dette)
    put('silver/pro/heritage/_seed.json', JSON.stringify({ at: '2026-09-20' }));
    put('raw/pro/meetings/2026-06-01-reunion-ancienne.md', 'Reunion 1');
    put('raw/pro/articles/2026-06-02-article-ancien.md', 'Article 1');
    put('raw/pro/pdfs/2026-06-03-doc-ancien.pdf', 'Doc 1');

    const html = generateDashboardHtml(vault, 'pro');

    // Titres de blocs distincts
    assert.ok(html.includes('Anomalies exploitables'));
    assert.ok(html.includes('Dette technique (Fonds hérité)'));

    // Verification des valeurs exactes des compteurs de la dette
    assert.ok(html.includes('Pages d\'or héritées sans gate'));
    assert.ok(
      html.includes(
        '<td>Pages d\'or héritées sans gate</td>\n              <td style="text-align: right; font-weight: 600;">2</td>'
      )
    );
    assert.ok(html.includes('Cibles fantômes issues de l\'hérité'));
    // legacyDeadLinksCount doit etre 1 (non 0 silencieusement)
    assert.ok(
      html.includes(
        '<td>Cibles fantômes issues de l\'hérité</td>\n              <td style="text-align: right; font-weight: 600;">1</td>'
      )
    );

    // 3 compteurs dedies au bronze anterieur (arbitrage utilisateur)
    assert.ok(
      html.includes(
        '<td>Réunions brutes antérieures au seed sans page or</td>\n              <td style="text-align: right; font-weight: 600;">1</td>'
      )
    );
    assert.ok(
      html.includes(
        '<td>Articles bruts antérieurs au seed sans page or</td>\n              <td style="text-align: right; font-weight: 600;">1</td>'
      )
    );
    assert.ok(
      html.includes(
        '<td>Autres bruts antérieurs au seed sans page or</td>\n              <td style="text-align: right; font-weight: 600;">1</td>'
      )
    );
  });

  test('R10 & R11 : quarantaine avec commande de decision prete a copier sans recopie de texte sensible', () => {
    put(
      'quarantine/pro/incident-1.json',
      JSON.stringify({
        code: 'diffamation',
        note: 'Remarque a arbitrer',
        target: 'wiki/pro/people/cadre.md',
      })
    );
    put('quarantine/pro/incident-1.md', 'TEXTE TRES CONFIDENTIEL QUI NE DOIT PAS APPARAITRE DANS LE DASHBOARD');

    const html = generateDashboardHtml(vault, 'pro');

    assert.ok(html.includes('incident-1'));
    assert.ok(html.includes('diffamation'));
    assert.ok(html.includes('kioku decide pro incident-1 drop'));
    assert.ok(html.includes('Copier'));

    // R11 : Jamais de texte sensible recopié
    assert.ok(!html.includes('TEXTE TRES CONFIDENTIEL'));
  });

  test('R12 & R13 : etats locaux clairement badges comme machine locale avec tri-state', () => {
    put('wiki/pro/people/alice.md', '---\ntitle: Alice\ntype: person\ngate: passe 2026-09-24\n---\nAlice.\n');
    const html = generateDashboardHtml(vault, 'pro');

    // Badge visible
    assert.ok(html.includes('PORTÉE : MACHINE LOCALE (NON SYNCHRONISÉ)'));

    // En l'absence de fichiers d'etat, distinction "Non initialisé" / "Inconnu" (jamais 0 silencieux)
    assert.ok(html.includes('Non initialisé'));
  });

  test('R1, R2, R3 : frise lineaire du pipeline Medaillon avec les 4 etapes connectees et compteurs dynamiques (AE1)', () => {
    // 1. Bronze : 2 sources
    put('raw/pro/meetings/2026-09-28-source1.md', 'Source brute 1.');
    put('raw/pro/meetings/2026-09-28-source2.md', 'Source brute 2.');

    // 2. Argent : 1 fiche pour source1 (source2 est sans fiche argent)
    put('silver/pro/fiche-1.md', '---\nraw: raw/pro/meetings/2026-09-28-source1.md\n---\nArgent 1.');

    // 3. Gate & Quarantaine : 1 candidate et 1 quarantaine
    put('.candidats/wiki/pro/people/bob.md', '---\ntitle: Bob\ntype: person\n---\nBob en attente.\n');
    put(
      'quarantine/pro/hold-1.json',
      JSON.stringify({ code: 'sensible', note: 'A revoir', target: 'wiki/pro/people/charlie.md' })
    );

    // 4. Or : 2 pages vivantes jugées, mutuellement liées et indexées, sans anomalie
    put('wiki/pro/people/alice.md', '---\ntitle: Alice\ntype: person\ngate: passe 2026-09-24\n---\nVoir [[projects/alpha]].\n');
    put('wiki/pro/projects/alpha.md', '---\ntitle: Alpha\ntype: project\ngate: passe 2026-09-24\n---\nVoir [[people/alice]].\n');
    put('wiki/pro/index.md', '- [[people/alice]] — Page Alice\n- [[projects/alpha]] — Projet Alpha\n');

    const html = generateDashboardHtml(vault, 'pro');

    // Présence de la frise et des 4 étapes médaillon
    assert.ok(html.includes('class="medallion-frise"'));
    assert.ok(html.includes('1. Bronze (Brut)'));
    assert.ok(html.includes('2. Argent (Fiches)'));
    assert.ok(html.includes('3. Gate & Quarantaine'));
    assert.ok(html.includes('4. Or (Wiki vivant)'));
    assert.ok(html.includes('data-filter-stage="bronze"'));
    assert.ok(html.includes('data-filter-stage="silver"'));
    assert.ok(html.includes('data-filter-stage="gate"'));
    assert.ok(html.includes('data-filter-stage="gold"'));

    // Assertions dynamiques des metriques et statuts (AE1)
    // Bronze : 2 total, 1 sans fiche argent
    assert.ok(html.includes('class="flow-badge status-warning">1 sans fiche argent</span>'));
    // Argent : 1 total, 1 en attente gold
    assert.ok(html.includes('class="flow-badge status-warning">1 en attente gold</span>'));
    // Gate : 2 en attente (1 quarantaine + 1 candidate)
    assert.ok(html.includes('class="flow-badge status-held">1 en quarantaine</span>'));
    // Gold : 2 pages or vivantes, 0 anomalie
    assert.ok(html.includes('class="flow-badge status-ok">✓ Zéro anomalie</span>'));
  });

  test('frise : chiffres coherents (bronze relie / herite / a faire, gate sans pourcentage invente, or en sources + entites)', () => {
    put('silver/pro/heritage/_seed.json', JSON.stringify({ at: '2026-09-20' }));
    // Bronze : 1 relie a l'or, 1 relie a l'argent, 2 herites (avant amorcage), 1 a faire
    put('raw/pro/meetings/2026-09-25-reliee-or.md', 'Brut.');
    put('raw/pro/meetings/2026-09-26-reliee-argent.md', 'Brut.');
    put('raw/pro/meetings/2026-06-01-ancienne-a.md', 'Brut.');
    put('raw/pro/meetings/2026-06-02-ancienne-b.md', 'Brut.');
    put('raw/pro/meetings/2026-10-01-nouvelle.md', 'Brut.');
    put('silver/pro/2026-09-26-reliee-argent.md', '---\nraw: meetings/2026-09-26-reliee-argent.md\n---\nArgent.');
    put('wiki/pro/sources/2026-09-25-reliee-or.md', '---\ntype: source\ntitle: S\nraw: meetings/2026-09-25-reliee-or.md\ngate: passe 2026-09-25\n---\nVoir [[people/alice]].\n');
    put('wiki/pro/people/alice.md', '---\ntitle: Alice\ntype: person\ngate: passe 2026-09-24\n---\nVoir [[sources/2026-09-25-reliee-or]].\n');
    // Gate : une quarantaine, aucune candidate
    put('quarantine/pro/hold-1.json', JSON.stringify({ code: 'sensible', target: 'wiki/pro/people/x.md' }));

    const html = generateDashboardHtml(vault, 'pro');

    // Bronze : 5 au total, la repartition se lit, le pourcentage ne compte pas l'herite comme traite
    assert.match(html, /2 reliés · 2 hérités · 1 à faire/);
    assert.match(html, /<span title="[^"]*">40%<\/span>/, 'bronze : 2 relies sur 5');
    // Gate : pas de plancher a 10 %, pas de pourcentage
    assert.match(html, /1 quarantaine · 0 candidate/);
    assert.doesNotMatch(html, />10%</);
    // Or : sources et entites separees
    assert.match(html, /1 source · 1 entité/);
  });

  test('R4, R5, R6 : file de triage haute densite avec pills CLI et copie sans alert()', () => {
    put('raw/pro/meetings/2026-09-28-source.md', 'Source brute nouvelle.');
    const html = generateDashboardHtml(vault, 'pro');

    // Présence du conteneur de triage haute densité et des filtres
    assert.ok(html.includes('class="triage-container"'));
    assert.ok(html.includes('class="triage-filters"'));
    assert.ok(html.includes('class="cli-pill"'));
    assert.ok(html.includes('class="copy-pill-btn"'));

    // Vérification de la syntaxe onclick et data-cmd (P0/P1 non-regression)
    assert.ok(html.includes('onclick="copyCmd(this)"'));
    assert.ok(html.includes('data-cmd="npm run ingest:pro -- &quot;/ingest meetings/2026-09-28-source.md&quot;"'));

    // Absence stricte d'appel alert() bloquant pour la copie
    assert.ok(!html.includes("alert('Commande copiée"));
    assert.ok(!html.includes('alert('));
  });

  test('AE2 & R4 : file de triage vide affiche le message de conformite sans liste', () => {
    // Coffre 100% conforme sans aucune anomalie ni source en attente
    put('wiki/pro/people/alice.md', '---\ntitle: Alice\ntype: person\ngate: passe 2026-09-24\n---\nVoir [[projects/alpha]].\n');
    put('wiki/pro/projects/alpha.md', '---\ntitle: Alpha\ntype: project\ngate: passe 2026-09-24\n---\nVoir [[people/alice]].\n');
    put('wiki/pro/index.md', '- [[people/alice]] — Page Alice\n- [[projects/alpha]] — Projet Alpha\n');

    const html = generateDashboardHtml(vault, 'pro');

    // Carte d'état vide conforme
    assert.ok(html.includes('✓ Aucune action immédiate requise'));
    assert.ok(html.includes('Toutes les sources bronze sont traitées'));
    assert.ok(!html.includes('class="triage-list"'));
    assert.ok(html.includes('id="triage-count-badge" class="badge-count">0 action</span>'));
  });

  test('R4, R5, R6 & KTD4 : ordonnancement strict de la file de triage par criticite decroissante et attributs data-stage', () => {
    // 1. Quarantaine (Critique)
    put(
      'quarantine/pro/hold-1.json',
      JSON.stringify({ code: 'diffamation', note: 'Arbitrage requis', target: 'wiki/pro/people/pers.md' })
    );
    // 2. Candidate Gate (Haute)
    put('.candidats/wiki/pro/people/cand.md', '---\ntitle: Cand\ntype: person\n---\nCandidate.\n');
    // 3. Bronze sans argent (Normale)
    put('raw/pro/meetings/2026-09-28-nouvelle.md', 'Nouvelle réunion.');
    // 4. Argent sans gold (Normale)
    put('silver/pro/fiche-attente.md', '---\nraw: raw/pro/meetings/2026-09-20-existante.md\n---\nFiche argent.');
    put('raw/pro/meetings/2026-09-20-existante.md', 'Source existante.');
    // 5. Anomalie Gold actionable (Avertissement) : page jugée avec lien cassé
    put(
      'wiki/pro/people/alice.md',
      '---\ntitle: Alice\ntype: person\ngate: passe 2026-09-24\n---\nLien vers [[people/inconnu]].\n'
    );
    put('wiki/pro/index.md', '- [[people/alice]] — Page Alice\n');

    const html = generateDashboardHtml(vault, 'pro');

    // Vérification de la présence de tous les niveaux
    const posCrit = html.indexOf('severity-critical');
    const posHigh = html.indexOf('severity-high');
    const posNorm = html.indexOf('severity-normal');
    const posWarn = html.indexOf('severity-warning');

    assert.ok(posCrit !== -1, 'severity-critical doit exister');
    assert.ok(posHigh !== -1, 'severity-high doit exister');
    assert.ok(posNorm !== -1, 'severity-normal doit exister');
    assert.ok(posWarn !== -1, 'severity-warning doit exister');

    // Ordonnancement strict dans le DOM généré
    assert.ok(posCrit < posHigh, 'Critical doit précéder High');
    assert.ok(posHigh < posNorm, 'High doit précéder Normal');
    assert.ok(posNorm < posWarn, 'Normal doit précéder Warning');

    // Vérification des attributs data-stage sur chaque type d'item
    assert.ok(html.includes('data-stage="gate" data-severity="critical"'));
    assert.ok(html.includes('data-stage="gate" data-severity="high"'));
    assert.ok(html.includes('data-stage="bronze" data-severity="normal"'));
    assert.ok(html.includes('data-stage="silver" data-severity="normal"'));
    assert.ok(html.includes('data-stage="gold" data-severity="warning"'));
  });

  test('R7 & KTD2 : autonomie totale et zero dependance reseau externe (pas de CDN ni polices distantes)', () => {
    put('wiki/pro/people/alice.md', '---\ntitle: Alice\ntype: person\ngate: passe 2026-09-24\n---\nAlice.\n');
    const html = generateDashboardHtml(vault, 'pro');

    // Pas de polices externes Google Fonts ou Typekit
    assert.ok(!html.includes('fonts.googleapis.com'));
    assert.ok(!html.includes('fonts.gstatic.com'));
    assert.ok(!html.includes('@import url'));

    // Pas de CDN pour les scripts ou feuilles de style
    assert.ok(!html.includes('cdnjs.cloudflare.com'));
    assert.ok(!html.includes('cdn.jsdelivr.net'));
    assert.ok(!html.includes('unpkg.com'));

    // Meme garantie en mode live
    const htmlLive = generateDashboardHtml(vault, 'pro', { mode: 'live', version: 1000 });
    assert.ok(!htmlLive.includes('fonts.googleapis.com'));
    assert.ok(!htmlLive.includes('cdnjs.cloudflare.com'));
  });

  test('U1 & KTD8 : securite XSS et echappement des donnees piegees dans la file de triage', () => {
    // Note de quarantaine contenant une balise hostile
    put(
      'quarantine/pro/piege-note.json',
      JSON.stringify({
        at: '2026-09-30',
        code: 'sensible',
        note: '<img src=x onerror=alert(1)> Note sensible',
        target: 'wiki/pro/people/test.md',
      })
    );

    // Page avec wikilink piege
    put(
      'wiki/pro/people/malveillant.md',
      '---\ntitle: Malveillant\ntype: person\ngate: passe 2026-09-24\n---\nVoir [[x"><svg onload=1>]].\n'
    );
    put('wiki/pro/index.md', '- [[people/malveillant]] — Test\n');

    const html = generateDashboardHtml(vault, 'pro');

    // Le HTML ne doit contenir aucune balise executee brute
    assert.ok(!html.includes('<img src=x onerror=alert(1)>'));
    assert.ok(html.includes('&lt;img src=x onerror=alert(1)&gt;'));
    assert.ok(!html.includes('<svg onload=1>'));
    assert.ok(html.includes('&quot;&gt;&lt;svg onload=1&gt;'));

    // Securite XSS dans le graphe 3D : nodeLabel doit echapper d.title
    assert.ok(html.includes("escapeHtml(d.title || d.id || '')"));
  });

  test('U4, R5, R8 & KTD4 : bandeau de notification de modification et absence de reseau externe', () => {
    put('wiki/pro/people/alice.md', '---\ntitle: Alice\ntype: person\ngate: passe 2026-09-24\n---\nAlice.\n');

    // 1. Mode statique : le bandeau est masque par defaut, EventSource est conditionne au mode live hors file://
    const htmlStatic = generateDashboardHtml(vault, 'pro');
    assert.ok(htmlStatic.includes('id="update-banner"'));
    assert.ok(htmlStatic.includes('style="display: none;"'));
    assert.ok(htmlStatic.includes('window.location.reload()'));
    assert.ok(htmlStatic.includes("rawData.mode !== 'live'"));

    // 2. Mode live : le chemin /events est relatif (jamais d'URL absolue http(s)://)
    const htmlLive = generateDashboardHtml(vault, 'pro', { mode: 'live', version: 1000 });
    assert.ok(htmlLive.includes("new EventSource('/events')"));
    assert.ok(!htmlLive.includes("new EventSource('http://"));
    assert.ok(!htmlLive.includes("new EventSource('https://"));
  });

  test('R10 & KTD6 : dette technique repliee dans details class="tech-debt-details"', () => {
    put('wiki/pro/people/ancien.md', '---\ntitle: Ancien\ntype: person\n---\nAncien.\n');
    const html = generateDashboardHtml(vault, 'pro');

    assert.ok(html.includes('<details class="tech-debt-details">'));
    assert.ok(html.includes('<summary class="tech-debt-summary">'));
    // Doit être replié par défaut (pas d'attribut open)
    assert.ok(!html.includes('<details class="tech-debt-details" open>'));
  });

  test('U3, R5, R6, R7, AE2, AE3 : verification des actions de file et absence de metriques inventees', () => {
    put('wiki/pro/people/alice.md', '---\ntitle: Alice\ntype: person\ngate: passe 2026-09-24\n---\nAlice.\n');
    const html = generateDashboardHtml(vault, 'pro');

    // AE2, R5 : Aucune métrique inventée par la maquette
    assert.ok(!html.includes('GraphRAG'));
    assert.ok(!html.includes('fiches/sec'));
    assert.ok(!html.includes('Index daemon'));
    assert.ok(!html.includes('cluster-eu-west'));
    assert.ok(!html.includes('v2.4.1-prod'));

    // R6, R7 : Boutons d'en-tête de file copiant la vraie commande plaud:sync
    assert.ok(html.includes('data-cmd="npm run plaud:sync"'));
    assert.ok(html.includes('Exécuter pipeline'));
    assert.ok(html.includes('Nouvelle capture'));

    // R1 : Barres de progression présentes dans les cartes médaillon
    assert.ok(html.includes('class="stage-progress-bar"'));
    assert.ok(html.includes('class="stage-progress-fill"'));

    // U5 : Logo SVG inline
    assert.ok(html.includes('class="brand-logo"'));
    assert.ok(html.includes('viewBox="0 0 40 40"'));
    assert.ok(!html.includes('googleusercontent'));
  });
});
