/**
 * Tests de lecture de l'or et du bronze : U1
 * `node --test tools/dashboard/vault-read.test.mjs`
 * Coffre factice dans un dossier temporaire, aucun fichier reel n'est lu.
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { beforeEach, afterEach, describe, test } from 'node:test';

import {
  readGoldTopologyAndIssues,
  readBronzeAndSilverStatus,
  TYPES,
} from './vault-read.mjs';
import { HOOKS_DIR } from '../test-vault.mjs';

const VAULT_HOOK = path.join(HOOKS_DIR, 'vault.mjs');

let vault;
const put = (rel, text) => {
  const file = path.join(vault, rel);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, text);
};

beforeEach(() => {
  vault = mkdtempSync(path.join(tmpdir(), 'vault-read-test-'));
  // vault.mjs lit les domaines dans la configuration du coffre (plan core/data, U4) : les deux d'aujourd'hui,
  // sans extension org, pour que l'audit compare exactement les categories que le dashboard calcule.
  put('kioku.config.json', JSON.stringify({ version: 1, domains: [{ id: 'pro' }, { id: 'perso' }] }));
});
afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
});

describe('U1 : Topologie et anomalies du gold', () => {
  test('deux pages liees : une arete, aucune cible absente', () => {
    put('wiki/pro/people/alice.md', '---\ntitle: Alice\ntype: person\ngate: passe 2026-09-20\n---\nTravaille sur [[projects/alpha]].\n');
    put('wiki/pro/projects/alpha.md', '---\ntitle: Projet Alpha\ntype: project\ngate: passe 2026-09-20\n---\nLead par [[people/alice]].\n');
    put('wiki/pro/index.md', '- [[people/alice]]\n- [[projects/alpha]]\n');

    const result = readGoldTopologyAndIssues(vault, 'pro');

    assert.equal(result.pages.size, 2);
    assert.equal(result.edges.length, 2);
    assert.equal(result.phantomNodes.length, 0);
    assert.equal(result.issues.actionable['lien-casse'].length, 0);
    assert.equal(result.issues.debt['lien-casse'].length, 0);
  });

  test('cible inexistante citee par une seule source : noeud fantome et lacune, pas d anomalie', () => {
    put('wiki/pro/people/bob.md', '---\ntitle: Bob\ntype: person\ngate: passe 2026-09-20\n---\nConnait [[concepts/unknown-concept]].\n');
    put('wiki/pro/index.md', '- [[people/bob]]\n');

    const result = readGoldTopologyAndIssues(vault, 'pro');

    assert.equal(result.phantomNodes.length, 1);
    assert.equal(result.phantomNodes[0].id, 'concepts/unknown-concept');
    assert.equal(result.phantomNodes[0].count, 1);
    assert.equal(result.phantomNodes[0].status, 'lacune');
    assert.equal(result.issues.actionable['lien-casse'].length, 0);
    assert.deepEqual(result.lacunes.map((l) => l.target), ['concepts/unknown-concept']);
  });

  test('§5.3 : une cible compte une fois par source, la paire source + meeting en fait une seule', () => {
    const src = 'sources/2026-09-01-point';
    put(`wiki/pro/${src}.md`, `---\ntitle: Point\ntype: source\ngate: passe 2026-09-20\n---\n[[people/zoe]] presente. Encore [[people/zoe]].\n*Réunion structurée : [[meetings/2026-09-01-point]]*\n`);
    put('wiki/pro/meetings/2026-09-01-point.md', `---\ntitle: Point\ntype: meeting\nsources: [[[${src}]]]\nparticipants: [[[people/zoe]]]\ngate: passe 2026-09-20\n---\nAvec [[people/zoe]].\n`);
    // Fiche aux sources multiples : la citation en ligne designe la source de la phrase
    put('wiki/pro/people/yann.md', `---\ntitle: Yann\ntype: person\nsources: [[[${src}]], [[sources/2026-09-02-autre]]]\ngate: passe 2026-09-20\n---\n- travaille avec [[people/zoe]] ^[[${src}]]\n`);
    put('wiki/pro/sources/2026-09-02-autre.md', '---\ntitle: Autre\ntype: source\ngate: passe 2026-09-20\n---\nRien.\n');
    put('wiki/pro/index.md', '');

    const result = readGoldTopologyAndIssues(vault, 'pro');

    assert.equal(result.issues.actionable['lien-casse'].length, 0);
    assert.equal(result.lacunes.length, 1);
    assert.deepEqual(result.lacunes[0].sources, [src]);
  });

  test('§5.3 : cible citee par deux sources distinctes : une anomalie par cible, pas par occurrence', () => {
    put('wiki/pro/sources/2026-09-01-a.md', '---\ntitle: A\ntype: source\ngate: passe 2026-09-20\n---\n[[concepts/zeta]] et [[concepts/zeta]].\n');
    put('wiki/pro/sources/2026-09-02-b.md', '---\ntitle: B\ntype: source\ngate: passe 2026-09-20\n---\n[[concepts/zeta]].\n');
    put('wiki/pro/index.md', '');

    const result = readGoldTopologyAndIssues(vault, 'pro');

    assert.equal(result.issues.actionable['lien-casse'].length, 1);
    assert.equal(result.issues.actionable['lien-casse'][0].target, 'concepts/zeta');
    assert.equal(result.lacunes.length, 0);
  });

  test('§5.3 : lien vers une page existante sous un autre nom (alias, titre, autre dossier) : anomalie', () => {
    put('wiki/pro/people/jean-dupont.md', '---\ntitle: Jean Dupont\ntype: person\naliases: [JD]\ngate: passe 2026-09-20\n---\nOk.\n');
    put('wiki/pro/projects/atlas.md', '---\ntitle: Atlas\ntype: project\ngate: passe 2026-09-20\n---\nOk.\n');
    put('wiki/pro/sources/2026-09-01-a.md', '---\ntitle: A\ntype: source\ngate: passe 2026-09-20\n---\n[[people/jd]], [[concepts/atlas]], [[people/jade]].\n');
    put('wiki/pro/index.md', '');

    const result = readGoldTopologyAndIssues(vault, 'pro');

    const anomalies = result.issues.actionable['lien-casse'].map((i) => i.target).sort();
    assert.deepEqual(anomalies, ['concepts/atlas', 'people/jd']);
    // Pas de rapprochement approche : « jade » n'est pas une coquille presumee de « jd »
    assert.deepEqual(result.lacunes.map((l) => l.target), ['people/jade']);
  });

  test('couvre AE2 : anomalie de page heritee et anomalie de page jugee (tri action vs dette)', () => {
    put('wiki/pro/sources/2026-09-01-c1.md', '---\ntitle: C1\ntype: source\n---\nVers [[concepts/absent-1]].\n'); // heritee
    put('wiki/pro/sources/2026-09-02-c2.md', '---\ntitle: C2\ntype: source\n---\nVers [[concepts/absent-1]].\n'); // heritee
    put('wiki/pro/people/charlie.md', '---\ntitle: Charlie\ntype: person\n---\nOk.\n'); // heritee
    put('wiki/pro/sources/2026-09-03-d1.md', '---\ntitle: D1\ntype: source\ngate: passe 2026-09-20\n---\nVers [[concepts/absent-2]].\n'); // jugee
    put('wiki/pro/people/diana.md', '---\ntitle: Diana\ntype: person\ngate: passe 2026-09-20\n---\nVers [[concepts/absent-2]].\n'); // jugee
    put('wiki/pro/index.md', '');

    const result = readGoldTopologyAndIssues(vault, 'pro');

    assert.equal(result.issues.actionable['lien-casse'].length, 1);
    assert.equal(result.issues.actionable['lien-casse'][0].target, 'concepts/absent-2');
    assert.equal(result.issues.debt['lien-casse'].length, 1);
    assert.equal(result.issues.debt['lien-casse'][0].target, 'concepts/absent-1');
    assert.equal(result.legacyPagesCount, 3);
    assert.equal(result.judgedPagesCount, 2);
  });

  test('couvre AE6 : dossier d entites vide, le type est absent sans erreur', () => {
    put('wiki/pro/people/elena.md', '---\ntitle: Elena\ntype: person\ngate: passe 2026-09-20\n---\nTexte simple.\n');
    put('wiki/pro/index.md', '- [[people/elena]]\n');

    const result = readGoldTopologyAndIssues(vault, 'pro');

    assert.equal(result.pages.size, 1);
    assert.equal(result.typesPresent.has('person'), true);
    assert.equal(result.typesPresent.has('decision'), false);
  });

  test('lien vers soi-meme : ni arete ni anomalie', () => {
    put('wiki/pro/people/felix.md', '---\ntitle: Felix\ntype: person\ngate: passe 2026-09-20\n---\nC est [[people/felix]].\n');
    put('wiki/pro/index.md', '- [[people/felix]]\n');

    const result = readGoldTopologyAndIssues(vault, 'pro');

    assert.equal(result.edges.length, 0);
    assert.equal(result.issues.actionable['lien-casse'].length, 0);
  });

  test('lien avec alias et barre echappee : cible extraite correctement', () => {
    put(
      'wiki/pro/meetings/2026-09-25-point.md',
      '---\ntitle: Point\ntype: meeting\ngate: passe 2026-09-20\n---\nVoir [[people/george|George]] et [[projects/beta\\|Beta]].\n'
    );
    put('wiki/pro/people/george.md', '---\ntitle: George\ntype: person\ngate: passe 2026-09-20\n---\nOk.\n');
    put('wiki/pro/projects/beta.md', '---\ntitle: Beta\ntype: project\ngate: passe 2026-09-20\n---\nOk.\n');
    put('wiki/pro/index.md', '- [[meetings/2026-09-25-point]]\n- [[people/george]]\n- [[projects/beta]]\n');

    const result = readGoldTopologyAndIssues(vault, 'pro');

    const targets = result.edges.map((e) => e.target);
    assert.ok(targets.includes('people/george'));
    assert.ok(targets.includes('projects/beta'));
    assert.equal(result.phantomNodes.length, 0);
  });

  test('frontmatter absent ou malforme : signale dans les issues, sans exception', () => {
    put('wiki/pro/people/broken.md', 'Pas de frontmatter ici.\n');
    put('wiki/pro/index.md', '- [[people/broken]]\n');

    const result = readGoldTopologyAndIssues(vault, 'pro');

    assert.equal(result.issues.actionable.frontmatter.length, 1);
    assert.equal(result.issues.actionable.frontmatter[0].sourceKey, 'people/broken');
  });

  test('fins de ligne CRLF \\r\\n lues a l identique de \\n', () => {
    put('wiki/pro/people/crlf.md', '---\r\ntitle: CRLF\r\ntype: person\r\ngate: passe 2026-09-20\r\n---\r\nLigne 1\r\nLigne 2\r\n');
    put('wiki/pro/index.md', '- [[people/crlf]]\r\n');

    const result = readGoldTopologyAndIssues(vault, 'pro');

    assert.equal(result.pages.size, 1);
    const p = result.pages.get('people/crlf');
    assert.equal(p.title, 'CRLF');
    assert.ok(!p.body.includes('\r'));
  });

  test('couvre KTD2 : sur coffre factice, compteurs egaux a vault.mjs audit', () => {
    // Preparer un coffre factice avec plusieurs categories d'anomalies
    put('wiki/pro/people/valid.md', '---\ntitle: Valid\ntype: person\ngate: passe 2026-09-20\n---\nLien vers [[people/orphan]] et [[perso/forbidden]].\n');
    put('wiki/pro/people/orphan.md', '---\ntitle: Orphan\ntype: person\ngate: passe 2026-09-20\n---\nOrpheline sans lien entrant (sauf depuis valid).\n');
    put('wiki/pro/people/bad-type.md', '---\ntitle: Bad Type\ntype: concept\ngate: passe 2026-09-20\n---\nType discord.\n');
    put('wiki/pro/projects/unindexed.md', '---\ntitle: Unindexed\ntype: project\ngate: passe 2026-09-20\n---\nPas dans index.\n');
    put('wiki/pro/index.md', '- [[people/valid]]\n- [[people/bad-type]]\n- [[people/ghost-in-index]]\n');

    const result = readGoldTopologyAndIssues(vault, 'pro');

    // Lancer vault.mjs audit pro sur le coffre factice
    const out = spawnSync(process.execPath, [VAULT_HOOK, 'audit', 'pro'], {
      env: { ...process.env, CLAUDE_PROJECT_DIR: vault },
      encoding: 'utf8',
    });
    assert.equal(out.status, 0, out.stderr);

    // Parser les sorties d'audit
    const parseAuditCount = (name) => {
      const m = out.stdout.match(new RegExp(`^${name} : (\\d+)`, 'm'));
      return m ? Number.parseInt(m[1], 10) : 0;
    };

    assert.equal(result.totalIssuesCount['type-dossier'], parseAuditCount('type-dossier'));
    assert.equal(result.totalIssuesCount['domaine-lien'], parseAuditCount('domaine-lien'));
    assert.equal(result.totalIssuesCount['hors-index'], parseAuditCount('hors-index'));
    assert.equal(result.totalIssuesCount['index-fantome'], parseAuditCount('index-fantome'));
  });

  test('couvre KTD2 et §5.3 : liens casses et lacunes egaux a vault.mjs audit', () => {
    put('wiki/pro/people/jean-dupont.md', '---\ntitle: Jean Dupont\ntype: person\naliases: [JD]\ngate: passe 2026-09-20\n---\nOk.\n');
    put('wiki/pro/sources/2026-09-01-a.md', '---\ntitle: A\ntype: source\ngate: passe 2026-09-20\n---\n[[concepts/zeta]] [[people/jd]] [[people/solo]]\n*Réunion structurée : [[meetings/2026-09-01-a]]*\n');
    put('wiki/pro/meetings/2026-09-01-a.md', '---\ntitle: A\ntype: meeting\nsources: [[[sources/2026-09-01-a]]]\ngate: passe 2026-09-20\n---\n[[people/solo]]\n');
    put('wiki/pro/sources/2026-09-02-b.md', '---\ntitle: B\ntype: source\n---\n[[concepts/zeta]]\n');
    put('wiki/pro/index.md', '');

    const result = readGoldTopologyAndIssues(vault, 'pro');
    const out = spawnSync(process.execPath, [VAULT_HOOK, 'audit', 'pro'], {
      env: { ...process.env, CLAUDE_PROJECT_DIR: vault },
      encoding: 'utf8',
    });
    assert.equal(out.status, 0, out.stderr);
    const count = (name) => Number.parseInt(out.stdout.match(new RegExp(`^${name}[^:]* : (\\d+)`, 'm'))?.[1] ?? 'NaN', 10);

    // zeta : deux sources ; jd : alias de jean-dupont ; solo : une seule source (paire source + meeting)
    assert.equal(result.totalIssuesCount['lien-casse'], 2);
    assert.equal(count('lien-casse'), 2);
    assert.equal(result.lacunes.length, 1);
    assert.equal(count('lacunes'), 1);
  });

  test('§5.3 : `sources:` en chemins bruts (sans wikilinks) rattache aussi la page a sa source', () => {
    const src = 'sources/2026-09-01-a';
    put(`wiki/perso/${src}.md`, '---\ntitle: A\ntype: source\ngate: passe 2026-09-20\n---\n[[concepts/hds]] [[organizations/itec]]\n*Réunion structurée : [[meetings/2026-09-01-a]]*\n');
    put('wiki/perso/meetings/2026-09-01-a.md', `---\ntitle: A\ntype: meeting\nsources: [${src}]\ngate: passe 2026-09-20\n---\n[[concepts/hds]]\n`);
    put('wiki/perso/organizations/residence.md', `---\ntitle: R\ntype: organization\nsources: ["${src}"]\ngate: passe 2026-09-20\n---\n[[organizations/itec]]\n`);
    put('wiki/perso/index.md', '');

    const result = readGoldTopologyAndIssues(vault, 'perso');
    const out = spawnSync(process.execPath, [VAULT_HOOK, 'audit', 'perso'], {
      env: { ...process.env, CLAUDE_PROJECT_DIR: vault },
      encoding: 'utf8',
    });
    assert.equal(out.status, 0, out.stderr);
    const count = (name) => Number.parseInt(out.stdout.match(new RegExp(`^${name}[^:]* : (\\d+)`, 'm'))?.[1] ?? 'NaN', 10);

    assert.equal(result.totalIssuesCount['lien-casse'], 0);
    assert.equal(count('lien-casse'), 0);
    assert.deepEqual(result.lacunes.map((l) => l.sources), [[src], [src]]);
    assert.equal(count('lacunes'), 2);
  });
});

describe('U1 : Suivi du bronze et de l argent', () => {
  test('source bronze citee par fiche argent mais aucune page or : comptage actionnable (en cours)', () => {
    put('raw/pro/meetings/2026-09-25-talk.md', 'Contenu brut\n');
    put('silver/pro/2026-09-25-talk.md', '---\nraw: meetings/2026-09-25-talk.md\ndomain: pro\n---\n');

    const res = readBronzeAndSilverStatus(vault, 'pro');

    assert.equal(res.actionableBronzeWithoutSilver.length, 0);
    assert.equal(res.actionableSilverWithoutGold.length, 1);
    assert.equal(res.actionableSilverWithoutGold[0].raw, 'raw/pro/meetings/2026-09-25-talk.md');
    assert.equal(res.debtBronzeCount, 0);
  });

  test('source bronze citee par page or : absente du resultat', () => {
    put('raw/pro/meetings/2026-09-24-ok.md', 'Contenu brut\n');
    put('silver/pro/2026-09-24-ok.md', '---\nraw: meetings/2026-09-24-ok.md\ndomain: pro\n---\n');
    put('wiki/pro/sources/2026-09-24-ok.md', '---\ntype: source\nraw: raw/pro/meetings/2026-09-24-ok.md\n---\n');

    const res = readBronzeAndSilverStatus(vault, 'pro');

    assert.equal(res.actionableBronzeWithoutSilver.length, 0);
    assert.equal(res.actionableSilverWithoutGold.length, 0);
    assert.equal(res.debtBronzeCount, 0);
  });

  test('couvre AE8, KTD3 : source bronze anterieure a l amorcage rejoint la dette', () => {
    put('silver/pro/heritage/_seed.json', JSON.stringify({ at: '2026-09-20T12:00:00.000Z', count: 10 }));
    // Source avant le 2026-09-20
    put('raw/pro/meetings/2026-06-15-old-meeting.md', 'Brut ancien\n');
    // Source apres le 2026-09-20
    put('raw/pro/meetings/2026-09-22-new-meeting.md', 'Brut recent\n');

    const res = readBronzeAndSilverStatus(vault, 'pro');

    assert.equal(res.debtBronzeCount, 1);
    assert.equal(res.debtBronzeFiles[0], 'raw/pro/meetings/2026-06-15-old-meeting.md');
    assert.equal(res.actionableBronzeWithoutSilver.length, 1);
    assert.equal(res.actionableBronzeWithoutSilver[0], 'raw/pro/meetings/2026-09-22-new-meeting.md');
  });

  test('coffre factice sans _seed.json : tout le bronze sans page or est actionnable, zero dette', () => {
    put('raw/pro/meetings/2026-01-10-talk.md', 'Brut quelconque\n');

    const res = readBronzeAndSilverStatus(vault, 'pro');

    assert.equal(res.debtBronzeCount, 0);
    assert.equal(res.actionableBronzeWithoutSilver.length, 1);
  });
});
