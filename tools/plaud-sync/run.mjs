#!/usr/bin/env node
/**
 * Plaud -> coffre, en une commande (Windows, macOS, Linux : Node seulement) :
 * depot dans l'entrant, tri, ingestion bronze -> argent -> or, rapport.
 *
 *   node tools/plaud-sync/run.mjs                         depuis 7 jours
 *   node tools/plaud-sync/run.mjs --since 2026-09-14
 *   node tools/plaud-sync/run.mjs --dry-run               montre ce qui serait depose, ne lance aucune session
 *   node tools/plaud-sync/run.mjs --skip <id Plaud>       ecarte un enregistrement (repetable) : consigne dans seen.json, jamais redepose
 *   node tools/plaud-sync/run.mjs --skip-fetch            tri + ingestion de ce qui est deja dans l'entrant / la file
 *   node tools/plaud-sync/run.mjs --group-by-day          une session par JOURNEE et par domaine, au lieu d'une par source :
 *                                                         les seances d'un meme jour se recoupent et l'index n'est relu qu'une fois
 *   node tools/plaud-sync/run.mjs --vault <dossier>       vise un autre coffre que celui du script (ex. depuis un worktree)
 *   node tools/plaud-sync/run.mjs --allow-worktree        accepte de tourner dans un worktree git
 *   node tools/plaud-sync/run.mjs --init-structure        donne a chaque domaine declare le meme squelette : les 8 dossiers
 *                                                         (un .gitkeep si vide) et overview.md s'il manque. Aucun contenu de page.
 *   node tools/plaud-sync/run.mjs --skip-fetch --decide <fichier-de-l-entrant>=<domaine>
 *                                                         tranche une source que le tri avait laissee (repetable) :
 *                                                         la decision de l'utilisateur est transmise a la session de tri,
 *                                                         qui range sans s'abstenir. Le script ne deplace rien lui-meme.
 *   node tools/plaud-sync/run.mjs --drop <fichier-de-a-trancher>
 *                                                         ecarte pour de bon une source parquee (repetable) : son plaud_id
 *                                                         passe « ecarte » dans seen.json, le fichier et sa raison sont
 *                                                         supprimes. Ni fetch, ni session. Refus si pas de plaud_id.
 *   node tools/plaud-sync/run.mjs --yes                  ingere sans demander (voir ci-dessous) ; requis sans terminal
 *
 * Entre le tri et l'ingestion, le script montre ce qui va entrer dans l'or, par domaine, et demande confirmation
 * (Entree = non). C'est le dernier moment ou une erreur de domaine du tri se corrige sans effort : apres, la
 * source est dans le wiki du mauvais domaine et seul le relecteur peut encore la retenir. Sans terminal, pas de
 * reponse possible : rien n'est ingere sans --yes.
 *
 * Rien n'est contourne : chaque etape est une session `claude -p` lancee avec VAULT_MODE / VAULT_DOMAIN, donc
 * sous la garde Kioku, exactement comme avec tools/vault.mjs. Le tri s'abstient au moindre
 * doute (la source reste dans l'entrant), la gate retient ce qui doit l'etre (quarantaine). Ce script ne juge rien :
 * il verifie sur les fichiers, jamais sur ce qu'une session declare, et rapporte ce qui reste.
 * Code de sortie : 0 tout est range et ingere ; 2 il reste des sources a reprendre ou a trancher ; 1 erreur.
 */

import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readdirSync, renameSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import { dropParked, pruneReasons } from './drop.mjs';
import { acquire, release } from './lock.mjs';
import { CORE_BIN, withCorePath } from '../core-path.mjs';
import { skill } from '../names.mjs';
import { startupRefusal } from '../startup-guard.mjs';
import { isVault, loadConfig, vaultRoot } from '../vault-config.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const flag = (n) => argv.includes(n);
const opt = (n) => {
  const i = argv.indexOf(n);
  return i >= 0 ? argv[i + 1] : undefined;
};

const VAULT = vaultRoot(opt('--vault'));
const SINCE = opt('--since') ?? new Date(Date.now() - 7 * 86_400_000).toISOString().slice(0, 10);
const WIN = process.platform === 'win32';
const FETCH = path.join(HERE, 'fetch-notes.mjs');
const PENDING = path.join(HERE, 'pending.mjs');
// La gate s'appelle `kioku <commande>` (bin/ du core en tete du PATH des sessions, voir core-path.mjs).
const KIOKU = path.join(CORE_BIN, 'kioku');
const INBOX = path.join(VAULT, 'inbox');
const TOOLS = 'Read,Write,Edit,Glob,Grep,Agent,Bash(kioku:*),Bash(mv:*)';

const title = (text) => console.log(`\n== ${text}`);
const fail = (msg) => {
  console.error(`Erreur : ${msg}`);
  process.exit(1);
};

// Un coffre porte une configuration lisible (kioku.config.json) : c'est elle qui dit ses domaines. Sans elle, rien ne part.
if (!isVault(VAULT)) fail(`${VAULT} n'est pas un coffre (kioku.config.json absent ou invalide).`);
const CFG = loadConfig(VAULT);
const DOMAINS = CFG.domains;
// Squelette commun a tous les domaines declares (CLAUDE.md §3). Aucune session ne peut creer ces dossiers ni overview.md : la garde ne laisse
// ecrire que index.md et log.md sous wiki/. Un dossier n'apparait donc pas tout seul avant sa premiere page ; ce script le fait a la demande.
if (flag('--init-structure')) {
  const FOLDERS = ['sources', 'meetings', 'people', 'organizations', 'projects', 'concepts', 'decisions', 'syntheses'];
  const today = new Date().toISOString().slice(0, 10);
  for (const domain of DOMAINS) {
    const root = path.join(VAULT, 'wiki', domain);
    for (const folder of FOLDERS) {
      const dir = path.join(root, folder);
      mkdirSync(dir, { recursive: true });
      if (readdirSync(dir).length === 0) {
        writeFileSync(path.join(dir, '.gitkeep'), '');
        console.log(`cree     wiki/${domain}/${folder}/`);
      }
    }
    const overview = path.join(root, 'overview.md');
    if (!existsSync(overview)) {
      writeFileSync(
        overview,
        `---\ntype: overview\ntitle: "Vue d'ensemble — ${domain}"\ncreated: ${today}\nupdated: ${today}\nstatus: draft\n---\n\n# Vue d'ensemble\n\n> Synthèse narrative vivante. Différent de [[index]], qui est un catalogue plat de pages.\n> Première synthèse à écrire quand ce domaine aura assez de pages.\n`,
        { flag: 'wx' },
      );
      console.log(`cree     wiki/${domain}/overview.md`);
    }
  }
  console.log('Squelette a jour.');
  process.exit(0);
}

// inbox/ n'est jamais versionne : dans un worktree il serait cree dans un dossier jetable, hors du vrai coffre.
if (statSync(path.join(VAULT, '.git'), { throwIfNoEntry: false })?.isFile() && !flag('--allow-worktree')) {
  fail("ce dossier est un worktree git : son inbox/ n'est pas celui du coffre. Lance depuis le checkout principal, ou --vault <checkout principal>, ou --allow-worktree.");
}

// Tous les enfants visent CE coffre (fetch-notes et pending lisent CLAUDE_PROJECT_DIR).
// Les sessions claude -p attendent le plugin avant leur premier tour : sans lui, la garde manquerait.
const baseEnv = { ...withCorePath(process.env), CLAUDE_PROJECT_DIR: VAULT, CLAUDE_CODE_SYNC_PLUGIN_INSTALL: '1' };
// Pas de session sans garde. Seuls le dry-run et --drop n'en ouvrent aucune (--decide passe par la session de tri).
if (!flag('--dry-run') && !flag('--drop')) {
  const refusal = startupRefusal(VAULT);
  if (refusal) fail(`sessions refusees : ${refusal}`);
}
const quote = (a) => (WIN ? `"${String(a).replace(/"/g, '\\"')}"` : a); // cmd.exe : la garde et les prompts contiennent des espaces et des parentheses

/** Un script Node du coffre ; capture la sortie si demande. */
const node = (script, args = [], { capture = false } = {}) =>
  spawnSync(process.execPath, [script, ...args], { cwd: VAULT, env: baseEnv, encoding: 'utf8', stdio: capture ? ['ignore', 'pipe', 'inherit'] : ['ignore', 'inherit', 'inherit'] });

/**
 * Une session sous la garde : mode et domaine se lisent dans l'environnement, comme dans vault.mjs.
 *
 * `keep` enchaine plusieurs tours DANS LA MEME conversation : le premier pose l'identifiant
 * (`--session-id`), les suivants la reprennent (`--resume`). Ce qui a deja ete lu reste en contexte.
 * Mesure du 22/09 sur un fichier de 82 ko, deux tours : `cache_creation` tombe de ~60-80 k tokens a
 * 54-433, la duree de 66 s a 19 s. Le cout en dollars, lui, ne baisse que d'environ un quart et pas
 * toujours : le contexte accumule est relu a chaque tour et il grossit. Le gain est sur le TEMPS.
 * Un tour qui echoue ne condamne pas les suivants : on repart en froid pour ne pas rester bloque.
 */
/** Un fil de conversation par cle (ici : domaine + journee). */
const threads = new Map();
const session = (mode, domain, prompt, keep = null) => {
  const thread = keep ? (threads.get(keep) ?? null) : null;
  const args = ['-p', prompt, '--permission-mode', 'acceptEdits', '--allowedTools', TOOLS];
  if (keep) args.push(...(thread ? ['--resume', thread] : ['--session-id', (threads.set(keep, randomUUID()), threads.get(keep))]));
  const r = spawnSync('claude', WIN ? args.map(quote) : args, {
    cwd: VAULT,
    env: { ...baseEnv, VAULT_MODE: mode, VAULT_DOMAIN: domain },
    stdio: ['ignore', 'pipe', 'inherit'],
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    shell: WIN,
  });
  if (r.error) fail(`impossible de lancer claude : ${r.error.message}`);
  if (r.stdout) process.stdout.write(r.stdout);
  // Un identifiant refuse (« already in use ») ou une reprise impossible : le fil est abandonne, la
  // source suivante repart en froid. Mieux vaut relire le contexte que perdre la source.
  if (keep && r.status !== 0) {
    console.warn(`  (fil de conversation abandonne pour cette journee : le tour a rendu ${r.status ?? 1}, la suite repartira a froid)`);
    threads.delete(keep);
  }
  return { code: r.status ?? 1, out: r.stdout ?? '' };
};

// Les indecis : rien n'est classe, ils attendent l'utilisateur dans inbox/a-trancher/ (local, jamais versionne, comme inbox/).
const PARKED = path.join(INBOX, 'a-trancher');
const REASONS = path.join(PARKED, '_raisons.md');
const mdIn = (dir) => (existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.md') && !f.startsWith('_')) : []);
const inbox = () => mdIn(INBOX);
const parked = () => mdIn(PARKED);
const logReason = (file, reason) => {
  mkdirSync(PARKED, { recursive: true });
  appendFileSync(REASONS, `- ${file} (${new Date().toISOString().slice(0, 10)}) : ${reason}\n`);
};
const park = (file, reason) => {
  mkdirSync(PARKED, { recursive: true });
  renameSync(path.join(INBOX, file), path.join(PARKED, file));
  logReason(file, reason);
};

// Decisions explicites de l'utilisateur sur des indecis (--decide fichier=domaine) : transmises a la session de tri, qui range.
const decisions = argv.flatMap((a, i) => (a === '--decide' ? [argv[i + 1] ?? ''] : [])).map((d) => {
  const [file, domain] = d.split('=');
  if (!file || !DOMAINS.includes(domain)) fail(`--decide attend <fichier>=<${DOMAINS.join('|')}>, recu "${d}".`);
  return { file, domain };
});

// `pending.mjs list` rend <domaine>\t<chemin>\t<etat>, etat = neuf | argent (redigee mais pas entree dans l'or).
const queue = () =>
  (node(PENDING, ['list'], { capture: true }).stdout ?? '')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      const [domain, rel, state = 'neuf'] = l.split('\t');
      return { domain, rel, state };
    });

// 0. Verrou : un seul lanceur a la fois sur ce coffre. Sans lui, un second lancement pendant une ingestion
// relit la file (l'entree n'en sort qu'une fois la fiche argent ecrite) et lance une DEUXIEME session sur la
// meme source : memes candidates ecrites deux fois, relecture sur une empreinte qui bouge, et index.md / log.md
// (tenus en ajout) doubles. Un verrou dont le processus est mort est repris tout seul. Pas de verrou en
// dry-run : il ne lance aucune session et n'ecrit rien.
if (!flag('--dry-run')) {
  const lock = acquire(VAULT);
  if (!lock.ok) {
    fail(
      `un autre lancement est en cours sur ce coffre (PID ${lock.held.pid}${lock.held.started ? `, depuis ${lock.held.started}` : ''}).\n` +
        `Attends qu'il finisse, ou arrete-le : kill ${lock.held.pid}. Le verrou se libere tout seul (tools/plaud-sync/.lock.json).`,
    );
  }
  if (lock.stale) console.log(`Verrou perime repris (PID ${lock.stale.pid} n'existe plus).`);
  // Un arret par signal ne passe pas par 'exit' : ce verrou-la reste sur le disque, et c'est la reprise
  // du verrou perime qui le rattrape au lancement suivant. Rien a supprimer a la main.
  process.on('exit', () => release(VAULT));
}

// Ecart d'indecis (--drop fichier) : consigne dans seen.json, supprime, puis s'arrete. Sous le verrou, et sans fetch
// ni session : ecarter ne doit rien deposer ni ingerer d'autre.
// `--drop a b c` comme `--drop a --drop b` : chaque --drop prend les arguments qui le suivent jusqu'au prochain --option
// (pour `npm run plaud:drop -- a b c`).
const drops = argv.flatMap((a, i) => {
  if (a !== '--drop') return [];
  const end = argv.findIndex((x, j) => j > i && x.startsWith('--'));
  const files = argv.slice(i + 1, end < 0 ? undefined : end);
  return files.length ? files : [''];
});
if (drops.length) {
  if (flag('--dry-run')) fail('--drop ne se combine pas avec --dry-run.');
  let failed = 0;
  for (const file of drops) {
    const r = dropParked(VAULT, file);
    if (r.ok) console.log(`ecarte   ${file}  (${r.id}${r.registered ? '' : ', deja dans seen.json'})`);
    else (failed++, console.error(`REFUSE   ${file} : ${r.reason}`));
  }
  console.log(`\n${drops.length - failed} / ${drops.length} ecartee(s). seen.json est versionne : a commiter.`);
  process.exit(failed ? 2 : 0);
}

// Le registre des organisations du coffre vise (--vault), pas celui de la session qui lance ce script : celui que
// declare l'extension org de la configuration. Declare mais absent ou invalide : rien ne part, le tri ne saurait pas
// ce que couvre ce domaine. Aucun domaine a extension org : le tri ne propose aucune organisation.
// (--drop, plus haut, n'en a pas besoin : le module est charge ici, a la demande, pour que --drop et --init-structure marchent sans lui.)
const { loadOrgs, orgLabel, orgTarget, parseOrgLines, triagePrompt } = await import('./org-proposals.mjs');
const target = orgTarget(VAULT);
const ORG_DOMAIN = target?.domain ?? null;
let orgs = null;
if (target) {
  try {
    orgs = loadOrgs(VAULT, target.registry);
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
}
const triageScope = { domains: DOMAINS.map((id) => CFG.domain(id)), orgDomain: ORG_DOMAIN };
// Les organisations proposees par le tri, par source du domaine a extension org (chemin relatif a raw/<domaine>/).
let orgProposals = new Map();

// 1. Depot dans l'entrant (sans domaine : rien n'est classe ici)
if (!flag('--skip-fetch')) {
  title(`Plaud -> inbox (depuis ${SINCE})`);
  const skips = argv.flatMap((a, i) => (a === '--skip' ? ['--skip', argv[i + 1] ?? ''] : []));
  const r = node(FETCH, ['--since', SINCE, ...skips, ...(flag('--dry-run') ? ['--dry-run'] : [])]);
  if (r.status !== 0) fail('fetch-notes a echoue (voir ci-dessus). Premiere connexion : npx -y @plaud-ai/mcp@latest');
}
if (flag('--dry-run')) {
  console.log('\nDry-run : aucune session lancee.');
  process.exit(0);
}

// 2. Tri : session triage, automatique. La photo de raw/ avant/apres dit ce qui est range ; les indecis sont parques.
// Sans decision explicite, inbox/a-trancher/ n'est pas re-trie : une source indecise ne bloque pas les lancements suivants.
const decided = decisions.map((d) => (existsSync(path.join(PARKED, d.file)) ? `a-trancher/${d.file}` : d.file));
const toSort = [...new Set([...inbox(), ...decided])];
if (toSort.length) {
  title(`Tri de ${toSort.length} source(s) de l'entrant`);
  node(PENDING, ['snapshot'], { capture: true });
  // Le tri ne lit aucun domaine : la garde ne lui ouvre que inbox/. Le domaine passe ici ne sert qu'a la garde.
  const { code, out } = session('triage', DOMAINS[0], triagePrompt(orgs, toSort, decisions, triageScope));
  node(PENDING, ['queue']);
  if (code !== 0) console.warn(`Attention : la session de tri a rendu le code ${code}.`);
  if (orgs) orgProposals = parseOrgLines(out, orgs, undefined, ORG_DOMAIN);
  // Les raisons dites par la session ; ce qu'elle a laisse dans l'entrant sans rien ranger est parque par le script (parquer ne classe rien).
  const why = new Map([...out.matchAll(/^ABSTENTION\s+(\S+)\s*:\s*(.+)$/gm)].map((m) => [path.basename(m[1]), m[2].trim()]));
  const leftover = new Set(inbox());
  for (const [f, reason] of why) if (!leftover.has(f) && existsSync(path.join(PARKED, f))) logReason(f, reason);
  for (const f of leftover) park(f, why.get(f) ?? "tri sans resultat : la session ne l'a ni rangee ni signalee");
} else {
  console.log('\nEntrant vide : rien a trier.');
}

// 3. Ingestion : une session par source, dans le domaine de son dossier raw/<domaine>/
// Une source deja redigee (etat `argent`) n'est pas reprise depuis le debut : sa session a ete interrompue
// entre les candidates et la gate, et tout reecrire invaliderait les verdicts deja rendus sur ces pages.
//
// --group-by-day regroupe les sources d'une MEME JOURNEE et d'un MEME DOMAINE dans une seule session. Motif :
// trois seances du 21/09 ont ete ingerees par trois sessions qui ont chacune relu l'index en entier sans jamais
// se recouper, alors que la deuxieme eclairait la premiere et que la troisieme rouvrait une meme question
// d'identite pour la troisieme fois. Une session par journee mutualise cette lecture et recoupe les seances.
// Opt-in : plus de pages en vol, une session qui echoue en perd davantage (la reprise `argent` amortit).
const byDay = (entries) => {
  const groups = new Map();
  for (const e of entries) {
    const day = path.basename(e.rel).match(/^(\d{4}-\d{2}-\d{2})/)?.[1];
    // Sans date dans le nom, la source reste seule : on ne devine pas sa journee.
    const key = day ? `${e.domain}\u0000${day}` : `${e.domain}\u0000${e.rel}`;
    groups.set(key, [...(groups.get(key) ?? []), e]);
  }
  return [...groups.values()];
};

// Le rappel de reprise : une ingestion interrompue entre les candidates et la gate ne se refait pas de zero.
const resumeNote = (domain) =>
  ` ; une fiche argent existe deja et des candidates ont pu etre ecrites sous .candidats/wiki/${domain}/ : ` +
  `NE REECRIS PAS ce qui est deja conforme (un verdict est lie a l'empreinte exacte d'une page, la reecrire l'invalide). ` +
  `Reprends la ou l'ingestion s'est arretee : redige ce qui manque, puis deroule la gate (check, relecteur, promote), puis index et log.`;

const todo = queue();

// 2 bis. Confirmation : ce qui va entrer dans l'or, par domaine, avant toute session d'ingestion.
// Le tri est automatique ; un mauvais domaine se corrige ici en deplacant un fichier, apres il faudrait sortir
// des pages du wiki. Entree = non : une ingestion ne part pas par reflexe.
let go = todo.length > 0;
if (go) {
  title(`Avant l'ingestion : ${todo.length} source(s) vont entrer dans l'or`);
  for (const domain of DOMAINS) {
    const mine = todo.filter((e) => e.domain === domain);
    if (!mine.length) continue;
    console.log(`  ${domain} (${mine.length})`);
    for (const { rel, state } of mine) {
      const org = domain === ORG_DOMAIN ? `  ${orgLabel(orgProposals.get(rel))}` : '';
      console.log(`    ${rel}${org}${state === 'argent' ? '  [reprise : fiche argent deja ecrite]' : ''}`);
    }
  }
  if (flag('--yes')) {
    console.log('--yes : ingestion sans confirmation.');
  } else if (!process.stdin.isTTY) {
    console.log('Pas de terminal pour confirmer : rien n\'est ingere. Relance avec --skip-fetch --yes pour ingerer cette liste.');
    go = false;
  } else {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const a = (await rl.question('Ingerer cette liste ? [o]ui / [N]on ')).trim().toLowerCase();
    rl.close();
    go = ['o', 'oui', 'y', 'yes'].includes(a);
  }
  if (!go) {
    console.log(
      'Ingestion annulee : les sources restent dans raw/ et dans la file, rien n\'est ecrit.\n' +
        'Une source dans le mauvais domaine (etat neuf seulement) : deplace-la, remets-la dans la file, relance :\n' +
        '  mv raw/<de>/<chemin> raw/<vers>/<chemin>\n' +
        '  node tools/plaud-sync/pending.mjs add <vers> <chemin>\n' +
        '  node tools/plaud-sync/run.mjs --skip-fetch',
    );
  }
}
const groups = !go ? [] : flag('--group-by-day') ? byDay(todo) : todo.map((e) => [e]);
for (const group of groups) {
  const { domain } = group[0];
  const day = path.basename(group[0].rel).slice(0, 10);
  // Une source par TOUR, dans un meme fil : la source 2 garde en contexte ce que la 1 a lu et ecrit,
  // donc elle la recoupe sans la relire. Et une source qui echoue ne condamne pas les suivantes,
  // contrairement a un prompt unique qui aurait porte toute la journee.
  const thread = group.length > 1 ? `${domain}\u0000${day}` : null;
  if (thread) title(`Ingestion ${domain} : ${group.length} sources du ${day} (un fil de conversation)`);
  group.forEach(({ rel, state }, i) => {
    const suite = thread && i > 0;
    if (thread) console.log(`\n-- ${i + 1}/${group.length} : ${rel}`);
    else title(`Ingestion ${domain} : ${rel}${state === 'argent' ? ' (reprise : fiche argent deja ecrite)' : ''}`);
    const proposed = domain === ORG_DOMAIN ? orgProposals.get(rel) : undefined;
    const prompt =
      `${skill('ingest')} ${rel}` +
      (proposed ? ` ; organisation proposee par le tri : ${proposed.join(',')} (a confirmer ou corriger sur le contenu)` : '') +
      (suite
        ? ` ; tu viens d'ingerer une ou plusieurs sources de la MEME JOURNEE, elles sont encore dans ton contexte : ` +
          `RECOUPE cette source avec elles (une seance de l'apres-midi confirme, precise ou contredit celle du matin) ` +
          `et ne relis pas l'index ni les pages que tu as deja lues. Ajoute ton entree de journal a la suite ; ` +
          `pour l'index, complete la ligne de la journee plutot que d'en ouvrir une nouvelle.`
        : '') +
      (state === 'argent' ? resumeNote(domain) : '');
    const { code } = session('ingest', domain, prompt, thread);
    if (code !== 0) console.warn(`Attention : la session d'ingestion a rendu le code ${code}.`);
  });
}

// 4. Rapport, sur les fichiers. « Ingeree » = la PAGE OR existe, pas la fiche argent (cf. pending.mjs).
title('Rapport');
// Une source tranchee (--decide) quitte a-trancher/ par un mv de la session de tri : sa raison, elle, resterait.
pruneReasons(VAULT);
const left = queue();
const undecided = parked();
console.log(`Ingerees (page or presente) : ${todo.length - left.length} / ${todo.length}`);
if (left.length) {
  console.log('PAS entrees dans l\'or (a reprendre : relance avec --skip-fetch) :');
  for (const { domain, rel, state } of left) {
    console.log(`  ${domain}  ${rel}  ${state === 'argent' ? '[redigee, gate a reprendre]' : '[rien d\'ecrit]'}`);
  }
}
if (undecided.length) {
  console.log(`\nA trancher a part (${undecided.length}) : inbox/a-trancher/ (raisons dans _raisons.md). Pour en decider une :`);
  console.log(`  node tools/plaud-sync/run.mjs --skip-fetch --decide <fichier>=<${DOMAINS.join('|')}>`);
  console.log('  npm run plaud:drop -- <fichier> [<fichier>...]                   (ecartee pour de bon, ne revient pas)');
  for (const f of undecided) console.log(`  ${f}`);
}
console.log('\nA decider (retenues par la gate, codes seulement) :');
spawnSync(KIOKU, ['undecided'], { cwd: VAULT, env: baseEnv, stdio: ['ignore', 'inherit', 'inherit'] });
process.exit(left.length ? 2 : 0); // les indecis n'y comptent pas : ils attendent a part
