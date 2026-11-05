/**
 * Tests de la file d'ingestion : `node --test tools/plaud-sync/pending.test.mjs`
 * Coffre factice dans un dossier temporaire, contenus inventes : aucun fichier reel n'est lu.
 *
 * Ce qui est verifie avant tout : une source n'est « traitee » que lorsque sa PAGE OR existe.
 * Le critere etait la fiche argent, ecrite a l'etape 2 sur 3 — le 22/09, une session s'est arretee
 * entre les candidates et la gate et le rapport a annonce « 1/1 ingeree » pour une source jamais
 * entree dans le wiki.
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { beforeEach, afterEach, describe, test } from 'node:test';
import { writeTestConfig } from '../test-vault.mjs';

const PENDING = path.join(path.dirname(new URL(import.meta.url).pathname), 'pending.mjs');
const REL = 'meetings/2026-09-22-note-inventee.md';

let vault;
const put = (rel, text) => {
  const file = path.join(vault, rel);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, text);
};
const run = (...args) =>
  spawnSync(process.execPath, [PENDING, ...args], { env: { ...process.env, CLAUDE_PROJECT_DIR: vault }, encoding: 'utf8' });
const list = () => run('list').stdout.trim().split('\n').filter(Boolean);
const queueFile = () => JSON.parse(readFileSync(path.join(vault, 'tools', 'plaud-sync', '.queue.json'), 'utf8'));
const enqueue = (entries) => put('tools/plaud-sync/.queue.json', JSON.stringify(entries));
const silver = (rel, domain = 'pro', slug = 'note-inventee') => put(`silver/${domain}/${slug}.md`, `---\nraw: ${rel}\ndomain: ${domain}\n---\n`);
const gold = (rel, domain = 'pro', slug = 'note-inventee') => put(`wiki/${domain}/sources/${slug}.md`, `---\ntype: source\nraw: ${rel}\n---\n`);

beforeEach(() => {
  vault = mkdtempSync(path.join(tmpdir(), 'plaud-pending-'));
  writeTestConfig(vault);
  mkdirSync(path.join(vault, 'tools', 'plaud-sync'), { recursive: true });
});
afterEach(() => rmSync(vault, { recursive: true, force: true }));

describe('les trois marches d\'une ingestion', () => {
  beforeEach(() => {
    put(`raw/pro/${REL}`, '# note inventee\n');
    enqueue([{ domain: 'pro', rel: REL }]);
  });

  test('brut seul : etat neuf, la source reste a faire', () => {
    assert.deepEqual(list(), [`pro\t${REL}\tneuf`]);
  });

  test('LE CAS DU 22/09 — fiche argent sans page or : signalee `argent`, PAS retiree de la file', () => {
    silver(REL);
    assert.deepEqual(list(), [`pro\t${REL}\targent`]);
    assert.equal(queueFile().length, 1, 'la source doit rester en file tant que la page or manque');
  });

  test('page or presente : la source sort de la file', () => {
    silver(REL);
    gold(REL);
    assert.deepEqual(list(), []);
    assert.deepEqual(queueFile(), []);
  });

  test('page or sans fiche argent (page heritee reprise) : sort aussi', () => {
    gold(REL);
    assert.deepEqual(list(), []);
  });
});

describe('ce que la page or doit prouver', () => {
  beforeEach(() => put(`raw/pro/${REL}`, '# note inventee\n'));

  test('une page or qui cite un AUTRE brut ne compte pas', () => {
    enqueue([{ domain: 'pro', rel: REL }]);
    gold('meetings/2026-09-22-autre-note.md');
    assert.deepEqual(list(), [`pro\t${REL}\tneuf`]);
  });

  test('une page or de l\'AUTRE domaine ne compte pas', () => {
    enqueue([{ domain: 'pro', rel: REL }]);
    gold(REL, 'perso');
    assert.deepEqual(list(), [`pro\t${REL}\tneuf`]);
  });

  test('une page or hors de sources/ ne compte pas (meetings, concepts…)', () => {
    enqueue([{ domain: 'pro', rel: REL }]);
    put('wiki/pro/meetings/note-inventee.md', `---\ntype: meeting\nraw: ${REL}\n---\n`);
    assert.deepEqual(list(), [`pro\t${REL}\tneuf`]);
  });

  test('le brut disparu sort de la file, quoi qu\'il arrive', () => {
    enqueue([{ domain: 'pro', rel: 'meetings/jamais-existe.md' }]);
    assert.deepEqual(list(), []);
  });
});

describe('plusieurs sources et deux domaines', () => {
  test('chaque source porte son propre etat', () => {
    const A = 'meetings/2026-09-22-a.md';
    const B = 'meetings/2026-09-22-b.md';
    const C = 'meetings/2026-09-22-c.md';
    for (const rel of [A, B]) put(`raw/pro/${rel}`, '# invente\n');
    put(`raw/perso/${C}`, '# invente\n');
    enqueue([
      { domain: 'pro', rel: A },
      { domain: 'pro', rel: B },
      { domain: 'perso', rel: C },
    ]);
    silver(A, 'pro', 'a');
    gold(B, 'pro', 'b');
    silver(B, 'pro', 'b');
    assert.deepEqual(list(), [`pro\t${A}\targent`, `perso\t${C}\tneuf`]);
    assert.equal(queueFile().length, 2, 'seule B, entree dans l\'or, est retiree');
  });

  test('heritage/ n\'est pas parcouru : une fiche qui y vit ne vaut pas argent', () => {
    put(`raw/pro/${REL}`, '# invente\n');
    enqueue([{ domain: 'pro', rel: REL }]);
    put(`silver/pro/heritage/sources/note-inventee.md`, `---\nraw: ${REL}\ndomain: pro\n---\n`);
    assert.deepEqual(list(), [`pro\t${REL}\tneuf`]);
  });
});

// La gate admet page par page : la page source pouvait entrer et une page d'entite rester sous .candidats/,
// invisible du rapport. Une source n'est traitee que si aucune candidate ne la cite encore.
describe('candidates restantes : etat `candidats`', () => {
  const cand = (rel, text, domain = 'pro') => put(`.candidats/wiki/${domain}/${rel}`, text);
  beforeEach(() => {
    put(`raw/pro/${REL}`, '# note inventee\n');
    enqueue([{ domain: 'pro', rel: REL }]);
    silver(REL);
  });

  test('page source admise, page d\'entite restee : la source reste en file, la candidate est nommee', () => {
    gold(REL);
    cand('people/une-personne.md', '---\ntype: person\nsources: ["[[sources/note-inventee]]"]\n---\n');
    assert.deepEqual(list(), [`pro\t${REL}\tcandidats\tpeople/une-personne.md`]);
    assert.equal(queueFile().length, 1);
  });

  test('`sources:` en liste YAML sur plusieurs lignes', () => {
    gold(REL);
    cand('concepts/une-notion.md', '---\ntype: concept\nsources:\n  - "[[sources/autre]]"\n  - "[[sources/note-inventee]]"\ntags: []\n---\n');
    assert.deepEqual(list(), [`pro\t${REL}\tcandidats\tconcepts/une-notion.md`]);
  });

  test('rien n\'est encore admis : la candidate source et ses pages liees, en ordre', () => {
    cand('sources/note-inventee.md', `---\ntype: source\nraw: ${REL}\n---\n`);
    cand('meetings/note-inventee.md', '---\ntype: meeting\nsources: [[[sources/note-inventee]]]\n---\n');
    assert.deepEqual(list(), [`pro\t${REL}\tcandidats\tmeetings/note-inventee.md,sources/note-inventee.md`]);
  });

  test('une candidate qui cite une AUTRE source ne retient pas celle-ci', () => {
    gold(REL);
    cand('people/une-personne.md', '---\ntype: person\nsources: ["[[sources/autre]]"]\n---\n');
    assert.deepEqual(list(), []);
  });

  test('un slug qui en prolonge un autre ne compte pas (note-inventee-bis)', () => {
    gold(REL);
    cand('people/une-personne.md', '---\ntype: person\nsources: ["[[sources/note-inventee-bis]]"]\n---\n');
    assert.deepEqual(list(), []);
  });

  test('la citation dans le CORPS ne compte pas : seul le frontmatter est lu', () => {
    gold(REL);
    cand('people/une-personne.md', '---\ntype: person\nsources: []\n---\nVu dans [[sources/note-inventee]].\n');
    assert.deepEqual(list(), []);
  });

  test('une candidate de l\'AUTRE domaine ne compte pas', () => {
    gold(REL);
    cand('people/une-personne.md', '---\ntype: person\nsources: ["[[sources/note-inventee]]"]\n---\n', 'perso');
    assert.deepEqual(list(), []);
  });
});

describe('add et queue', () => {
  test('add refuse une source dont le brut n\'existe pas', () => {
    const r = run('add', 'pro', 'meetings/fantome.md');
    assert.notEqual(r.status, 0);
  });

  test('add refuse un domaine inconnu', () => {
    put(`raw/pro/${REL}`, '# invente\n');
    assert.notEqual(run('add', 'autre', REL).status, 0);
  });

  test('add est idempotent : deux fois la meme source, une seule entree', () => {
    put(`raw/pro/${REL}`, '# invente\n');
    run('add', 'pro', REL);
    run('add', 'pro', REL);
    assert.equal(queueFile().length, 1);
  });

  test('queue sans photo prealable echoue plutot que de tout enfiler', () => {
    put(`raw/pro/${REL}`, '# invente\n');
    assert.notEqual(run('queue').status, 0);
  });

  test('queue n\'enfile que ce qui est apparu depuis la photo', () => {
    put('raw/pro/meetings/deja-la.md', '# invente\n');
    run('snapshot');
    put(`raw/pro/${REL}`, '# invente\n');
    run('queue');
    assert.deepEqual(queueFile(), [{ domain: 'pro', rel: REL }]);
  });
});
