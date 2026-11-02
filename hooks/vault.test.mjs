/**
 * Tests de la gate : verdict lie au domaine, stage, et rotation du journal.
 * `node --test hooks/vault.test.mjs`
 * Coffre factice dans un dossier temporaire, aucun fichier reel n'est lu (sauf l'agent relecteur et les regles
 * de domaine, dont on verifie la forme, jamais le contenu metier).
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';

const VAULT_HOOK = path.resolve('hooks/vault.mjs');
const AGENTS = path.resolve('agents');
const DOMAIN_RULES = path.resolve('domains');

let vault;
const put = (rel, text) => {
  const file = path.join(vault, rel);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, text);
};
const run = (...args) =>
  spawnSync(process.execPath, [VAULT_HOOK, ...args], { cwd: vault, env: { ...process.env, CLAUDE_PROJECT_DIR: vault }, encoding: 'utf8' });
const concept = (domain) => {
  const rel = `.candidats/wiki/${domain}/concepts/zeta.md`;
  put(rel, '---\ntype: concept\ntitle: Zeta\ncreated: 2026-10-03\nupdated: 2026-10-03\n---\n\n## Vue d\'ensemble\n\nRien.\n');
  return rel;
};

// Registre des organisations du coffre factice (CLAUDE.md §1) : employeur acme, client actif globex (noms fictifs).
const REGISTRY = {
  employer: 'acme',
  orgs: [
    { id: 'acme', name: 'ACME', role: 'employer' },
    { id: 'globex', name: "Globex d'Or", role: 'client', status: 'active' },
  ],
  org_required: false,
};
const REGISTRY_PATH = 'hooks/orgs.json';
const registry = (over = {}) => put(REGISTRY_PATH, JSON.stringify({ ...REGISTRY, ...over }));
// Configuration du coffre factice : les deux domaines d'aujourd'hui, extension org sur pro (KTD4).
const CONFIG = {
  version: 1,
  domains: [{ id: 'pro', extensions: { org: { registry: REGISTRY_PATH } } }, { id: 'perso' }],
};
const config = (data = CONFIG) => put('kioku.config.json', JSON.stringify(data));

beforeEach(() => {
  // realpath : sous macOS, tmpdir() passe par le lien /var -> /private/var, et vault.mjs compare des chemins resolus
  vault = realpathSync(mkdtempSync(path.join(tmpdir(), 'vault-gate-test-')));
  config();
  registry();
});
afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
});

describe('un relecteur generique, des regles par domaine', () => {
  const reviewer = () => readFileSync(path.join(AGENTS, 'reviewer.md'), 'utf8');

  test('l agent porte le socle et renvoie aux regles du domaine, sans regle d un domaine nomme', () => {
    const text = reviewer();
    assert.match(text, /<!-- socle:debut -->[\s\S]*?<!-- socle:fin -->/, 'bloc socle absent');
    assert.match(text, /domains\/<domaine>\/rules\.md/);
    assert.match(text, /--relecteur <domaine>/);
    // Hors socle, aucune regle propre a un domaine : ni nom de domaine, ni registre, ni decision datee.
    const hors = text.replace(/<!-- socle:debut -->[\s\S]*?<!-- socle:fin -->/, '');
    assert.doesNotMatch(hors, /`pro`|`perso`|domaine pro|domaine perso|orgs\.json|d[ée]cision d'/i);
  });

  test('les anciens agents par domaine n existent plus', () => {
    assert.ok(!existsSync(path.join(AGENTS, 'reviewer-pro.md')));
    assert.ok(!existsSync(path.join(AGENTS, 'reviewer-perso.md')));
  });

  test.skip('chaque domaine du coffre a son fichier de regles avec une section Relecture (coffre seulement)', () => {
    const cfg = JSON.parse(readFileSync(path.resolve('kioku.config.json'), 'utf8'));
    for (const { id } of cfg.domains) {
      const file = path.join(DOMAIN_RULES, id, 'rules.md');
      assert.ok(existsSync(file), `${id} : ${path.relative(process.cwd(), file)} absent`);
      assert.match(readFileSync(file, 'utf8'), /^## Relecture$/m, `${id} : section Relecture absente`);
    }
  });

  test('verdict sans --relecteur : refuse', () => {
    const c = concept('pro');
    assert.equal(run('verdict', c, 'ok').status, 1);
  });

  test('verdict rendu pour perso sur une page pro : refuse, rien n entre', () => {
    const c = concept('pro');
    const out = run('verdict', c, 'ok', '--relecteur', 'perso');
    assert.equal(out.status, 1);
    assert.match(out.stdout, /un verdict perso ne vaut pas pour une page pro/);
    assert.equal(run('promote', c).status, 3);
    assert.ok(!existsSync(path.join(vault, 'wiki/pro/concepts/zeta.md')));
  });

  test('verdict ok du relecteur du domaine : admise', () => {
    const c = concept('perso');
    assert.equal(run('verdict', c, 'ok', '--relecteur', 'perso').status, 0);
    assert.equal(run('promote', c).status, 0);
    assert.ok(existsSync(path.join(vault, 'wiki/perso/concepts/zeta.md')));
  });

  test('verdict hold (avec note) du relecteur du domaine : retenue', () => {
    const c = concept('pro');
    assert.equal(run('verdict', c, 'hold', 'sensible', 'ligne', '12', '--relecteur', 'pro').status, 0);
    assert.equal(run('promote', c).status, 4);
  });

  test('verdict anterieur au decoupage (sans relecteur) : ne vaut rien', () => {
    const c = concept('pro');
    assert.equal(run('verdict', c, 'ok', '--relecteur', 'pro').status, 0);
    const dir = path.join(vault, '.verdicts');
    const [file] = readdirSync(dir);
    const legacy = JSON.parse(readFileSync(path.join(dir, file), 'utf8'));
    delete legacy.relecteur;
    writeFileSync(path.join(dir, file), JSON.stringify(legacy));
    assert.equal(run('promote', c).status, 3);
  });
});

describe('check : attribut org: du domaine pro', () => {
  const page = (domain, org) => {
    const rel = `.candidats/wiki/${domain}/concepts/zeta.md`;
    const line = org === undefined ? '' : `${org}\n`;
    put(rel, `---\ntype: concept\ntitle: Zeta\n${line}created: 2026-10-03\nupdated: 2026-10-03\n---\n\n## Vue d'ensemble\n\nRien.\n`);
    return rel;
  };
  const source = (pageOrg, silverOrg) => {
    put('raw/pro/meetings/2026-10-01-point.md', 'brut\n');
    put('silver/pro/2026-10-01-point.md', `---\nraw: meetings/2026-10-01-point.md\ndomain: pro\n${silverOrg}\nflags: []\nstatus: ready\n---\n\nFiche.\n`);
    const rel = '.candidats/wiki/pro/sources/2026-10-01-point.md';
    put(rel, `---\ntype: source\ntitle: Point\n${pageOrg}\ningested_on: 2026-10-01\nsource_type: meeting\nraw: meetings/2026-10-01-point.md\n---\n\n## Résumé\n\nRien.\n`);
    return rel;
  };

  test('org: valide : conforme sans avertissement org', () => {
    const out = run('check', page('pro', 'org: [globex]'));
    assert.equal(out.status, 0, out.stdout);
    assert.doesNotMatch(out.stdout, /org/);
  });

  test('org: absent, org_required faux : conforme avec un avertissement', () => {
    const out = run('check', page('pro'));
    assert.equal(out.status, 0, out.stdout);
    assert.match(out.stdout, /! org : /);
  });

  test('org: absent, org_required vrai : refusee', () => {
    registry({ org_required: true });
    const out = run('check', page('pro'));
    assert.equal(out.status, 1);
    assert.match(out.stdout, /org : /);
  });

  test('ordre libre : [acme, globex] conforme', () => {
    assert.equal(run('check', page('pro', 'org: [acme, globex]')).status, 0);
  });

  test('liste vide, identifiant hors registre, valeur nue : refusees', () => {
    for (const org of ['org: []', 'org: [initech]', 'org: globex']) {
      const out = run('check', page('pro', org));
      assert.equal(out.status, 1, org);
      assert.match(out.stdout, /org : /, org);
    }
  });

  test('liste YAML sur plusieurs lignes : refusee, pas ignoree', () => {
    const out = run('check', page('pro', 'org:\n  - globex'));
    assert.equal(out.status, 1);
    assert.match(out.stdout, /une seule ligne/);
  });

  test('org: sur une page perso : refusee', () => {
    const out = run('check', page('perso', 'org: [globex]'));
    assert.equal(out.status, 1);
    assert.match(out.stdout, /perso/);
  });

  test('page perso sans registre : le registre pro ne la concerne pas', () => {
    rmSync(path.join(vault, 'hooks/orgs.json'));
    assert.equal(run('check', page('perso')).status, 0);
  });

  test('source : org: de la fiche argent different de la page : refusee', () => {
    const out = run('check', source('org: [globex]', 'org: [acme]'));
    assert.equal(out.status, 1);
    assert.match(out.stdout, /argent : org/);
  });

  test('source : memes organisations dans un autre ordre : conforme', () => {
    const out = run('check', source('org: [globex, acme]', 'org: [acme, globex]'));
    assert.equal(out.status, 0, out.stdout);
  });

  test('registre absent, illisible ou invalide : page pro refusee, probleme nomme', () => {
    const cases = [
      () => rmSync(path.join(vault, 'hooks/orgs.json')),
      () => put('hooks/orgs.json', '{ pas du json'),
      () => registry({ orgs: [...REGISTRY.orgs, { id: 'initech', name: 'Acme', role: 'employer' }] }),
      () => registry({ orgs: [...REGISTRY.orgs, { id: 'globex', name: 'Bis', role: 'client', status: 'active' }] }),
    ];
    for (const [i, breakIt] of cases.entries()) {
      registry();
      breakIt();
      const out = run('check', page('pro', 'org: [globex]'));
      assert.equal(out.status, 1, `cas ${i}`);
      assert.match(out.stdout, /registre des organisations/, `cas ${i}`);
    }
  });
});

describe('stage : copier une page de l or sous .candidats/', () => {
  const stage = (env, ...args) =>
    spawnSync(process.execPath, [VAULT_HOOK, 'stage', ...args], {
      cwd: vault,
      env: { ...process.env, CLAUDE_PROJECT_DIR: vault, VAULT_MODE: '', VAULT_DOMAIN: '', ...env },
      encoding: 'utf8',
    });
  const ingestPro = { VAULT_MODE: 'ingest', VAULT_DOMAIN: 'pro' };
  const gold = '---\ngate: passe 2026-10-01 juge=relecteur regles=v1\ntype: concept\ntitle: Zeta\ncreated: 2026-10-03\nupdated: 2026-10-03\n---\n\n## Vue d\'ensemble\n\nRien.\n';
  const staged = path.join('.candidats/wiki/pro/concepts/zeta.md');
  beforeEach(() => put('wiki/pro/concepts/zeta.md', gold));

  test('copie a l octet pres, sans la ligne gate:', () => {
    const out = stage(ingestPro, 'pro', 'concepts/zeta');
    assert.equal(out.status, 0, out.stdout);
    assert.equal(readFileSync(path.join(vault, staged), 'utf8'), gold.replace(/^gate:.*\n/m, ''));
    assert.equal(readFileSync(path.join(vault, 'wiki/pro/concepts/zeta.md'), 'utf8'), gold);
  });

  test('fins de ligne CRLF conservees', () => {
    put('wiki/pro/concepts/zeta.md', gold.replace(/\n/g, '\r\n'));
    assert.equal(stage(ingestPro, 'pro', 'concepts/zeta').status, 0);
    assert.equal(readFileSync(path.join(vault, staged), 'utf8'), gold.replace(/^gate:.*\n/m, '').replace(/\n/g, '\r\n'));
  });

  test('hors session ingest : refuse, rien n est copie', () => {
    for (const env of [{ VAULT_DOMAIN: 'pro' }, { VAULT_MODE: 'query', VAULT_DOMAIN: 'pro' }]) {
      assert.equal(stage(env, 'pro', 'concepts/zeta').status, 1);
    }
    assert.ok(!existsSync(path.join(vault, staged)));
  });

  test('session d un autre domaine : refuse', () => {
    const out = stage({ VAULT_MODE: 'ingest', VAULT_DOMAIN: 'perso' }, 'pro', 'concepts/zeta');
    assert.equal(out.status, 1);
    assert.ok(!existsSync(path.join(vault, staged)));
  });

  test('refus de mode : aucune cible copiee, meme valide', () => {
    put('wiki/pro/concepts/eta.md', gold);
    assert.equal(stage({ VAULT_MODE: 'query', VAULT_DOMAIN: 'pro' }, 'pro', 'concepts/zeta', 'concepts/eta').status, 1);
    assert.deepEqual(existsSync(path.join(vault, '.candidats')), false);
  });

  test('index, log, overview et dossier inconnu : refuses', () => {
    put('wiki/pro/index.md', '# index\n');
    for (const t of ['index', 'log.md', 'overview', 'divers/zeta', 'concepts/zeta/x']) {
      assert.equal(stage(ingestPro, 'pro', t).status, 1, t);
    }
  });

  test('page absente du wiki : refuse', () => {
    const out = stage(ingestPro, 'pro', 'concepts/absente');
    assert.equal(out.status, 1);
    assert.match(out.stdout, /directement sous \.candidats/);
  });

  test('candidate deja presente : refuse, le brouillon reste intact', () => {
    put(staged, 'brouillon');
    assert.equal(stage(ingestPro, 'pro', 'concepts/zeta').status, 1);
    assert.equal(readFileSync(path.join(vault, staged), 'utf8'), 'brouillon');
  });

  test('page en quarantaine : refuse et renvoie vers decide, meme si l or a disparu', () => {
    put('quarantine/pro/concepts-zeta.json', '{}');
    assert.match(stage(ingestPro, 'pro', 'concepts/zeta').stdout, /decide/);
    rmSync(path.join(vault, 'wiki/pro/concepts/zeta.md'));
    assert.match(stage(ingestPro, 'pro', 'concepts/zeta').stdout, /decide/);
    assert.ok(!existsSync(path.join(vault, staged)));
  });

  test('plusieurs cibles : les valides sont copiees, le pire code l emporte', () => {
    const out = stage(ingestPro, 'pro', 'concepts/zeta', 'concepts/absente');
    assert.equal(out.status, 1);
    assert.ok(existsSync(path.join(vault, staged)));
  });

  test('bout en bout : stage, modification, verdict, promote -> une seule ligne gate:', () => {
    assert.equal(stage(ingestPro, 'pro', 'concepts/zeta').status, 0);
    writeFileSync(path.join(vault, staged), readFileSync(path.join(vault, staged), 'utf8').replace('Rien.', 'Quelque chose.'));
    assert.equal(run('check', staged).status, 0);
    assert.equal(run('verdict', staged, 'ok', '--relecteur', 'pro').status, 0);
    assert.equal(run('promote', staged).status, 0);
    const promoted = readFileSync(path.join(vault, 'wiki/pro/concepts/zeta.md'), 'utf8');
    assert.equal(promoted.match(/^gate:/gm).length, 1);
    assert.match(promoted, /Quelque chose\./);
    assert.ok(!existsSync(path.join(vault, staged)));
  });
});

describe('rotate-log : archiver les mois revolus du journal', () => {
  const rotate = (env, ...args) =>
    spawnSync(process.execPath, [VAULT_HOOK, 'rotate-log', ...args], {
      cwd: vault,
      env: { ...process.env, CLAUDE_PROJECT_DIR: vault, VAULT_MODE: '', VAULT_DOMAIN: '', ...env },
      encoding: 'utf8',
    });
  const queryPro = { VAULT_MODE: 'query', VAULT_DOMAIN: 'pro' };
  const now = new Date().toISOString().slice(0, 7); // mois courant, comme vault.mjs (date systeme)
  const head = '---\ntype: log\ntitle: "Journal"\n---\n\n# Log\n\n> Append-only.\n\n';
  const entry = (month, day, title) => `## [${month}-${day} 10:00] ingest | ${title}\n- source : x\n\n`;
  const log = head + entry('2000-01', '05', 'a') + entry('2000-01', '20', 'b') + entry('2000-02', '01', 'c') + entry(now, '01', 'd');
  const logFile = () => path.join(vault, 'wiki/pro/log.md');
  const archive = (m) => path.join(vault, `wiki/pro/log/${m}.md`);
  beforeEach(() => put('wiki/pro/log.md', log));

  test('garde le mois courant et l en-tete, archive chaque mois revolu dans l ordre', () => {
    const out = rotate(queryPro, 'pro');
    assert.equal(out.status, 0, out.stdout);
    assert.equal(readFileSync(logFile(), 'utf8'), head + entry(now, '01', 'd'));
    const jan = readFileSync(archive('2000-01'), 'utf8');
    assert.match(jan, /^---\ntype: log\n/);
    assert.ok(jan.endsWith(entry('2000-01', '05', 'a') + entry('2000-01', '20', 'b')));
    assert.ok(readFileSync(archive('2000-02'), 'utf8').endsWith(entry('2000-02', '01', 'c')));
  });

  test('aucune entree perdue ni dupliquee', () => {
    rotate(queryPro, 'pro');
    const all = [logFile(), archive('2000-01'), archive('2000-02')].map((f) => readFileSync(f, 'utf8')).join('');
    for (const t of ['a', 'b', 'c', 'd']) assert.equal(all.split(`ingest | ${t}\n`).length - 1, 1, t);
  });

  test('idempotent : une seconde rotation ne change rien', () => {
    rotate(queryPro, 'pro');
    const snap = [logFile(), archive('2000-01')].map((f) => readFileSync(f, 'utf8'));
    const out = rotate(queryPro, 'pro');
    assert.equal(out.status, 0);
    assert.match(out.stdout, /rien a archiver/);
    assert.deepEqual([logFile(), archive('2000-01')].map((f) => readFileSync(f, 'utf8')), snap);
  });

  test('archive existante : on ajoute a la fin, sans recopier ce qui y est deja (reprise apres arret)', () => {
    put('wiki/pro/log/2000-01.md', `---\ntype: log\n---\n\n${entry('2000-01', '05', 'a')}`);
    assert.equal(rotate(queryPro, 'pro').status, 0);
    const jan = readFileSync(archive('2000-01'), 'utf8');
    assert.equal(jan.split('ingest | a\n').length - 1, 1);
    assert.ok(jan.endsWith(entry('2000-01', '20', 'b')));
  });

  test('deux entrees identiques du meme mois : les deux sont archivees', () => {
    put('wiki/pro/log.md', head + entry('2000-01', '05', 'a') + entry('2000-01', '05', 'a') + entry(now, '01', 'd'));
    assert.equal(rotate(queryPro, 'pro').status, 0);
    assert.equal(readFileSync(archive('2000-01'), 'utf8').split('ingest | a\n').length - 1, 2);
  });

  test('derniere entree sans saut de ligne final : conservee', () => {
    put('wiki/pro/log.md', `${head}${entry('2000-01', '05', 'a')}## [${now}-02 10:00] query | "x"`);
    assert.equal(rotate(queryPro, 'pro').status, 0);
    assert.equal(readFileSync(logFile(), 'utf8'), `${head}## [${now}-02 10:00] query | "x"\n`);
  });

  test('--dry-run : annonce, n ecrit rien', () => {
    const out = rotate(queryPro, 'pro', '--dry-run');
    assert.equal(out.status, 0);
    assert.match(out.stdout, /\[dry-run\] 2000-01 : 2 entree/);
    assert.equal(readFileSync(logFile(), 'utf8'), log);
    assert.ok(!existsSync(path.join(vault, 'wiki/pro/log')));
  });

  test('mode ingest admis, triage et sans mode refuses', () => {
    for (const env of [{ VAULT_MODE: 'triage', VAULT_DOMAIN: 'pro' }, { VAULT_DOMAIN: 'pro' }]) {
      assert.equal(rotate(env, 'pro').status, 1);
    }
    assert.equal(readFileSync(logFile(), 'utf8'), log);
    assert.equal(rotate({ VAULT_MODE: 'ingest', VAULT_DOMAIN: 'pro' }, 'pro').status, 0);
  });

  test('session d un autre domaine : refuse, rien n est ecrit', () => {
    assert.equal(rotate({ VAULT_MODE: 'query', VAULT_DOMAIN: 'perso' }, 'pro').status, 1);
    assert.equal(readFileSync(logFile(), 'utf8'), log);
  });

  test('circuit Plaud en cours (verrou tenu par un processus vivant) : refuse, rien n est ecrit', () => {
    put('tools/plaud-sync/.lock.json', JSON.stringify({ pid: process.pid, started: 'x' }));
    const out = rotate(queryPro, 'pro');
    assert.equal(out.status, 1);
    assert.match(out.stdout, /Plaud/);
    assert.equal(readFileSync(logFile(), 'utf8'), log);
    assert.ok(existsSync(path.join(vault, 'tools/plaud-sync/.lock.json')), 'le verrou d un autre n est pas retire');
  });

  test('verrou rendu apres la rotation', () => {
    assert.equal(rotate(queryPro, 'pro').status, 0);
    assert.ok(!existsSync(path.join(vault, 'tools/plaud-sync/.lock.json')));
  });

  test('log.md absent, ou seulement le mois courant : rien a faire', () => {
    put('wiki/pro/log.md', head + entry(now, '01', 'd'));
    assert.match(rotate(queryPro, 'pro').stdout, /rien a archiver/);
    rmSync(logFile());
    assert.equal(rotate(queryPro, 'pro').status, 0);
  });
});

describe('propose-org et tag-org : migration de l attribut org: du pro', () => {
  const cmd = (env, ...args) =>
    spawnSync(process.execPath, [VAULT_HOOK, ...args], {
      cwd: vault,
      env: { ...process.env, CLAUDE_PROJECT_DIR: vault, VAULT_MODE: '', VAULT_DOMAIN: '', ...env },
      encoding: 'utf8',
    });
  const queryPro = { VAULT_MODE: 'query', VAULT_DOMAIN: 'pro' };
  const gate = 'gate: passe 2026-10-01 juge=relecteur regles=v1\n';
  const src = (slug, { fm = '', body = 'Rien.' } = {}) =>
    put(`wiki/pro/sources/${slug}.md`, `---\n${gate}type: source\ntitle: ${slug}\n${fm}ingested_on: 2026-10-01\nsource_type: meeting\nraw: meetings/${slug}.md\n---\n\n## Résumé\n\n${body}\n`);
  const ent = (folder, type, slug, fm) =>
    put(`wiki/pro/${folder}/${slug}.md`, `---\ntype: ${type}\ntitle: ${slug}\n${fm}created: 2026-10-01\nupdated: 2026-10-01\n---\n\n## Vue d'ensemble\n\nRien.\n`);
  const tsv = (out) =>
    Object.fromEntries(out.stdout.trim().split('\n').filter(Boolean).map((l) => l.split('\t')).map(([p, o, r]) => [p, { org: o, raison: r }]));
  const read = (rel) => readFileSync(path.join(vault, rel), 'utf8');

  test('tour sources : callout, tag hors-globex, employeur cite, client actif', () => {
    src('s-callout', { body: "> [!warning] ⚠️§2 — contexte ACME, hors Globex d'Or : interne." });
    src('s-tag', { fm: 'tags: [sdlc, hors-globex]\n' });
    src('s-cite', { body: 'Point avec le manager ACME.' });
    src('s-tag-acme', { fm: 'tags: [passation, acme]\n' });
    src('s-client', { body: 'Revue de la gateway.' });
    ent('concepts', 'concept', 'c', 'sources: [[[sources/s-client]]]\n');
    const out = cmd(queryPro, 'propose-org', 'pro', '--tour', 'sources');
    assert.equal(out.status, 0, out.stderr);
    const t = tsv(out);
    assert.deepEqual(t['sources/s-callout'], { org: 'acme', raison: 'callout' });
    assert.deepEqual(t['sources/s-tag'], { org: 'acme', raison: 'tag' });
    assert.deepEqual(t['sources/s-cite'], { org: '?', raison: 'employeur-cite' });
    assert.deepEqual(t['sources/s-tag-acme'], { org: '?', raison: 'employeur-cite' });
    assert.deepEqual(t['sources/s-client'], { org: 'globex', raison: 'client-actif' });
    assert.equal(t['concepts/c'], undefined, 'le tour sources ne propose rien d autre que sources/');
  });

  test('tour sources : deux clients actifs -> ? pour une source sans signal', () => {
    registry({ orgs: [...REGISTRY.orgs, { id: 'initech', name: 'Acme', role: 'client', status: 'active' }] });
    src('s-client', { body: 'Revue.' });
    assert.deepEqual(tsv(cmd(queryPro, 'propose-org', 'pro', '--tour', 'sources'))['sources/s-client'], { org: '?', raison: 'plusieurs-clients-actifs' });
  });

  test('tour derivees : union des org: poses, jamais une union partielle', () => {
    src('s1', { fm: 'org: [acme]\n' });
    src('s2', { fm: 'org: [globex]\n' });
    src('s3');
    put('wiki/pro/meetings/m.md', `---\ntype: meeting\ntitle: m\nsources: [[[sources/s1]]]\ndate: 2026-10-01\n---\n\nRien.\n`);
    ent('concepts', 'concept', 'both', 'sources: [[[sources/s1]], [[sources/s2]]]\n');
    ent('concepts', 'concept', 'partial', 'sources: [[[sources/s2]], [[sources/s3]]]\n');
    ent('concepts', 'concept', 'none', 'sources: []\n');
    ent('syntheses', 'synthesis', 'syn', 'derived_from: [[[log]], [[sources/s2]]]\n');
    const t = tsv(cmd(queryPro, 'propose-org', 'pro', '--tour', 'derivees'));
    assert.deepEqual(t['meetings/m'], { org: 'acme', raison: 'union' });
    assert.deepEqual(t['concepts/both'], { org: 'acme,globex', raison: 'union' });
    assert.deepEqual(t['concepts/partial'], { org: '?', raison: 'source-non-taguee' });
    assert.deepEqual(t['concepts/none'], { org: '?', raison: 'sans-source' });
    assert.deepEqual(t['syntheses/syn'], { org: 'globex', raison: 'union' });
    assert.equal(t['sources/s3'], undefined, 'le tour derivees ne propose pas de source');
  });

  test('page deja taguee : absente de la proposition', () => {
    src('s1', { fm: 'org: [acme]\n' });
    assert.equal(tsv(cmd(queryPro, 'propose-org', 'pro', '--tour', 'sources'))['sources/s1'], undefined);
  });

  test('tag-org : insere org: et org-tag:, garde gate:, reste identique a l octet', () => {
    src('s1');
    const before = read('wiki/pro/sources/s1.md');
    put('p.tsv', 'sources/s1\tglobex\tclient-actif\n');
    const out = cmd(queryPro, 'tag-org', 'p.tsv');
    assert.equal(out.status, 0, out.stdout);
    const after = read('wiki/pro/sources/s1.md');
    assert.match(after, /^gate: passe/m);
    assert.match(after, /^org: \[globex\]$/m);
    assert.match(after, /^org-tag: \d{4}-\d{2}-\d{2} juge=utilisateur$/m);
    assert.equal(after.replace(/^org: .*\n/m, '').replace(/^org-tag: .*\n/m, ''), before);
  });

  test('tag-org : liste ecrite triee, sans doublon', () => {
    src('s1');
    put('p.tsv', 'sources/s1\tacme,globex,acme\tx\n');
    assert.equal(cmd(queryPro, 'tag-org', 'p.tsv').status, 0);
    assert.match(read('wiki/pro/sources/s1.md'), /^org: \[acme, globex\]$/m);
  });

  test('tag-org : fins de ligne CRLF conservees', () => {
    src('s1');
    const crlf = read('wiki/pro/sources/s1.md').replace(/\n/g, '\r\n');
    put('wiki/pro/sources/s1.md', crlf);
    put('p.tsv', 'sources/s1\tglobex\tx\n');
    assert.equal(cmd(queryPro, 'tag-org', 'p.tsv').status, 0);
    const after = read('wiki/pro/sources/s1.md');
    assert.match(after, /\r\norg: \[globex\]\r\norg-tag: /);
    assert.equal(after.replace(/org: .*\r\n/, '').replace(/org-tag: .*\r\n/, ''), crlf);
  });

  test('tag-org : remplace un org: pose par la migration (trace org-tag:)', () => {
    src('s1', { fm: 'org: [globex]\norg-tag: 2026-01-01 juge=utilisateur\n' });
    put('p.tsv', 'sources/s1\tacme\tcorrection\n');
    assert.equal(cmd(queryPro, 'tag-org', 'p.tsv').status, 0);
    const after = read('wiki/pro/sources/s1.md');
    assert.match(after, /^org: \[acme\]$/m);
    assert.doesNotMatch(after, /2026-01-01/);
    assert.equal(after.match(/^org/gm).length, 2);
  });

  test('tag-org : un org: pose par la gate (sans trace) n est pas remplace', () => {
    src('s1', { fm: 'org: [globex]\n' });
    const before = read('wiki/pro/sources/s1.md');
    put('p.tsv', 'sources/s1\tacme\tx\n');
    const out = cmd(queryPro, 'tag-org', 'p.tsv');
    assert.equal(out.status, 1);
    assert.match(out.stdout, /refusee/);
    assert.equal(read('wiki/pro/sources/s1.md'), before);
  });

  test('tag-org : ?, hors registre, page absente ou sans frontmatter refuses, les autres appliques', () => {
    src('ok');
    src('q');
    src('x');
    put('wiki/pro/sources/nofm.md', 'pas de frontmatter\n');
    put('p.tsv', 'sources/q\t?\tx\nsources/x\tinitech\tx\nsources/absente\tglobex\tx\nsources/nofm\tglobex\tx\nsources/ok\tglobex\tx\n');
    const out = cmd(queryPro, 'tag-org', 'p.tsv');
    assert.equal(out.status, 1);
    assert.equal((out.stdout.match(/^refusee/gm) ?? []).length, 4, out.stdout);
    assert.match(read('wiki/pro/sources/ok.md'), /^org: \[globex\]$/m);
    assert.doesNotMatch(read('wiki/pro/sources/q.md'), /^org:/m);
  });

  test('apres un passage par la gate, la trace org-tag: disparait et tag-org ne remplace plus org:', () => {
    src('s1', { fm: 'org: [globex]\norg-tag: 2026-01-01 juge=utilisateur\n' });
    put('raw/pro/meetings/s1.md', 'brut\n'); // check exige le brut d'une source
    const ingestPro = { VAULT_MODE: 'ingest', VAULT_DOMAIN: 'pro' };
    assert.equal(cmd(ingestPro, 'stage', 'pro', 'sources/s1').status, 0);
    const staged = '.candidats/wiki/pro/sources/s1.md';
    assert.doesNotMatch(read(staged), /^org-tag:/m, 'stage retire la trace avec gate:');
    put(staged, read(staged).replace('org: [globex]', 'org: [globex, acme]'));
    assert.equal(cmd(ingestPro, 'verdict', staged, 'ok', '--relecteur', 'pro').status, 0);
    assert.equal(cmd(ingestPro, 'promote', staged).status, 0);
    const promoted = read('wiki/pro/sources/s1.md');
    assert.doesNotMatch(promoted, /^org-tag:/m);
    put('p.tsv', 'sources/s1\tglobex\tx\n');
    assert.equal(cmd(queryPro, 'tag-org', 'p.tsv').status, 1);
    assert.equal(read('wiki/pro/sources/s1.md'), promoted);
  });

  test('tag-org : page en attente de decision en quarantaine -> refusee', () => {
    src('s1');
    src('s2');
    put('quarantine/pro/sources-s1.json', '{}');
    put('p.tsv', 'sources/s1\tglobex\tx\nsources/s2\tglobex\tx\n');
    const out = cmd(queryPro, 'tag-org', 'p.tsv');
    assert.equal(out.status, 1);
    assert.match(out.stdout, /refusee  sources\/s1 : en attente de decision/);
    assert.doesNotMatch(read('wiki/pro/sources/s1.md'), /^org:/m);
    assert.match(read('wiki/pro/sources/s2.md'), /^org: \[globex\]$/m);
  });

  test('tag-org --dry-run : rien n est ecrit', () => {
    src('s1');
    const before = read('wiki/pro/sources/s1.md');
    put('p.tsv', 'sources/s1\tglobex\tx\n');
    const out = cmd(queryPro, 'tag-org', 'p.tsv', '--dry-run');
    assert.equal(out.status, 0);
    assert.match(out.stdout, /dry-run/);
    assert.equal(read('wiki/pro/sources/s1.md'), before);
  });

  test('tag-org : session perso, mode triage, candidate en attente ou verrou Plaud -> refus sans ecriture', () => {
    src('s1');
    const before = read('wiki/pro/sources/s1.md');
    put('p.tsv', 'sources/s1\tglobex\tx\n');
    assert.equal(cmd({ VAULT_MODE: 'query', VAULT_DOMAIN: 'perso' }, 'tag-org', 'p.tsv').status, 1);
    assert.equal(cmd({ VAULT_MODE: 'triage', VAULT_DOMAIN: 'pro' }, 'tag-org', 'p.tsv').status, 1);
    put('.candidats/wiki/pro/concepts/z.md', 'x\n');
    const pending = cmd(queryPro, 'tag-org', 'p.tsv');
    assert.equal(pending.status, 1);
    assert.match(pending.stdout, /candidat/);
    rmSync(path.join(vault, '.candidats'), { recursive: true });
    put('tools/plaud-sync/.lock.json', JSON.stringify({ pid: process.pid, started: 'x' }));
    const locked = cmd(queryPro, 'tag-org', 'p.tsv');
    assert.equal(locked.status, 1);
    assert.match(locked.stdout, /Plaud/);
    assert.equal(read('wiki/pro/sources/s1.md'), before);
  });
});

describe('propose-raw et tag-raw : relier le bronze herite aux pages sources sans raw:', () => {
  const cmd = (env, ...args) =>
    spawnSync(process.execPath, [VAULT_HOOK, ...args], {
      cwd: vault,
      env: { ...process.env, CLAUDE_PROJECT_DIR: vault, VAULT_MODE: '', VAULT_DOMAIN: '', ...env },
      encoding: 'utf8',
    });
  const queryPro = { VAULT_MODE: 'query', VAULT_DOMAIN: 'pro' };
  const brut = (name) => put(`raw/pro/meetings/${name}.md`, 'brut\n');
  const page = (slug, { title = slug, fm = '' } = {}) =>
    put(`wiki/pro/sources/${slug}.md`, `---\ngate: passe 2026-10-01 juge=relecteur regles=v1\ntype: source\ntitle: "${title}"\n${fm}ingested_on: 2026-10-01\nsource_type: meeting\norg: [globex]\n---\n\n## Résumé\n\nRien.\n`);
  const tsv = (out) => out.stdout.trim().split('\n').filter(Boolean).map((l) => l.split('\t'));
  const read = (rel) => readFileSync(path.join(vault, rel), 'utf8');

  test('meme date, un brut et une page : appariement propose, meme si les slugs different', () => {
    brut('2026-06-22-sprint-planning-data-quality-analytics-and-catalog-integration');
    page('2026-06-22-sprint-planning-data-quality-analytics-catalog');
    const rows = tsv(cmd(queryPro, 'propose-raw', 'pro'));
    assert.deepEqual(rows, [['sources/2026-06-22-sprint-planning-data-quality-analytics-catalog', 'meetings/2026-06-22-sprint-planning-data-quality-analytics-and-catalog-integration.md', rows[0][2], rows[0][3]]]);
  });

  test('plusieurs bruts et pages le meme jour : chaque page recoit le brut le plus proche, jamais deux fois le meme', () => {
    brut('2026-09-15-endpoints-servicenow-monitoring-revue-de-code-et-apigee');
    brut('2026-09-15-implementation-de-la-passerelle-media-gestion-des-fichiers-et-monitoring');
    page('2026-09-15-passerelle-media-fichiers-quotas-monitoring');
    page('2026-09-15-endpoints-servicenow-observabilite-revue-pr-apigee');
    const rows = Object.fromEntries(tsv(cmd(queryPro, 'propose-raw', 'pro')).map(([p, r]) => [p, r]));
    assert.equal(rows['sources/2026-09-15-passerelle-media-fichiers-quotas-monitoring'], 'meetings/2026-09-15-implementation-de-la-passerelle-media-gestion-des-fichiers-et-monitoring.md');
    assert.equal(rows['sources/2026-09-15-endpoints-servicenow-observabilite-revue-pr-apigee'], 'meetings/2026-09-15-endpoints-servicenow-monitoring-revue-de-code-et-apigee.md');
  });

  test('le titre de la page aide quand le slug ne ressemble pas au brut', () => {
    brut('2026-07-22-genai200-300-sync-hebdo-contenu');
    brut('2026-07-22-tout-autre-chose-sans-rapport');
    page('2026-07-22-sync-quotas-gateway-roadmap-mcp', { title: 'GenAI200-300 sync hebdo : quotas, gateway, roadmap MCP' });
    const [row] = tsv(cmd(queryPro, 'propose-raw', 'pro'));
    assert.equal(row[1], 'meetings/2026-07-22-genai200-300-sync-hebdo-contenu.md');
  });

  test('brut sans page et page sans brut : lignes ? ; brut deja relie et page deja reliee : ignores', () => {
    brut('2026-07-10-visaya-saignasith');
    page('2026-08-01-page-sans-brut');
    brut('2026-08-02-deja-relie');
    page('2026-08-02-deja-reliee', { fm: 'raw: meetings/2026-08-02-deja-relie.md\n' });
    const rows = tsv(cmd(queryPro, 'propose-raw', 'pro'));
    assert.deepEqual(rows.map(([p, r, , why]) => [p, r, why]).sort(), [
      ['?', 'meetings/2026-07-10-visaya-saignasith.md', 'brut-sans-page'],
      ['sources/2026-08-01-page-sans-brut', '?', 'page-sans-brut'],
    ]);
  });

  test('tag-raw : insere raw: et raw-tag:, reste identique a l octet', () => {
    brut('2026-06-15-architecture');
    page('2026-06-15-architecture');
    const before = read('wiki/pro/sources/2026-06-15-architecture.md');
    put('r.tsv', 'sources/2026-06-15-architecture\tmeetings/2026-06-15-architecture.md\t1\tunique-du-jour\n');
    const out = cmd(queryPro, 'tag-raw', 'r.tsv');
    assert.equal(out.status, 0, out.stdout);
    const after = read('wiki/pro/sources/2026-06-15-architecture.md');
    assert.match(after, /^raw: meetings\/2026-06-15-architecture\.md$/m);
    assert.match(after, /^raw-tag: \d{4}-\d{2}-\d{2} juge=utilisateur$/m);
    assert.equal(after.replace(/^raw: .*\n/m, '').replace(/^raw-tag: .*\n/m, ''), before);
  });

  test('tag-raw : brut absent, page qui a deja un raw:, page hors sources/ ou ? -> refuses, les autres appliques', () => {
    brut('2026-06-15-a');
    brut('2026-06-15-b');
    page('2026-06-15-a');
    page('2026-06-15-b', { fm: 'raw: meetings/2026-06-15-b.md\n' });
    page('2026-06-15-c');
    put('r.tsv', [
      'sources/2026-06-15-c\tmeetings/2026-06-15-absent.md\t1\tx',
      'sources/2026-06-15-b\tmeetings/2026-06-15-b.md\t1\tx',
      'concepts/x\tmeetings/2026-06-15-a.md\t1\tx',
      '?\tmeetings/2026-06-15-a.md\t0\tbrut-sans-page',
      'sources/2026-06-15-a\tmeetings/2026-06-15-a.md\t1\tx',
    ].join('\n') + '\n');
    const out = cmd(queryPro, 'tag-raw', 'r.tsv');
    assert.equal(out.status, 1);
    assert.equal((out.stdout.match(/^refusee/gm) ?? []).length, 4, out.stdout);
    assert.match(read('wiki/pro/sources/2026-06-15-a.md'), /^raw: meetings\/2026-06-15-a\.md$/m);
  });

  test('tag-raw : un meme brut pour deux pages -> les deux refusees', () => {
    brut('2026-06-15-a');
    page('2026-06-15-x');
    page('2026-06-15-y');
    put('r.tsv', 'sources/2026-06-15-x\tmeetings/2026-06-15-a.md\t1\tx\nsources/2026-06-15-y\tmeetings/2026-06-15-a.md\t1\tx\n');
    const out = cmd(queryPro, 'tag-raw', 'r.tsv');
    assert.equal(out.status, 1);
    assert.match(out.stdout, /cite par deux lignes/);
    assert.doesNotMatch(read('wiki/pro/sources/2026-06-15-x.md'), /^raw:/m);
  });

  test('tag-raw : session perso, candidate en attente ou verrou Plaud -> refus sans ecriture', () => {
    brut('2026-06-15-a');
    page('2026-06-15-a');
    const before = read('wiki/pro/sources/2026-06-15-a.md');
    put('r.tsv', 'sources/2026-06-15-a\tmeetings/2026-06-15-a.md\t1\tx\n');
    assert.equal(cmd({ VAULT_MODE: 'query', VAULT_DOMAIN: 'perso' }, 'tag-raw', 'r.tsv').status, 1);
    put('.candidats/wiki/pro/concepts/z.md', 'x\n');
    assert.equal(cmd(queryPro, 'tag-raw', 'r.tsv').status, 1);
    rmSync(path.join(vault, '.candidats'), { recursive: true });
    put('tools/plaud-sync/.lock.json', JSON.stringify({ pid: process.pid, started: 'x' }));
    assert.equal(cmd(queryPro, 'tag-raw', 'r.tsv').status, 1);
    assert.equal(read('wiki/pro/sources/2026-06-15-a.md'), before);
  });

  test('raw-tag: disparait au passage par la gate, comme org-tag:', () => {
    brut('2026-06-15-a');
    page('2026-06-15-a', { fm: 'raw: meetings/2026-06-15-a.md\nraw-tag: 2026-01-01 juge=utilisateur\n' });
    const ingestPro = { VAULT_MODE: 'ingest', VAULT_DOMAIN: 'pro' };
    assert.equal(cmd(ingestPro, 'stage', 'pro', 'sources/2026-06-15-a').status, 0);
    assert.doesNotMatch(read('.candidats/wiki/pro/sources/2026-06-15-a.md'), /^raw-tag:/m);
  });
});

describe('audit : controles org du pro', () => {
  const audit = (domain) => spawnSync(process.execPath, [VAULT_HOOK, 'audit', domain], { cwd: vault, env: { ...process.env, CLAUDE_PROJECT_DIR: vault }, encoding: 'utf8' });
  const page = (domain, folder, type, slug, fm) =>
    put(`wiki/${domain}/${folder}/${slug}.md`, `---\ntype: ${type}\ntitle: ${slug}\n${fm}---\n\nRien.\n`);

  test('org-absent et org-union listes pour le pro', () => {
    page('pro', 'sources', 'source', 's1', 'org: [acme]\n');
    page('pro', 'sources', 'source', 's2', 'org: [globex]\n');
    page('pro', 'concepts', 'concept', 'drift', 'org: [globex]\nsources: [[[sources/s1]], [[sources/s2]]]\n');
    page('pro', 'concepts', 'concept', 'fine', 'org: [acme, globex]\nsources: [[[sources/s1]], [[sources/s2]]]\n');
    page('pro', 'concepts', 'concept', 'bare', 'sources: [[[sources/s1]]]\n');
    const out = audit('pro');
    assert.equal(out.status, 0, out.stdout);
    assert.match(out.stdout, /^org-absent : 1$/m);
    assert.match(out.stdout, /- concepts\/bare/);
    assert.match(out.stdout, /^org-union : 1$/m);
    assert.match(out.stdout, /- concepts\/drift : \[globex\] -> \[acme, globex\]/);
    assert.doesNotMatch(out.stdout, /concepts\/fine :/);
  });

  test('audit perso : aucune categorie org', () => {
    page('perso', 'concepts', 'concept', 'x', 'sources: []\n');
    assert.doesNotMatch(audit('perso').stdout, /org-/);
  });
});

describe('U4 : domaines lus dans la configuration', () => {
  // Trois domaines fictifs ; l'extension org porte sur `b`, pas sur le premier, pour qu'aucun domaine n'y soit privilegie.
  const THREE = {
    version: 1,
    domains: [{ id: 'a' }, { id: 'b', extensions: { org: { registry: 'etat/orgs.json' } } }, { id: 'c' }],
  };
  const three = () => {
    config(THREE);
    put('etat/orgs.json', JSON.stringify({ ...REGISTRY, org_required: true }));
  };
  const card = (domain, body = '', fm = '') => {
    const rel = `.candidats/wiki/${domain}/concepts/zeta.md`;
    put(rel, `---\ntype: concept\ntitle: Zeta\ncreated: 2026-10-03\nupdated: 2026-10-03\n${fm}---\n\n## Vue d'ensemble\n\n${body}\n`);
    return rel;
  };
  const env = (mode, domain) => ({ VAULT_MODE: mode, VAULT_DOMAIN: domain });
  const runAs = (vars, ...args) =>
    spawnSync(process.execPath, [VAULT_HOOK, ...args], { cwd: vault, env: { ...process.env, CLAUDE_PROJECT_DIR: vault, ...vars }, encoding: 'utf8' });

  test('configuration absente : chaque commande refuse en nommant la configuration, rien n est ecrit', () => {
    rmSync(path.join(vault, 'kioku.config.json'));
    const c = concept('pro');
    for (const args of [['check', c], ['audit', 'pro'], ['undecided']]) {
      const out = run(...args);
      assert.equal(out.status, 1);
      assert.match(out.stdout, /configuration du coffre absente/);
    }
    assert.ok(!existsSync(path.join(vault, '.verdicts')));
  });

  test('check : un domaine declare passe, un domaine non declare est refuse avec la liste', () => {
    three();
    assert.equal(run('check', card('c')).status, 0);
    const out = run('check', card('z'));
    assert.equal(out.status, 1);
    assert.match(out.stdout, /"z" n'est pas un domaine declare \(a\|b\|c\)/);
  });

  test('check : un lien vers n importe quel autre domaine est refuse', () => {
    three();
    for (const target of ['[[b/concepts/x]]', '[[c/people/y]]', 'voir raw/c/x.md']) {
      const out = run('check', card('a', target));
      assert.equal(out.status, 1, target);
      assert.match(out.stdout, /domaine-lien/);
    }
  });

  test('check : un domaine dont le nom prolonge un autre n est pas un lien croise', () => {
    config({ version: 1, domains: [{ id: 'a' }, { id: 'a-old' }] });
    assert.equal(run('check', card('a', 'mot raw/a/x.md seulement')).status, 0);
    assert.equal(run('check', card('a', 'raw/a-old/x.md')).status, 1);
  });

  test('org: suit l extension, pas le nom du domaine', () => {
    three();
    assert.equal(run('check', card('b')).status, 1, 'b a l extension, org: requis');
    assert.equal(run('check', card('b', '', 'org: [globex]\n')).status, 0);
    const out = run('check', card('a', '', 'org: [globex]\n'));
    assert.equal(out.status, 1);
    assert.match(out.stdout, /le domaine n'a pas l'extension org/);
  });

  test('verdict : un relecteur non declare est refuse, celui du domaine passe', () => {
    three();
    const c = card('c');
    assert.equal(run('verdict', c, 'ok', '--relecteur', 'z').status, 1);
    assert.equal(run('verdict', c, 'ok', '--relecteur', 'a').status, 1);
    assert.equal(run('verdict', c, 'ok', '--relecteur', 'c').status, 0);
    assert.equal(run('promote', c).status, 0);
    assert.ok(existsSync(path.join(vault, 'wiki/c/concepts/zeta.md')));
  });

  test('audit : un lien vers chacun des autres domaines est signale', () => {
    three();
    put('wiki/a/concepts/x.md', '---\ntype: concept\ntitle: X\n---\n\n[[b/concepts/y]] et [[c/concepts/z]].\n');
    const out = run('audit', 'a');
    assert.match(out.stdout, /^domaine-lien : 2$/m);
    assert.doesNotMatch(out.stdout, /org-/);
  });

  test('audit et undecided : domaine non declare refuse, usage avec la liste', () => {
    three();
    for (const args of [['audit', 'z'], ['undecided', 'z'], ['seed', 'z']]) {
      const out = run(...args);
      assert.equal(out.status, 1);
      assert.match(out.stdout, /<a\|b\|c>|\[a\|b\|c\]/);
    }
  });

  test('propose-org et tag-org : seulement sur un domaine a extension org', () => {
    three();
    assert.equal(run('propose-org', 'a', '--tour', 'sources').status, 1);
    assert.equal(run('propose-org', 'b', '--tour', 'sources').status, 0);
    put('wiki/b/sources/s1.md', '---\ntype: source\ntitle: s1\n---\n\nRien.\n');
    put('p.tsv', 'sources/s1\tglobex\tx\n');
    assert.match(runAs(env('query', 'a'), 'tag-org', 'p.tsv').stdout, /pas un domaine a extension org \(b\)/);
    assert.equal(runAs(env('query', 'b'), 'tag-org', 'p.tsv').status, 0);
    assert.match(readFileSync(path.join(vault, 'wiki/b/sources/s1.md'), 'utf8'), /^org: \[globex\]$/m);
  });

  test('propose-org : callout et tag hors-<client> construits depuis le registre, aucun nom en dur', () => {
    put('wiki/pro/sources/s-callout.md', `---\ntype: source\ntitle: x\n---\n\n> [!warning] contexte ACME, hors Globex d’Or : interne.\n`);
    put('wiki/pro/sources/s-tag.md', '---\ntype: source\ntitle: x\ntags: [x, hors-globex]\n---\n\nRien.\n');
    const out = run('propose-org', 'pro', '--tour', 'sources');
    assert.match(out.stdout, /sources\/s-callout\tacme\tcallout/);
    assert.match(out.stdout, /sources\/s-tag\tacme\ttag/);
  });
});
