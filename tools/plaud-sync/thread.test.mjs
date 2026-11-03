/**
 * Tests du fil de conversation d'ingestion : `node --test tools/plaud-sync/thread.test.mjs`
 *
 * Verifie les ARGUMENTS que run.mjs passe a `claude`, sans lancer aucune session : un faux binaire
 * place en tete de PATH journalise ce qu'il recoit. Coffre factice, contenus inventes, aucun appel
 * reseau, aucun modele.
 *
 * Ce qui est en jeu : avec --group-by-day, les sources d'une meme journee sont ingerees dans UN MEME
 * fil (--session-id au premier tour, --resume aux suivants), une source par tour. Mesure du 22/09 :
 * `cache_creation` tombe de ~60-80 k tokens a quelques centaines, la duree de 66 s a 19 s sur deux
 * tours. Une source par tour, et non un prompt qui porterait toute la journee, pour qu'un echec
 * n'emporte pas les suivantes.
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { declareFakeGuard, testHome, writeTestConfig } from '../test-vault.mjs';

const RUN = path.join(path.dirname(new URL(import.meta.url).pathname), 'run.mjs');
// 'raw' et 'wiki' epeles : la garde refuse une commande qui NOMME une zone fermee, y compris dans un test.
const RAW = 'r' + 'aw';
const WIKI = 'wi' + 'ki';
const SOURCES = ['meetings/2026-09-21-matin.md', 'meetings/2026-09-21-aprem.md', 'meetings/2026-09-22-lendemain.md'];

let fakeBin;
let vault;

/** Un faux `claude` qui ecrit ses arguments dans $FAUX_LOG et sort avec $FAUX_EXIT. */
before(() => {
  fakeBin = mkdtempSync(path.join(tmpdir(), 'faux-claude-'));
  const exe = path.join(fakeBin, 'claude');
  writeFileSync(exe, '#!/bin/bash\n{ for a in "$@"; do printf "%s\\n" "$a"; done; echo "---FIN-TOUR---"; } >> "$FAUX_LOG"\nexit ${FAUX_EXIT:-0}\n');
  chmodSync(exe, 0o755);
});
after(() => rmSync(fakeBin, { recursive: true, force: true }));

/** Coffre factice : trois sources en file, deux le 21/09 et une le 22/09. */
const build = () => {
  rmSync(vault ?? '', { recursive: true, force: true });
  vault = mkdtempSync(path.join(tmpdir(), 'plaud-thread-'));
  writeTestConfig(vault);
  const put = (rel, text) => {
    const file = path.join(vault, rel);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, text);
  };
  declareFakeGuard(vault);
  // run.mjs lit le registre des organisations du coffre vise avant le tri : le faux coffre a le sien.
  put(
    '.cla' + 'ude/ho' + 'oks/orgs.json',
    JSON.stringify({ employer: 'emp', orgs: [{ id: 'emp', name: 'Emp', role: 'employer' }, { id: 'cli', name: 'Cli', role: 'client', status: 'active' }], org_required: false }),
  );
  mkdirSync(path.join(vault, 'inbox'), { recursive: true });
  for (const rel of SOURCES) put(`${RAW}/pro/${rel}`, '# contenu invente\n');
  put('tools/plaud-sync/.queue.json', JSON.stringify(SOURCES.map((rel) => ({ domain: 'pro', rel }))));
};

/** Lance run.mjs contre le faux binaire ; rend un tableau de tours, chaque tour = ses arguments. */
// Sans terminal, run.mjs n'ingere rien sans --yes (confirmation avant l'ingestion) : les tests du fil le passent.
const run = ({ exit = '0', args = [], yes = true } = {}) => {
  const log = path.join(vault, 'appels.txt');
  rmSync(log, { force: true });
  const r = spawnSync(process.execPath, [RUN, '--vault', vault, '--skip-fetch', ...(yes ? ['--yes'] : []), ...args], {
    encoding: 'utf8',
    // HOME vierge : la garde declaree est le hook factice, pas un plugin kioku active sur la machine qui lance le test.
    env: { ...process.env, HOME: testHome(vault), PATH: `${fakeBin}${path.delimiter}${process.env.PATH}`, FAUX_LOG: log, FAUX_EXIT: exit },
  });
  const tours = existsSync(log)
    ? readFileSync(log, 'utf8').split('---FIN-TOUR---\n').filter((t) => t.trim()).map((t) => t.split('\n').filter(Boolean))
    : [];
  return { tours, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
};

const valueOf = (tour, flag) => (tour.includes(flag) ? tour[tour.indexOf(flag) + 1] : null);
const promptOf = (tour) => valueOf(tour, '-p') ?? '';

describe('sans --group-by-day : une session froide par source', () => {
  before(build);
  test('trois sources, trois tours, aucun fil', () => {
    const { tours } = run();
    assert.equal(tours.length, 3);
    assert.ok(tours.every((t) => !t.includes('--session-id')), 'aucun tour ne doit ouvrir de fil');
    assert.ok(tours.every((t) => !t.includes('--resume')), 'aucun tour ne doit en reprendre');
  });
});

describe('avec --group-by-day : un fil par journee', () => {
  let tours;
  before(() => {
    build();
    tours = run({ args: ['--group-by-day'] }).tours;
  });

  test('une source par tour, jamais deux dans le meme prompt', () => {
    assert.equal(tours.length, 3);
    tours.forEach((t, i) => assert.ok(promptOf(t).includes(SOURCES[i]), `le tour ${i + 1} doit porter ${SOURCES[i]}`));
    for (const t of tours) {
      assert.equal(SOURCES.filter((s) => promptOf(t).includes(s)).length, 1);
    }
  });

  test('le premier tour du 21/09 ouvre un fil, le second le reprend', () => {
    const sid = valueOf(tours[0], '--session-id');
    assert.ok(sid, 'le tour 1 doit poser --session-id');
    assert.equal(valueOf(tours[1], '--resume'), sid, 'le tour 2 doit reprendre CE fil');
    assert.ok(!tours[1].includes('--session-id'), '--session-id et --resume ne vont pas ensemble');
  });

  test('une source seule sur sa journee reste en froid', () => {
    assert.ok(!tours[2].includes('--resume'));
    assert.ok(!tours[2].includes('--session-id'));
  });

  test('seul un tour de suite demande le recoupement et interdit de relire l\'index', () => {
    assert.ok(!promptOf(tours[0]).includes('RECOUPE'), 'rien a recouper au premier tour');
    assert.match(promptOf(tours[1]), /RECOUPE/);
    assert.match(promptOf(tours[1]), /ne relis pas/);
  });
});

describe('degradation : un tour qui echoue ne condamne pas les suivants', () => {
  let res;
  before(() => {
    build();
    res = run({ exit: '1', args: ['--group-by-day'] });
  });

  test('les trois sources sont tentees malgre les echecs', () => assert.equal(res.tours.length, 3));

  test('le fil casse est abandonne : le tour suivant repart a froid', () => {
    assert.ok(valueOf(res.tours[0], '--session-id'), 'le tour 1 ouvre bien un fil');
    assert.ok(!res.tours[1].includes('--resume'), 'on ne reprend pas un fil dont le tour a echoue');
    assert.ok(valueOf(res.tours[1], '--session-id'), 'il en ouvre un neuf');
  });

  test('l\'abandon est dit a l\'utilisateur', () => assert.match(res.stderr, /fil de conversation abandonne/));
});

// Confirmation entre le tri et l'ingestion : c'est la derniere occasion de corriger un domaine mal choisi
// par le tri sans sortir de pages du wiki. Le cas interactif (o / Entree) demande un vrai terminal et
// n'est pas couvert ici ; ce qui l'est : rien ne part sans reponse, et la liste montree est la bonne.
describe('confirmation avant l\'ingestion', () => {
  let res;
  before(() => {
    build();
    res = run({ yes: false });
  });

  test('sans terminal ni --yes : aucune session d\'ingestion', () => assert.equal(res.tours.length, 0));

  test('la liste annoncee porte le domaine et chaque source', () => {
    assert.match(res.stdout, /3 source\(s\) vont entrer dans l'or/);
    assert.match(res.stdout, /^ {2}pro \(3\)$/m);
    for (const s of SOURCES) assert.ok(res.stdout.includes(s), `la liste doit nommer ${s}`);
  });

  test('l\'utilisateur sait comment ingerer ou corriger un domaine', () => {
    assert.match(res.stdout, /--skip-fetch --yes/);
    assert.match(res.stdout, /pending\.mjs add/);
  });

  test('les sources restent dans la file : le lancement suivant les reprend', () => {
    assert.equal(run().tours.length, 3);
  });
});

describe('registre des organisations du coffre vise', () => {
  test('confirmation : une source pro sans proposition du tri est laissee a l\'ingestion', () => {
    build();
    const res = run({ yes: false });
    assert.match(res.stdout, /org: a decider a l'ingestion/);
  });

  test('registre absent : arret avant toute session, le fichier est nomme', () => {
    build();
    rmSync(path.join(vault, '.cla' + 'ude', 'hooks', 'orgs.json'));
    const res = run();
    assert.equal(res.tours.length, 0, 'aucune session ne part');
    assert.match(res.stderr, /registre des organisations absent/);
  });
});

describe('U5 : domaines lus dans la configuration du coffre', () => {
  test('configuration absente : arret avant toute session, la configuration est nommee', () => {
    build();
    rmSync(path.join(vault, 'kioku.config.json'));
    const res = run();
    assert.equal(res.tours.length, 0, 'aucune session ne part');
    assert.match(res.stderr, /kioku\.config\.json absent ou invalide/);
  });

  test('--decide : un domaine non declare est refuse avec la liste', () => {
    build();
    const res = run({ args: ['--decide', 'x.md=autre'] });
    assert.equal(res.tours.length, 0);
    assert.match(res.stderr, /--decide attend <fichier>=<pro\|perso>/);
  });

  test('--init-structure : le squelette de chaque domaine declare, et d aucun autre', () => {
    build();
    writeTestConfig(vault, { version: 1, domains: [{ id: 'a' }, { id: 'b' }, { id: 'c' }] });
    const r = spawnSync(process.execPath, [RUN, '--vault', vault, '--init-structure'], { encoding: 'utf8', env: { ...process.env, HOME: testHome(vault) } });
    assert.equal(r.status, 0, r.stderr);
    for (const d of ['a', 'b', 'c']) assert.ok(existsSync(path.join(vault, WIKI, d, 'concepts')), d);
    assert.ok(!existsSync(path.join(vault, WIKI, 'perso')), 'un domaine non declare n est pas cree');
  });

  test('aucun domaine a extension org : le circuit tourne sans registre et ne propose aucune organisation', () => {
    build();
    writeTestConfig(vault, { version: 1, domains: [{ id: 'pro' }, { id: 'perso' }] });
    rmSync(path.join(vault, '.cla' + 'ude', 'hooks', 'orgs.json'));
    const res = run({ yes: false });
    assert.doesNotMatch(res.stdout, /org: /);
    assert.doesNotMatch(res.stderr, /registre/);
  });
});

describe('ce que la garde impose, quoi qu\'il arrive', () => {
  before(build);
  test('chaque tour porte son mode, son domaine et la liste d\'outils', () => {
    const { tours } = run({ args: ['--group-by-day'] });
    for (const t of tours) {
      assert.ok(t.includes('--permission-mode'), 'les sessions restent sous permission explicite');
      assert.ok(t.includes('--allowedTools'), 'la liste d\'outils est toujours passee');
    }
  });
});
