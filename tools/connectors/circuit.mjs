/**
 * Le circuit commun des connecteurs de capture : depot dans l'entrant, tri, confirmation, ingestion bronze -> argent ->
 * or, rapport. Un connecteur (tools/plaud-sync/run.mjs aujourd'hui) n'apporte que ce qui lui est propre : le depot
 * dans inbox/ (fetch), l'ecart d'une source parquee (son registre), son dossier d'etat et les commandes a citer.
 *
 * Options communes, lues dans argv (voir l'en-tete de tools/plaud-sync/run.mjs pour le detail) :
 *   --vault <dossier>  --allow-worktree  --init-structure  --dry-run  --skip-fetch  --group-by-day
 *   --decide <fichier>=<domaine>  --drop <fichier>...  --yes  --retries <n>  --retry-delay <s>
 * Le connecteur lit ses propres options (Plaud : --since, --skip) dans le meme argv.
 *
 * Une session d'ingestion qui rend un code non nul est relancee, a froid, apres une attente : le 05/11, une
 * erreur API 422 a fait tomber une session apres la redaction, et la relance a la main du relecteur est passee
 * du premier coup. Avant chaque relance, l'etat est relu sur les fichiers : une source entree dans l'or malgre
 * le code n'est pas relancee, une source deja redigee (etat `argent`) repart avec la consigne de reprise. Le
 * code de sortie de claude ne dit pas si l'erreur est passagere : on relance sur tout echec, et c'est le
 * plafond (--retries) qui borne le cout d'un echec qui se reproduit a chaque fois.
 *
 * Entre le tri et l'ingestion, le circuit montre ce qui va entrer dans l'or, par domaine, et demande confirmation
 * (Entree = non). C'est le dernier moment ou une erreur de domaine du tri se corrige sans effort : apres, la
 * source est dans le wiki du mauvais domaine et seul le relecteur peut encore la retenir. Sans terminal, pas de
 * reponse possible : rien n'est ingere sans --yes.
 *
 * Rien n'est contourne : chaque etape est une session `claude -p` lancee avec VAULT_MODE / VAULT_DOMAIN, donc
 * sous la garde Kioku, exactement comme avec tools/vault.mjs. Le tri s'abstient au moindre doute (la source reste
 * dans l'entrant), la gate retient ce qui doit l'etre (quarantaine). Ce circuit ne juge rien : il verifie sur les
 * fichiers, jamais sur ce qu'une session declare, et rapporte ce qui reste.
 * Code de sortie : 0 tout est range et ingere ; 2 il reste des sources a reprendre ou a trancher ; 1 erreur.
 */

import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import { acquire, lockPath, release } from './lock.mjs';
import { inboxDir, logReason, mdIn, park, parkedDir, parseEmptyLines, pruneReasons } from './parked.mjs';
import { validState } from './pending.mjs';
import { CORE_BIN, withCorePath } from '../core-path.mjs';
import { skill } from '../names.mjs';
import { startupRefusal } from '../startup-guard.mjs';
import { isVault, loadConfig, vaultRoot } from '../vault-config.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PENDING = path.join(HERE, 'pending.mjs');

/**
 * Ce qu'un connecteur fournit au circuit.
 * @typedef {object} Connector
 * @property {string} state - dossier d'etat local, relatif au coffre (file d'ingestion) ; Plaud : tools/plaud-sync
 * @property {(ctx: {argv: string[], dryRun: boolean, node: Function, fail: Function, title: Function}) => void} fetch
 *   - depose dans inbox/ (sans domaine) ; appelle `fail` en cas d'echec
 * @property {(vault: string, file: string) => {ok: boolean, id?: string, registered?: boolean, reason?: string}} drop
 *   - ecarte pour de bon une source parquee (registre du connecteur)
 * @property {{run: string, drop: string, registry: string}} commands - ce que les messages citent (forme du CLI :
 *   `run` = `kioku plaud`, jamais un chemin d'outil, qui n'existe pas dans le coffre)
 */

/** Verifie la forme d'un connecteur : une erreur de branchement se voit au lancement, pas au milieu d'une ingestion. */
export const assertConnector = (c) => {
  const problems = [];
  if (!c || typeof c !== 'object') throw new Error('connecteur : objet attendu');
  if (!validState(c.state)) problems.push('"state" doit etre un dossier relatif au coffre, sans ".."');
  if (typeof c.fetch !== 'function') problems.push('"fetch" doit etre une fonction');
  if (typeof c.drop !== 'function') problems.push('"drop" doit etre une fonction');
  for (const k of ['run', 'drop', 'registry']) if (typeof c.commands?.[k] !== 'string' || !c.commands[k]) problems.push(`"commands.${k}" doit etre un texte`);
  if (problems.length) throw new Error(`connecteur invalide : ${problems.join(' ; ')}`);
  return c;
};

/** Regroupe par journee ET par domaine ; une source sans date dans le nom reste seule (on ne devine pas sa journee). */
export const byDay = (entries) => {
  const groups = new Map();
  for (const e of entries) {
    const day = path.basename(e.rel).match(/^(\d{4}-\d{2}-\d{2})/)?.[1];
    const key = day ? `${e.domain}\u0000${day}` : `${e.domain}\u0000${e.rel}`;
    groups.set(key, [...(groups.get(key) ?? []), e]);
  }
  return [...groups.values()];
};

/** `pending.mjs list` -> entrees { domain, rel, state, left }. */
export const parseQueue = (stdout) =>
  String(stdout ?? '')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      const [domain, rel, state = 'neuf', left = ''] = l.split('\t');
      return { domain, rel, state, left: left ? left.split(',') : [] };
    });

/** `--drop a b c` comme `--drop a --drop b` : chaque --drop prend les arguments qui le suivent jusqu'au prochain --option. */
export const dropArgs = (argv) =>
  argv.flatMap((a, i) => {
    if (a !== '--drop') return [];
    const end = argv.findIndex((x, j) => j > i && x.startsWith('--'));
    const files = argv.slice(i + 1, end < 0 ? undefined : end);
    return files.length ? files : [''];
  });

/** Lance le circuit pour un connecteur. Termine le processus (process.exit) avec le code du circuit. */
export const runCircuit = async (connector, argv = process.argv.slice(2)) => {
  const { commands } = assertConnector(connector);
  const flag = (n) => argv.includes(n);
  const opt = (n) => {
    const i = argv.indexOf(n);
    return i >= 0 ? argv[i + 1] : undefined;
  };

  const VAULT = vaultRoot(opt('--vault'));
  const WIN = process.platform === 'win32';
  // La gate s'appelle `kioku <commande>` (bin/ du core en tete du PATH des sessions, voir core-path.mjs).
  const KIOKU = path.join(CORE_BIN, 'kioku');
  const INBOX = inboxDir(VAULT);
  const TOOLS = 'Read,Write,Edit,Glob,Grep,Agent,Bash(kioku:*),Bash(mv:*)';
  const count = (name, fallback) => {
    const raw = opt(name);
    if (raw === undefined) return fallback;
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 0) {
      console.error(`Erreur : ${name} attend un entier positif ou nul, recu "${raw}".`);
      process.exit(1);
    }
    return n;
  };
  const RETRIES = count('--retries', 1);
  const RETRY_DELAY_S = count('--retry-delay', 30);
  /** Attente synchrone : la boucle d'ingestion est synchrone (spawnSync), une attente asynchrone n'y bloquerait rien. */
  const sleep = (ms) => ms > 0 && Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

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

  // Tous les enfants visent CE coffre (fetch et pending lisent CLAUDE_PROJECT_DIR).
  // Les sessions claude -p attendent le plugin avant leur premier tour : sans lui, la garde manquerait.
  const baseEnv = { ...withCorePath(process.env), CLAUDE_PROJECT_DIR: VAULT, CLAUDE_CODE_SYNC_PLUGIN_INSTALL: '1' };
  // Pas de session sans garde. Seuls le dry-run, --drop et --requeue n'en ouvrent aucune (--decide passe par la session de tri).
  if (!flag('--dry-run') && !flag('--drop') && !flag('--requeue')) {
    const refusal = startupRefusal(VAULT);
    if (refusal) fail(`sessions refusees : ${refusal}`);
  }
  const quote = (a) => (WIN ? `"${String(a).replace(/"/g, '\\"')}"` : a); // cmd.exe : la garde et les prompts contiennent des espaces et des parentheses

  /** Un script Node du coffre ; capture la sortie si demande. */
  const node = (script, args = [], { capture = false } = {}) =>
    spawnSync(process.execPath, [script, ...args], { cwd: VAULT, env: baseEnv, encoding: 'utf8', stdio: capture ? ['ignore', 'pipe', 'inherit'] : ['ignore', 'inherit', 'inherit'] });
  /** La file d'ingestion du connecteur (etat dans son dossier). */
  const pending = (args, opts) => node(PENDING, ['--state', connector.state, ...args], opts);

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
  const PARKED = parkedDir(VAULT);
  const inbox = () => mdIn(INBOX);
  const parked = () => mdIn(PARKED);

  // Decisions explicites de l'utilisateur sur des indecis (--decide fichier=domaine[:org,org]) : transmises a la session
  // de tri, qui range. L'organisation, facultative, est celle de l'utilisateur : elle remplace la proposition du tri
  // (validee contre le registre plus bas, une fois celui-ci charge). Sans elle, le tri la propose comme pour toute source.
  // (Venu de main, PR 10, pour Plaud ; commun aux connecteurs.)
  const decisions = argv.flatMap((a, i) => (a === '--decide' ? [argv[i + 1] ?? ''] : [])).map((d) => {
    const [file, target = ''] = d.split('=');
    const [domain, orgList] = target.split(':');
    const orgIds = orgList === undefined ? null : [...new Set(orgList.split(',').map((s) => s.trim()).filter(Boolean))].sort();
    if (!file || !DOMAINS.includes(domain) || orgIds?.length === 0) fail(`--decide attend <fichier>=<${DOMAINS.join('|')}>[:<org>,<org>], recu "${d}".`);
    return { file, domain, orgIds };
  });

  // `pending.mjs list` rend <domaine>\t<chemin>\t<etat>[\t<candidates>], etat = neuf | argent (redigee mais pas
  // entree dans l'or) | candidats (des candidates de la source restent sous .candidats/ : gate seulement).
  const queue = () => parseQueue(pending(['list'], { capture: true }).stdout);
  const stateLabel = ({ state, left }) =>
    state === 'argent' ? 'reprise : fiche argent deja ecrite' : state === 'candidats' ? `reprise : gate seulement, ${left.length} candidate(s) en attente` : '';

  // 0. Verrou : un seul lanceur a la fois sur ce coffre (tous connecteurs confondus, voir lock.mjs). Sans lui, un
  // second lancement pendant une ingestion relit la file (l'entree n'en sort qu'une fois la page or ecrite) et lance
  // une DEUXIEME session sur la meme source : memes candidates ecrites deux fois, relecture sur une empreinte qui bouge,
  // et index.md / log.md (tenus en ajout) doubles. Un verrou dont le processus est mort est repris tout seul. Pas de
  // verrou en dry-run : il ne lance aucune session et n'ecrit rien.
  if (!flag('--dry-run')) {
    const lock = acquire(VAULT);
    if (!lock.ok) {
      fail(
        `un autre lancement est en cours sur ce coffre (PID ${lock.held.pid}${lock.held.started ? `, depuis ${lock.held.started}` : ''}).\n` +
          `Attends qu'il finisse, ou arrete-le : kill ${lock.held.pid}. Le verrou se libere tout seul (${path.relative(VAULT, lockPath(VAULT)).split(path.sep).join('/')}).`,
      );
    }
    if (lock.stale) console.log(`Verrou perime repris (PID ${lock.stale.pid} n'existe plus).`);
    // Un arret par signal ne passe pas par 'exit' : ce verrou-la reste sur le disque, et c'est la reprise
    // du verrou perime qui le rattrape au lancement suivant. Rien a supprimer a la main.
    process.on('exit', () => release(VAULT));
  }

  // Ecart d'indecis (--drop fichier) : consigne dans le registre du connecteur, supprime, puis s'arrete. Sous le
  // verrou, et sans fetch ni session : ecarter ne doit rien deposer ni ingerer d'autre.
  const drops = dropArgs(argv);
  if (drops.length) {
    if (flag('--dry-run')) fail('--drop ne se combine pas avec --dry-run.');
    let failed = 0;
    for (const file of drops) {
      const r = connector.drop(VAULT, file);
      if (r.ok) console.log(`ecarte   ${file}  (${r.id}${r.registered ? '' : `, deja dans ${commands.registry}`})`);
      else (failed++, console.error(`REFUSE   ${file} : ${r.reason}`));
    }
    console.log(`\n${drops.length - failed} / ${drops.length} ecartee(s). ${commands.registry} est versionne : a commiter.`);
    process.exit(failed ? 2 : 0);
  }

  // Remise en file (--requeue <domaine> <chemin>) : apres un refus a la confirmation, l'utilisateur deplace une source
  // `neuf` vers le bon domaine ; la file la connait encore sous l'ancien. Seule porte d'entree utilisateur vers
  // `pending.mjs add`, que le CLI ne relaie pas. Sous le verrou (une ingestion en cours lit la file), sans fetch ni
  // session, puis s'arrete. Le chemin reste sous raw/<domaine>/ : ni absolu, ni `..`. (Venu de main, PR 8.)
  if (flag('--requeue')) {
    if (flag('--dry-run')) fail('--requeue ne se combine pas avec --dry-run.');
    const at = argv.indexOf('--requeue');
    const domain = argv[at + 1];
    const given = argv[at + 2];
    const usage = `--requeue attend <${DOMAINS.join('|')}> <chemin relatif a raw/<domaine>/>`;
    if (!DOMAINS.includes(domain) || !given || given.startsWith('--')) fail(`${usage}, recu "${[domain, given].filter(Boolean).join(' ')}".`);
    // Le chemin tel que l'utilisateur l'a tape apres son `mv` : raw/<domaine>/…, ./…, ou un antislash (Windows).
    const rel = given.replace(/\\/g, '/').replace(/^\.\//, '').replace(new RegExp(`^raw/${domain}/`), '');
    if (path.isAbsolute(rel) || rel.split('/').includes('..')) fail(`${usage} : chemin hors de raw/${domain}/ refuse ("${given}").`);
    const r = pending(['add', domain, rel]);
    if (r.status !== 0) process.exit(1);
    console.log(`Remise en file. Suite : ${commands.run} --skip-fetch`);
    process.exit(0);
  }

  // Le registre des organisations du coffre vise (--vault), pas celui de la session qui lance ce script : celui que
  // declare l'extension org de la configuration. Declare mais absent ou invalide : rien ne part, le tri ne saurait pas
  // ce que couvre ce domaine. Aucun domaine a extension org : le tri ne propose aucune organisation.
  // (--drop, plus haut, n'en a pas besoin : le module est charge ici, a la demande, pour que --drop et --init-structure marchent sans lui.)
  const { loadOrgs, orgLabel, orgTarget, parseOrgLines, triagePrompt } = await import('./triage.mjs');
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
  // Une organisation imposee par --decide : seulement dans le domaine qui porte l'extension org, et du registre.
  // Refus avant toute session : une organisation inconnue serait ignoree en silence par parseOrgLines.
  for (const d of decisions.filter((x) => x.orgIds)) {
    if (d.domain !== ORG_DOMAIN || !orgs) fail(`--decide ${d.file} : une organisation ne s'impose que dans le domaine a extension org${ORG_DOMAIN ? ` (${ORG_DOMAIN})` : ' (aucun ici)'}.`);
    const unknown = d.orgIds.filter((id) => !orgs.ids.has(id));
    if (unknown.length) fail(`--decide ${d.file} : organisation hors registre : ${unknown.join(', ')} (registre : ${[...orgs.ids].join(', ')}).`);
  }
  const triageScope = { domains: DOMAINS.map((id) => CFG.domain(id)), orgDomain: ORG_DOMAIN };
  // Les organisations proposees par le tri, par source du domaine a extension org (chemin relatif a raw/<domaine>/).
  let orgProposals = new Map();

  // 1. Depot dans l'entrant (sans domaine : rien n'est classe ici). Propre au connecteur.
  if (!flag('--skip-fetch')) connector.fetch({ argv, dryRun: flag('--dry-run'), node, fail, title });
  if (flag('--dry-run')) {
    console.log('\nDry-run : aucune session lancee.');
    process.exit(0);
  }

  // 2. Tri : session triage, automatique. La photo de raw/ avant/apres dit ce qui est range ; les indecis sont parques.
  // Sans decision explicite, inbox/a-trancher/ n'est pas re-trie : une source indecise ne bloque pas les lancements suivants.
  const decided = decisions.map((d) => (existsSync(path.join(PARKED, d.file)) ? `a-trancher/${d.file}` : d.file));
  const toSort = [...new Set([...inbox(), ...decided])];
  // Les notes que le tri dit sans contenu (ligne VIDE), parquees comme les indecis : fichier -> raison.
  let empties = new Map();
  if (toSort.length) {
    title(`Tri de ${toSort.length} source(s) de l'entrant`);
    pending(['snapshot'], { capture: true });
    // Le tri ne lit aucun domaine : la garde ne lui ouvre que inbox/. Le domaine passe ici ne sert qu'a la garde.
    const { code, out } = session('triage', DOMAINS[0], triagePrompt(orgs, toSort, decisions, triageScope));
    pending(['queue']);
    if (code !== 0) console.warn(`Attention : la session de tri a rendu le code ${code}.`);
    if (orgs) orgProposals = parseOrgLines(out, orgs, undefined, ORG_DOMAIN);
    // L'organisation imposee par l'utilisateur (--decide f=pro:org) l'emporte sur celle du tri. La file connait la source
    // par son chemin sous raw/<domaine>/, l'utilisateur par son nom dans l'entrant : on la retrouve par le nom.
    const imposed = decisions.filter((x) => x.orgIds);
    if (imposed.length) {
      const filed = queue().filter((e) => e.domain === ORG_DOMAIN);
      for (const d of imposed) {
        const hit = filed.filter((e) => path.basename(e.rel) === d.file);
        if (hit.length === 1) orgProposals.set(hit[0].rel, d.orgIds);
        else console.warn(`  (organisation imposee pour ${d.file} non appliquee : source ${hit.length ? 'en double' : 'introuvable'} sous raw/${ORG_DOMAIN}/ apres le tri (renommee ou non rangee) ; l'ingestion decidera)`);
      }
    }
    // Les raisons dites par la session ; ce qu'elle a laisse dans l'entrant sans rien ranger est parque par le script (parquer ne classe rien).
    const why = new Map([
      ...[...out.matchAll(/^ABSTENTION\s+(\S+)\s*:\s*(.+)$/gm)].map((m) => [path.basename(m[1]), m[2].trim()]),
      ...[...out.matchAll(/^VIDE\s+(\S+)\s*:\s*(.+)$/gm)].map((m) => [path.basename(m[1]), `sans contenu : ${m[2].trim()}`]),
    ]);
    const leftover = new Set(inbox());
    for (const [f, reason] of why) if (!leftover.has(f) && existsSync(path.join(PARKED, f))) logReason(VAULT, f, reason);
    for (const f of leftover) park(VAULT, f, why.get(f) ?? "tri sans resultat : la session ne l'a ni rangee ni signalee");
    // Une source tranchee par l'utilisateur (--decide) n'est jamais proposee a l'ecart, meme si la session la dit vide.
    const decidedFiles = new Set(decisions.map((d) => d.file));
    empties = parseEmptyLines(out, parked().filter((f) => !decidedFiles.has(f)));
  } else {
    console.log('\nEntrant vide : rien a trier.');
  }

  // 2 ter. Ecart propose : les notes que le tri dit sans contenu (test de connexion, fragment, silence) restent
  // parquees, et l'utilisateur peut les ecarter ici d'un mot au lieu d'un `--drop` a part. Ecarter est irreversible
  // (identifiant consigne « ecarte » dans le registre du connecteur, jamais redepose) : on montre taille et raison,
  // Entree = non, et ni --yes ni l'absence de terminal n'ecartent rien. --yes veut dire « ingere sans demander », pas
  // « supprime ». (Venu de main, PR 11.)
  if (empties.size) {
    title(`${empties.size} note(s) sans contenu selon le tri, parquees dans inbox/a-trancher/`);
    for (const [f, reason] of empties) console.log(`  ${f}  (${statSync(path.join(PARKED, f)).size} octets) : ${reason}`);
    let drop = false;
    if (flag('--yes') || !process.stdin.isTTY) {
      console.log(`${flag('--yes') ? '--yes n\'ecarte rien' : 'Pas de terminal'} : elles restent parquees (${commands.run} --drop <fichier> pour les ecarter).`);
    } else {
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      const a = (await rl.question('Les ecarter pour de bon (elles ne reviendront pas) ? [o]ui / [N]on ')).trim().toLowerCase();
      rl.close();
      drop = ['o', 'oui', 'y', 'yes'].includes(a);
    }
    if (drop) {
      let failed = 0;
      for (const f of empties.keys()) {
        const r = connector.drop(VAULT, f);
        if (r.ok) console.log(`ecarte   ${f}  (${r.id}${r.registered ? '' : `, deja dans ${commands.registry}`})`);
        else (failed++, console.error(`REFUSE   ${f} : ${r.reason}`));
      }
      console.log(`${empties.size - failed} / ${empties.size} ecartee(s). ${commands.registry} est versionne : a commiter.`);
    } else if (process.stdin.isTTY && !flag('--yes')) {
      console.log('Gardees : elles restent parquees et listees au rapport.');
    }
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

  // Le rappel de reprise : une ingestion interrompue entre les candidates et la gate ne se refait pas de zero.
  const resumeNote = (domain) =>
    ` ; une fiche argent existe deja et des candidates ont pu etre ecrites sous .candidats/wiki/${domain}/ : ` +
    `NE REECRIS PAS ce qui est deja conforme (un verdict est lie a l'empreinte exacte d'une page, la reecrire l'invalide). ` +
    `Reprends la ou l'ingestion s'est arretee : redige ce qui manque, puis deroule la gate (check, relecteur, promote), puis index et log.`;

  // Des candidates de la source attendent encore la gate : la redaction est finie, on ne rouvre que la gate.
  const gateOnlyNote = (domain, left) =>
    ` ; la redaction de cette source est FINIE : ces candidates attendent encore la gate sous .candidats/wiki/${domain}/ : ${left.join(', ')}. ` +
    `NE REDIGE AUCUNE PAGE NOUVELLE et ne relis pas la source. Deroule la gate sur ces candidates (check, relecteur, promote), ` +
    `puis index et log si ce n'est pas deja fait. Si check en refuse une, corrige seulement ce qu'il signale.`;

  /** Le prompt d'ingestion d'une source ; `suite` = un tour qui suit une source de la meme journee dans le meme fil. */
  const ingestPrompt = (domain, rel, state, suite, left = []) => {
    if (state === 'candidats') return `${skill('ingest')} ${rel}${gateOnlyNote(domain, left)}`;
    const proposed = domain === ORG_DOMAIN ? orgProposals.get(rel) : undefined;
    return (
      `${skill('ingest')} ${rel}` +
      (proposed ? ` ; organisation proposee par le tri : ${proposed.join(',')} (a confirmer ou corriger sur le contenu)` : '') +
      (suite
        ? ` ; tu viens d'ingerer une ou plusieurs sources de la MEME JOURNEE, elles sont encore dans ton contexte : ` +
          `RECOUPE cette source avec elles (une seance de l'apres-midi confirme, precise ou contredit celle du matin) ` +
          `et ne relis pas l'index ni les pages que tu as deja lues. Ajoute ton entree de journal a la suite ; ` +
          `pour l'index, complete la ligne de la journee plutot que d'en ouvrir une nouvelle.`
        : '') +
      (state === 'argent' ? resumeNote(domain) : '')
    );
  };

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
      for (const e of mine) {
        const { rel } = e;
        const org = domain === ORG_DOMAIN ? `  ${orgLabel(orgProposals.get(rel))}` : '';
        console.log(`    ${rel}${org}${stateLabel(e) ? `  [${stateLabel(e)}]` : ''}`);
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
          `  ${commands.run} --requeue <vers> <chemin>\n` +
          `  ${commands.run} --skip-fetch`,
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
    group.forEach((entry, i) => {
      const { rel, state, left } = entry;
      const suite = thread && i > 0;
      if (thread) console.log(`\n-- ${i + 1}/${group.length} : ${rel}`);
      else title(`Ingestion ${domain} : ${rel}${stateLabel(entry) ? ` (${stateLabel(entry)})` : ''}`);
      let { code } = session('ingest', domain, ingestPrompt(domain, rel, state, suite, left), thread);
      for (let attempt = 1; code !== 0 && attempt <= RETRIES; attempt++) {
        console.warn(`Attention : la session d'ingestion a rendu le code ${code}.`);
        // L'etat se relit sur les fichiers, pas sur ce que la session a dit avant de tomber.
        const now = queue().find((e) => e.domain === domain && e.rel === rel);
        if (!now) {
          console.log('  page or presente malgre le code : pas de relance.');
          code = 0;
          break;
        }
        console.warn(`  relance ${attempt}/${RETRIES} dans ${RETRY_DELAY_S} s, a froid${stateLabel(now) ? `, ${stateLabel(now)}` : ''}.`);
        sleep(RETRY_DELAY_S * 1000);
        // A froid : le fil de la journee a ete abandonne par l'echec, la relance ne peut pas compter sur son contexte.
        ({ code } = session('ingest', domain, ingestPrompt(domain, rel, now.state, false, now.left), null));
      }
      if (code !== 0) console.warn(`Attention : la session d'ingestion a rendu le code ${code}${RETRIES ? ` apres ${RETRIES} relance(s)` : ''}.`);
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
    for (const { domain, rel, state, left: waiting } of left) {
      const what = state === 'candidats' ? `[candidates en attente de la gate : ${waiting.join(', ')}]` : state === 'argent' ? '[redigee, gate a reprendre]' : '[rien d\'ecrit]';
      console.log(`  ${domain}  ${rel}  ${what}`);
    }
  }
  if (undecided.length) {
    console.log(`\nA trancher a part (${undecided.length}) : inbox/a-trancher/ (raisons dans _raisons.md). Pour en decider une :`);
    console.log(`  ${commands.run} --skip-fetch --decide <fichier>=<${DOMAINS.join('|')}>${ORG_DOMAIN ? `[:<org>]` : ''}   (repetable${ORG_DOMAIN ? `, :<org> impose l'organisation en ${ORG_DOMAIN}` : ''})`);
    console.log(`  ${commands.drop.padEnd(65)}(ecartee pour de bon, ne revient pas)`);
    for (const f of undecided) console.log(`  ${f}`);
  }
  console.log('\nA decider (retenues par la gate, codes seulement) :');
  spawnSync(KIOKU, ['undecided'], { cwd: VAULT, env: baseEnv, stdio: ['ignore', 'inherit', 'inherit'] });
  process.exit(left.length ? 2 : 0); // les indecis n'y comptent pas : ils attendent a part
};
