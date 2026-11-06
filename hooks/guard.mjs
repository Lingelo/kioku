#!/usr/bin/env node
/**
 * La garde du coffre : le medaillon et le silo entre domaines tiennent par un hook, pas par une consigne.
 *
 * Branchee sur PreToolUse (ecriture, lecture, Bash). Un code de sortie 2 bloque l'appel et renvoie
 * le message au modele. Aucune dependance, aucun appel de modele : une garde qui appelle un modele
 * peut tomber avec lui. Tout ce qu'elle ne sait pas decider vaut refus.
 *
 * Les domaines viennent de la configuration du coffre (kioku.config.json, voir config.mjs) : la garde ne
 * connait aucun nom de domaine. Configuration invalide : tout est refuse. Configuration absente : hors coffre (aucun
 * marqueur, voir locateVault), la garde ne s'applique pas ; dans un coffre abime (un marqueur), tout est refuse.
 *
 * Deux variables d'environnement, posees au lancement (tools/vault.mjs) :
 *   VAULT_MODE   query | ingest | triage | setup
 *   VAULT_DOMAIN un domaine declare (inutile en triage et en setup)
 * Sans aucune des deux, la session vaut le `default_session` de la configuration ; sans lui, refus.
 *
 *   zone            query            ingest             triage    setup
 *   wiki/<D>        lecture          lecture            -         -
 *   raw/<D>         -                lecture            -         -     (immuable : jamais ecrit par un outil d'edition)
 *   silver/<D>      -                lecture+ecriture   -         -     (sauf silver/<D>/heritage/ : instantane ferme, jamais lu)
 *   .candidats/<D>  lecture+ecriture lecture+ecriture   -         -
 *   domains/<D>     lecture          lecture            -         -     (regles du domaine : jamais ecrites depuis une session)
 *   inbox/          -                -                  lecture   -     (le tri deplace vers raw/<domaine>/)
 *   quarantine, .verdicts : jamais lus ni ecrits directement (passer par vault.mjs)
 *   tout autre domaine, declare ou non : jamais, dans aucun mode
 *
 * Le mode setup installe et etend le coffre (plan core/data, U8) : il lit la configuration et le registre (zone
 * garde, lisible partout) mais aucun contenu de domaine. La configuration ne s'y ecrit que par le CLI du coffre
 * (`kioku init|add-domain`), qui refuse lui-meme hors setup ; hors setup, la garde refuse aussi la commande. En
 * setup, la garde refuse ce qui lirait ou ferait lire un domaine par un autre chemin : la gate (vault.mjs affiche
 * des noms de pages), le lanceur (il ouvre des sessions avec leurs propres droits), le dashboard.
 *
 * Les circuits de capture (kioku plaud, leurs scripts npm, leurs outils, tools/connectors/) sont refuses dans TOUS les
 * modes : ils se lancent depuis le terminal de l'utilisateur, ouvrent eux-memes leurs sessions, et leur simple dry-run
 * liste les sources de tous les domaines.
 *
 * Zone secrete, jamais lue ni ecrite, dans aucun mode : le dossier des jetons OAuth du module mail (~/.config/kioku/mail,
 * $XDG_CONFIG_HOME/kioku/mail, %APPDATA%\kioku\mail), hors coffre.
 *
 * Zone de la garde, jamais ecrite depuis une session : hooks du plugin, settings, agents, le dossier de ce script,
 * la configuration du coffre et les registres qu'elle declare.
 *
 * wiki/ ne s'ecrit JAMAIS directement : candidate sous .candidats/, puis vault.mjs check / verdict /
 * promote. Seuls index.md et log.md de son propre domaine s'editent en place (catalogue et journal,
 * sans jugement de fond), plus overview.md en mode ingest (hors gate, relu au lint).
 *
 * Limite, dite : elle voit les outils d'edition et les commandes shell qui s'ecrivent comme telles.
 * Un programme qui lit ou ecrit depuis l'interieur (node -e, python) lui echappe. C'est une barriere
 * contre le comportement normal du modele, pas contre quelqu'un qui la contourne expres.
 */

import { existsSync, lstatSync, readFileSync, readlinkSync, realpathSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Un chemin se compare dans sa forme canonique, celle que le systeme de fichiers ouvrira vraiment :
// - `~`, `~/`, `$HOME`, `${HOME}` en tete : Claude Code etend `~` dans Read ; sans cela `~/<coffre>/wiki/<autre>/x.md`
//   se resolvait sous le coffre en `<coffre>/~/...` (zone other, lisible) ;
// - liens symboliques suivis segment par segment, y compris un lien pendant (Write le suit et cree sa cible) et un
//   `..` apres un lien (le systeme remonte depuis la cible, pas depuis le lien, contrairement a path.resolve) ;
// - casse du disque : realpathSync.native rend la casse reelle des segments existants (realpathSync, version JS,
//   garde la casse fournie : `WIKI/perso` passait pour une zone inconnue sur un volume insensible a la casse).
// Le reste, inexistant, est recolle tel quel ; sur un volume insensible a la casse, toute comparaison de zone passe
// par fold() (voir FOLD). Une erreur inattendue (droits, boucle de liens) remonte : decide() refuse.
const expandHome = (p) => p.replace(/^(?:~|\$HOME|\$\{HOME\})(?=$|[/\\])/, () => os.homedir());
const MAX_LINKS = 40;
const canonical = (abs) => {
  let cur = path.parse(abs).root;
  const todo = abs.slice(cur.length).split(/[/\\]+/).reverse();
  let exists = true;
  let links = 0;
  while (todo.length) {
    const seg = todo.pop();
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      cur = path.dirname(cur);
      continue;
    }
    const next = path.join(cur, seg);
    if (!exists) {
      cur = next;
      continue;
    }
    try {
      cur = realpathSync.native(next);
      continue;
    } catch (error) {
      if (error?.code !== 'ENOENT' && error?.code !== 'ENOTDIR') throw error;
    }
    let st = null;
    try {
      st = lstatSync(next);
    } catch (error) {
      if (error?.code !== 'ENOENT' && error?.code !== 'ENOTDIR') throw error;
    }
    if (st?.isSymbolicLink()) {
      // Lien pendant : on suit sa cible (relative au dossier du lien, deja canonique), comme le ferait Write.
      if (++links > MAX_LINKS) throw new Error(`trop de liens symboliques sous ${abs}`);
      const link = readlinkSync(next);
      const root = path.isAbsolute(link) ? path.parse(link).root : '';
      if (root) cur = root;
      todo.push(...link.slice(root.length).split(/[/\\]+/).reverse());
      continue;
    }
    exists = false;
    cur = next;
  }
  return cur;
};

const HERE = canonical(path.dirname(fileURLToPath(import.meta.url)));
const VAULT = canonical(path.resolve(process.env.CLAUDE_PROJECT_DIR ?? path.join(HERE, '..', '..')));
const MODES = ['query', 'ingest', 'triage', 'setup'];
// Modes ou une session travaille dans UN domaine : seuls ceux-la ouvrent une zone de domaine.
const DOMAIN_MODES = ['query', 'ingest'];
const EDIT_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);
const READ_TOOLS = new Set(['Read', 'NotebookRead']);
const SEARCH_TOOLS = new Set(['Grep', 'Glob']);

const refuse = (message) => {
  process.stderr.write(`${message}\n`);
  process.exit(2);
};
const errText = (error) => (error instanceof Error ? error.message : String(error));
// Toute exception hors de decide() (preparation, config d'une autre version) ferait sortir le hook en code 1,
// que Claude Code traite comme non bloquant : la garde echouerait ouverte. Elle refuse a la place.
process.on('uncaughtException', (error) => refuse(`Garde du coffre en panne (${errText(error)}). Dans le doute, je refuse.`));

const envMode = process.env.VAULT_MODE;
const envDomain = process.env.VAULT_DOMAIN;

// Hors coffre, pas de garde (chantier 1) : installe au niveau utilisateur, le plugin la branche dans tous les projets,
// et `kioku init` doit pouvoir tourner dans un dossier vide. Sortie a trois conditions, toutes requises :
//   - CLAUDE_PROJECT_DIR pose : sans lui, VAULT est le repli sur le dossier du script (le cache du plugin), qui ne dit
//     rien du projet ouvert ;
//   - ni VAULT_MODE ni VAULT_DOMAIN : poses, ils annoncent une session de coffre, ouverte au mauvais endroit ;
//   - ni configuration ni marqueur de coffre (locateVault : 'none'). Un marqueur sans configuration = coffre abime,
//     refuse plus bas par loadConfig.
// Import dynamique, sous try : un config.mjs absent ferait sinon sortir le hook en code 1, que Claude Code
// traite comme une erreur non bloquante. La garde echouerait ouverte.
let cfg;
try {
  const { loadConfig, locateVault } = await import('./config.mjs');
  if (process.env.CLAUDE_PROJECT_DIR !== undefined && envMode === undefined && envDomain === undefined && locateVault(VAULT) === 'none') {
    process.exit(0);
  }
  cfg = loadConfig(VAULT);
} catch (error) {
  refuse(`Garde du coffre : ${errText(error)}. Sans configuration lisible, je refuse tout (un dossier de coffre sans kioku.config.json est un coffre abime : kioku doctor).`);
}
let MODE;
let D;
if (envMode === undefined && envDomain === undefined) {
  if (!cfg.defaultSession) refuse('Garde du coffre : session ouverte sans VAULT_MODE ni VAULT_DOMAIN, et le coffre ne declare pas de default_session. Lance-la par tools/vault.mjs.');
  ({ mode: MODE, domain: D } = cfg.defaultSession);
} else {
  MODE = envMode;
  D = envDomain;
}
if (!MODES.includes(MODE)) refuse(`Garde du coffre : VAULT_MODE="${MODE ?? ''}" invalide (${MODES.join('|')}). Dans le doute, je refuse.`);
if ((DOMAIN_MODES.includes(MODE) || D !== undefined) && !cfg.has(D)) {
  refuse(`Garde du coffre : VAULT_DOMAIN="${D ?? ''}" n'est pas un domaine declare (${cfg.domains.join('|')}). Dans le doute, je refuse.`);
}
// Volume du coffre insensible a la casse (APFS par defaut, NTFS) : `WIKI/perso` y ouvre `wiki/perso`. Sonde unique,
// gardee pour tout l'appel (un processus par appel d'outil) : la configuration, chargee plus haut, existe forcement ;
// si son nom en majuscules existe aussi, le volume ne distingue pas la casse, et chemins et commandes se comparent
// plies (fold). Limite : un volume monte sous le coffre avec une autre sensibilite n'est pas sonde a part.
const FOLD = existsSync(path.join(VAULT, 'kioku.config.json'.toUpperCase()));
// Majuscules puis minuscules : le signe kelvin (U+212A) et le s long (U+017F) se plient comme sur le disque (k, s).
const fold = (s) => (FOLD ? s.toUpperCase().toLowerCase() : s);
const ALL = cfg.domains.join('|');
// Un domaine se termine au premier caractere qui n'est ni lettre, ni chiffre, ni tiret : `pro` ne couvre pas `pro-old`.
const END = '(?![\\w-])';
// Tout segment de domaine autre que celui de la session, declare ou non.
const NOT_D = D === undefined ? '' : `(?!${D}${END})`;

const CONSIGNE_LIRE =
  `Session ${MODE}/${D ?? '-'}. ` +
  (MODE === 'query'
    ? `On requete l'or uniquement : wiki/${D}/. Le brut (raw/), l'argent (silver/), l'entrant, la quarantaine et les autres domaines sont fermes.\n` +
      `Si le wiki ne suffit pas, reponds « pas trouve dans le wiki, a investiguer » : c'est une lacune a combler par une ingestion, pas par une recherche dans le brut.`
    : MODE === 'ingest'
      ? `Ingestion ${D} : on lit raw/${D}/, silver/${D}/, wiki/${D}/ et .candidats/wiki/${D}/. Ni l'entrant, ni la quarantaine, ni les autres domaines.`
      : MODE === 'setup'
        ? `Installation : on lit la configuration du coffre et le registre, jamais un contenu de domaine (wiki, brut, argent, regles, entrant, quarantaine). Configurer passe par le CLI du coffre (kioku init|add-domain|doctor).`
        : `Tri : on lit inbox/ et on deplace vers raw/<${ALL}>/. Ni le wiki, ni l'argent, ni la quarantaine.`) +
  (DOMAIN_MODES.includes(MODE) ? `\nPour Grep/Glob, donne toujours un path precis (ex. wiki/${D}), jamais la racine.` : '');

const SECRET_REFUS =
  'Le dossier des jetons et du client OAuth du module mail (~/.config/kioku/mail, ou son equivalent) est ferme a toute session, ' +
  "en lecture comme en ecriture : un mail est une donnee non fiable, et un jeton recopie dans une page donnerait acces a la boite. Rien a y lire pour travailler.";

const CONSIGNE_ECRIRE =
  `Ecriture directe interdite ici (session ${MODE}/${D ?? '-'}).\n` +
  `- wiki/ : ecris la page sous .candidats/wiki/${D ?? '<domaine>'}/<dossier>/<slug>.md, puis\n` +
  `  kioku check <candidate>, le relecteur (agent "reviewer", regles de domains/${D ?? '<domaine>'}/) rend un verdict, puis\n` +
  `  kioku promote <candidate>. Seuls wiki/${D ?? '<domaine>'}/index.md et log.md s'editent en place (et overview.md en mode ingest).\n` +
  `- raw/ est immuable, quarantine/ et .verdicts/ ne s'ecrivent que par vault.mjs, silver/ seulement en mode ingest.\n` +
  `- la configuration du coffre et les regles de domaine (domains/) ne s'ecrivent depuis aucune session.`;

const inside = (abs, dir) => {
  const rel = path.relative(fold(dir), fold(abs));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
};
const PROTECTED = new Set(cfg.protectedPaths.map((p) => canonical(path.resolve(p))));
const PROTECTED_KEYS = new Set([...PROTECTED].map(fold));

// Zone secrete : le dossier hors coffre ou le module mail range le client OAuth et les jetons (tools/mail-sync/paths.mjs,
// recalcule ici : la garde ne depend pas de tools/). Une session lit du mail non fiable ; un jeton lu puis recopie dans
// une fiche serait versionne avec le coffre. Ferme en lecture et en ecriture dans tous les modes. Les trois
// emplacements possibles sont fermes ensemble : l'environnement de la garde peut differer de celui du lanceur.
// Limite, dite (revue N8) : un jeton cree sous un XDG_CONFIG_HOME DIFFERENT de celui que voit la garde (ni ~/.config,
// ni le XDG courant, ni %APPDATA%) n'est pas reconnu. Les liens symboliques, eux, sont resolus (canonical).
const HOME_DIR = os.homedir();
const SECRET_DIRS = [
  ...new Set(
    [
      path.join(HOME_DIR, '.config', 'kioku', 'mail'),
      process.env.XDG_CONFIG_HOME ? path.join(process.env.XDG_CONFIG_HOME, 'kioku', 'mail') : null,
      process.env.APPDATA ? path.join(process.env.APPDATA, 'kioku', 'mail') : null,
      path.join(HOME_DIR, 'AppData', 'Roaming', 'kioku', 'mail'),
    ]
      .filter(Boolean)
      .map((p) => canonical(path.resolve(p))),
  ),
];
// Une mention de ce dossier dans une commande ou un motif de recherche : `kioku/mail`, `kioku\mail`, un glob juste
// apres `kioku/`, ou le dossier de configuration `.config/kioku`. Limite, dite : un `cd` en plusieurs temps y echappe.
const SECRET_MENTION = [/kioku[/\\]+["']?(mail|[*?[{])/i, /\.config[/\\]+kioku\b/i];

const classify = (abs) => {
  if (SECRET_DIRS.some((d) => inside(abs, d))) return { zone: 'secret' };
  if (inside(abs, HERE) || PROTECTED_KEYS.has(fold(abs))) return { zone: 'garde' };
  const rel = path.relative(fold(VAULT), fold(abs));
  if (rel.startsWith('..') || path.isAbsolute(rel)) return { zone: 'outside' };
  const p = rel === '' ? [] : rel.split(path.sep);
  const [a, b] = p;
  if (p.length === 0) return { zone: 'root' };
  if (a === 'wiki') return { zone: 'wiki', domain: b, file: p.slice(2).join('/') };
  if (a === 'raw' || a === 'silver' || a === 'quarantine') return { zone: a, domain: b, sub: p[2] };
  if (a === 'domains') return { zone: 'domains', domain: b };
  if (a === 'inbox') return { zone: 'inbox' };
  if (a === '.candidats') return { zone: 'candidats', domain: p[1] === 'wiki' ? p[2] : undefined };
  if (a === '.verdicts') return { zone: 'verdicts' };
  if (a === '.claude' && ['hooks', 'settings.json', 'settings.local.json', 'agents'].includes(b)) return { zone: 'garde' };
  return { zone: 'other' };
};

// Une zone de domaine ne s'ouvre qu'au domaine de la session, et seulement dans un mode de domaine (query, ingest) :
// un segment non declare n'est jamais D, et un D pose en triage ou en setup n'ouvre rien.
const own = (z) => DOMAIN_MODES.includes(MODE) && D !== undefined && z.domain === D;

const canRead = (z) => {
  switch (z.zone) {
    case 'outside':
    case 'other':
    case 'garde':
      return true;
    case 'wiki':
    case 'candidats':
    case 'domains':
      return own(z);
    case 'raw':
      return MODE === 'ingest' && own(z);
    case 'silver': // silver/<D>/heritage/ = instantane de depart, ferme dans tous les modes (on lit l'or)
      return MODE === 'ingest' && own(z) && z.sub !== 'heritage';
    case 'inbox':
      return MODE === 'triage';
    default:
      return false; // root, quarantine, verdicts
  }
};

const canWrite = (z) => {
  switch (z.zone) {
    case 'outside':
    case 'other':
      return true;
    case 'wiki':
      return own(z) && (z.file === 'index.md' || z.file === 'log.md' || (MODE === 'ingest' && z.file === 'overview.md'));
    case 'candidats':
      return own(z);
    case 'silver':
      return MODE === 'ingest' && own(z) && z.sub !== 'heritage';
    default:
      return false; // garde, domains, raw, inbox, quarantine, verdicts, root
  }
};

const ZONE_RE = (names, sub = '') => new RegExp(`(^|[^\\w.-])(${names})[/\\\\]${sub}`);
const CANDIDATS_RE = (sub) => new RegExp(`\\.candidats[/\\\\]wiki[/\\\\]${sub}`);
const forbiddenMentions = () => {
  const common = [/\.verdicts/, /(wiki|raw|silver|domains)[/\\]\*/, new RegExp(`silver[/\\\\](${ALL})${END}[/\\\\]heritage`)];
  if (MODE === 'query') {
    return [...common, ZONE_RE('raw|silver|inbox|quarantine'), ZONE_RE('wiki|domains', NOT_D), CANDIDATS_RE(NOT_D)];
  }
  if (MODE === 'ingest') {
    return [...common, ZONE_RE('inbox|quarantine'), ZONE_RE('raw|silver|wiki|domains', NOT_D), CANDIDATS_RE(NOT_D)];
  }
  if (MODE === 'setup') return [...common, ZONE_RE('wiki|raw|silver|inbox|quarantine|domains'), /\.candidats/];
  return [...common, ZONE_RE('wiki|silver|quarantine|domains'), /\.candidats/];
};

const allowedMention = () =>
  MODE === 'triage'
    ? /(^|[^\w.-])inbox[/\\]/
    : MODE === 'setup'
      ? /(?!)/ // aucune zone de domaine a parcourir : une recherche recursive sans dossier reste refusee
      : // silver/<D> n'y figure pas : une recherche recursive y traverserait heritage/ (fiches : Read, une a une)
        new RegExp(`(wiki[/\\\\]${D}|\\.candidats[/\\\\]wiki[/\\\\]${D}${MODE === 'ingest' ? `|raw[/\\\\]${D}` : ''})${END}`);

// Le CLI du coffre : `kioku init|add-domain|upgrade --write` ecrit la configuration, donc seulement en setup. `doctor`
// et `upgrade` sans --write (simulation) lisent : partout.
const KIOKU_WRITE = /(^|[\s;&|(/\\])kioku(\.mjs)?["']?\s+(init|add-domain|upgrade\b[^;&|\n]*\s--write)\b/;
// En setup, ce qui lirait un domaine ou ouvrirait une session d'un autre mode : la gate, les circuits de capture, le lanceur,
// le dashboard. Ni lecture de nom de page, ni escalade par processus enfant.
// La gate s'appelle `kioku <commande>` : ses sous-commandes (pas init, add-domain, doctor) lisent ou ecrivent un domaine.
const KIOKU_GATE = /(^|[\s;&|(/\\])kioku(\.mjs)?["']?\s+(commit|check|verdict|promote|stage|rotate-log|propose-org|tag-org|propose-raw|tag-raw|quarantine|undecided|audit|flag|decide|seed)\b/;
// Les scripts npm du coffre (generes par init) : un par domaine declare (session query/<D>) et les prefixes communs.
// Les domaines viennent de la configuration : une liste figee laisserait `npm run travail` ouvrir une session de domaine
// depuis setup. `pro` et `perso` restent, pour les coffres anterieurs a la configuration.
const NPM_SCRIPTS = [...new Set([...cfg.domains, 'pro', 'perso', 'vault', 'ingest', 'triage', 'lint', 'dashboard', 'plaud', 'audit', 'undecided'])];
// `npm run`, et ses alias (`run-script`, `rum`, `urn`), options (et leur valeur) avant ou apres ; le nom du script,
// entre guillemets ou non.
const npmScripts = (names) => new RegExp(`(^|[\\s;&|(])npm\\s+(-\\S+(\\s+(?!(run|run-script|rum|urn)\\b)[^-\\s]\\S*)?\\s+)*((run|run-script|rum|urn)\\s+)?(-\\S+\\s+)*["']?(${names.join('|')})(?![\\w-])`);
const NPM_DENIED = npmScripts(NPM_SCRIPTS);
// Un relais du CLI (`kioku <sous-commande>`), le sous-mot entre guillemets ou non (`kioku 'plaud'`).
const kiokuSub = (names) => new RegExp(`(^|[\\s;&|(/\\\\])kioku(\\.mjs)?["']?\\s+["']?(${names.join('|')})["']?(?![\\w-])`);
// Les relais du CLI vers le lanceur, le dashboard et les circuits : sans chemin d'outil dans la commande, refuses par leur nom.
const KIOKU_TOOLS = kiokuSub(['session', 'dashboard', 'plaud']);
// Les circuits de capture se lancent depuis le terminal de l'utilisateur, jamais depuis une session du coffre : ils
// ouvrent eux-memes des sessions (tri, ingestion) avec leurs propres droits, et leur simple dry-run liste les sources
// de tous les domaines. Refuses dans TOUS les modes : le relais, les scripts npm, leurs outils et le socle des
// connecteurs (circuit, file d'ingestion, verrou). Le circuit, lui, n'a jamais besoin de se relancer depuis une session.
const CIRCUIT_DENIED = [kiokuSub(['plaud']), npmScripts(['plaud']), /plaud-sync[/\\]/, /tools[/\\]connectors[/\\]/];
const SETUP_DENIED = [/vault\.mjs/, KIOKU_GATE, KIOKU_TOOLS, /tools[/\\]dashboard[/\\]/, NPM_DENIED];

// Une commande shell qui ecrit, et qui vise une zone fermee en ecriture.
const WRITERS = [/(^|[\s;&|(])(sed|perl)\b[^\n;&|]*\s-\w*i/, /(^|[\s;&|(])tee\b/, /(^|[\s;&|(])(mv|cp|rm|touch|truncate|ln|install|dd)\b/];
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const PROTECTED_REL = [...PROTECTED].filter((p) => inside(p, VAULT)).map((p) => escapeRe(fold(path.relative(VAULT, p))).replace(/\\\\|\//g, '[/\\\\]'));
const writeTargets = () => {
  const list = ['wiki[/\\\\]', 'domains[/\\\\]', '\\.claude[/\\\\](hooks|settings|agents)', `silver[/\\\\](${ALL})${END}[/\\\\]heritage`, ...PROTECTED_REL];
  if (MODE !== 'triage') list.push('raw[/\\\\]', 'inbox[/\\\\]', 'quarantine[/\\\\]', '\\.verdicts');
  return list.join('|');
};
// Revue de securite : les cibles ci-dessus exigent un separateur final (`wiki/`), donc `mv wiki w` passait, et un
// glob (`mv kioku.config.j* …`) echappait au chemin litteral de la configuration. Renommer un marqueur ou .claude, ou
// deplacer la configuration, fait passer le coffre pour « hors coffre » et coupe la garde (chantier 1). Un writer qui
// nomme l'un d'eux comme mot entier, ou un glob qui couvre un fichier protege, est refuse.
const MARKER_WORD = /(^|[\s"'=;&|(])(\.\/)?(wiki|raw|silver|domains|\.kioku|\.claude)\/?(?=$|[\s"';&|)])/;
const GLOB_WORD = /(?:^|\s)["']?([^\s"';&|()]*[*?[][^\s"';&|()]*)/g;
const globCovers = (pattern, name) => {
  const re = `^${pattern.replace(/^\.\//, '').replace(/[.+^${}()|\\]/g, '\\$&').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]')}$`;
  try {
    return new RegExp(re).test(name);
  } catch {
    return true; // glob illisible (crochet non ferme…) : dans le doute, il couvre
  }
};
const PROTECTED_NAMES = [...PROTECTED].filter((p) => inside(p, VAULT)).map((p) => fold(path.relative(VAULT, p)).split(path.sep).join('/'));
const writerTouchesVaultShape = (cleaned) => {
  if (!WRITERS.some((w) => w.test(cleaned))) return false;
  if (MARKER_WORD.test(cleaned)) return true;
  for (const [, glob] of cleaned.matchAll(GLOB_WORD)) {
    if ([...PROTECTED_NAMES, 'wiki', 'raw', 'silver', 'domains', '.kioku', '.claude'].some((n) => globCovers(glob, n))) return true;
  }
  return false;
};

const shellWritesProtected = (command) => {
  const cleaned = command.replace(/\d?>&\d/g, ' ').replace(/\d?>>?\s*\/dev\/null/g, ' ');
  const t = writeTargets();
  const targets = new RegExp(`(^|[\\s"'=/\\\\])(${t})`);
  const redirect = new RegExp(`(?:^|[^>&\\d])\\d?>>?\\s*["']?[^\\s"'|;&]*(?:${t})`);
  return redirect.test(cleaned) || (targets.test(cleaned) && WRITERS.some((w) => w.test(cleaned))) || writerTouchesVaultShape(cleaned);
};

// Le texte d'un message (-m / --message) n'est ni un chemin ni une commande : les regles ci-dessous y
// lisent des faux positifs (-m "Ingestions du 21/09" passe pour l'utilitaire `du`, -m "corrige le diff"
// pour un git diff). On neutralise donc sa valeur avant toute analyse, mais seulement quand c'est un
// litteral entre guillemets sans substitution : un $(...) ou des accents graves seraient evalues par le
// shell, ils doivent rester visibles de la garde. Le drapeau lui-meme est conserve, pour ne pas changer
// la forme de la commande vue par les autres regles (install -m 644 reste install -m 644).
// Limites, dites : un heredoc n'est pas couvert (il peut porter un script entier), ni un message lu
// depuis un fichier (-F), ni un litteral non quote. Ces trois formes restent analysees telles quelles.
// --description (kioku add-domain) suit la meme regle : du texte libre, ou « test du skill » passait pour `du`.
const MESSAGE_ARG = /(^|[\s;&|(])(--message=|--message[ \t]+|--description=|--description[ \t]+|-[A-Za-z]{0,3}m[ \t]*)("(?:[^"\\]|\\.)*"|'[^']*')/g;
const stripMessages = (command) =>
  command.replace(MESSAGE_ARG, (whole, lead, flag, value) => (/[$`]/.test(value) ? whole : `${lead}${flag}""`));

// Le brut et tous les domaines sont versionnes : l'historique git les contient tous. Dans aucun mode
// git ne sert a relire du contenu (le domaine de la session se lit par Read/Grep, sous la garde).
const GIT_CONTENT = [
  /(^|[\s;&|(])git\b[^|;&\n]*\b(show|grep|diff|cat-file|archive|blame|stash|restore|checkout)\b/,
  /(^|[\s;&|(])git\b[^|;&\n]*\blog\b[^|;&\n]*\s(-p|-u|--patch)\b/,
];

// --- Invariants sur les commandes shell (revue N1) : verifies par le code, pas par des motifs. ---
//
// Une garde a motifs sur du shell perd toujours (glob, guillemets, $'…', \) : les regex ci-dessus restent un filet.
// Ici, la commande est decoupee en mots comme le ferait le shell (guillemets, echappements, separateurs, redirections),
// et chaque argument d'une commande qui ecrit ou deplace est juge sur sa forme et sur son chemin reel.

/** Mots d'une commande : [{ raw, value }] par commande simple ; `redirects` : les cibles de > et >>. */
const shellWords = (command) => {
  const commands = [];
  let words = [];
  let redirects = [];
  let raw = '';
  let value = '';
  let inWord = false;
  let pendingRedirect = false;
  const end = () => {
    if (inWord) {
      const w = { raw, value };
      if (pendingRedirect) {
        redirects.push(w);
        pendingRedirect = false;
      } else words.push(w);
    }
    raw = '';
    value = '';
    inWord = false;
  };
  const boundary = () => {
    end();
    if (words.length || redirects.length) commands.push({ words, redirects });
    words = [];
    redirects = [];
  };
  for (let i = 0; i < command.length; i++) {
    const c = command[i];
    if (c === "'") {
      const j = command.indexOf("'", i + 1);
      const k = j < 0 ? command.length : j;
      raw += command.slice(i, k + 1);
      value += command.slice(i + 1, k);
      inWord = true;
      i = k;
    } else if (c === '"') {
      let j = i + 1;
      let v = '';
      while (j < command.length && command[j] !== '"') {
        if (command[j] === '\\' && j + 1 < command.length) {
          v += command[j + 1];
          j += 2;
        } else v += command[j++];
      }
      raw += command.slice(i, j + 1);
      value += v;
      inWord = true;
      i = j;
    } else if (c === '\\') {
      raw += command.slice(i, i + 2);
      value += command[i + 1] ?? '';
      inWord = true;
      i++;
    } else if (c === ';' || c === '&' || c === '|' || c === '\n' || c === '(' || c === ')') {
      boundary();
    } else if (c === '>' || c === '<') {
      // `2>`, `>>`, `>&2` : le descripteur colle avant est absorbe ; un `&<n>` apres est une duplication, pas un fichier.
      if (inWord && /^\d+$/.test(raw)) {
        raw = '';
        value = '';
        inWord = false;
      } else end();
      if (command[i + 1] === '>') i++;
      if (command[i + 1] === '&') {
        i++;
        while (/\d/.test(command[i + 1] ?? '')) i++;
        continue;
      }
      pendingRedirect = c === '>';
    } else if (/\s/.test(c)) {
      end();
    } else {
      raw += c;
      value += c;
      inWord = true;
    }
  }
  boundary();
  return commands;
};

// Commandes qui ecrivent, deplacent ou telechargent des fichiers : chacun de leurs arguments doit rester dans le coffre
// (verification finale, constat 2 : ditto, zip, cpio, curl, wget, sort, split, patch en plus).
const MOVERS = new Set(['mv', 'cp', 'ln', 'rsync', 'install', 'tee', 'dd', 'scp', 'tar', 'unzip', 'cd', 'pushd', 'ditto', 'zip', 'cpio', 'curl', 'wget', 'sort', 'split', 'patch']);
const REMOTE = new Set(['scp', 'rsync']);
const GLOB = /[*?[{]/;

/**
 * Les valeurs qu'un mot porte en plus de lui-meme : apres `=` (`if=/x` de dd, `--target-directory=/x`) et, pour une
 * option courte collee, apres la lettre (`-C/abs` de tar, `-t/tmp` de cp GNU). Constat 2.
 */
const carried = (word) => {
  const out = [];
  const eq = word.value.indexOf('=');
  if (eq >= 0) out.push({ raw: word.raw.slice(word.raw.indexOf('=') + 1), value: word.value.slice(eq + 1) });
  if (/^-[A-Za-z][^=\s]/.test(word.value)) out.push({ raw: word.raw.replace(/^(['"]?)-[A-Za-z]/, '$1'), value: word.value.slice(2) });
  return out;
};

/**
 * Un argument reste-t-il dans le coffre ? Rend la raison du refus, ou null. Relatif : il ne doit ni remonter (..), ni
 * porter d'expansion, ni de glob dans un dossier. Absolu (ou ~) : admis seulement si son chemin canonique est dans le
 * coffre (constat 7 : `cd <coffre> && mv inbox/x.md raw/…` ne doit pas etre refuse), puis juge comme un relatif.
 */
const unsafePath = (word, cwd) => {
  const { raw, value } = word;
  if (/[$`]/.test(raw)) return 'expansion shell ($, `)';
  if (/^[A-Za-z]:/.test(value) || value.includes('\\')) return 'chemin Windows ou echappement';
  const expanded = expandHome(value);
  const segments = expanded.split('/');
  if (segments.includes('..')) return 'remontee (..)';
  const globAt = segments.findIndex((seg) => GLOB.test(seg));
  if (globAt >= 0 && globAt < segments.length - 1) return 'motif de glob dans un dossier';
  const literal = globAt >= 0 ? segments.slice(0, -1).join('/') || (path.isAbsolute(expanded) ? '/' : '.') : expanded;
  const z = classify(canonical(path.isAbsolute(literal) ? literal : path.resolve(cwd, literal)));
  if (z.zone === 'secret') return 'zone secrete';
  if (z.zone === 'outside') return path.isAbsolute(expanded) ? 'chemin absolu hors du coffre' : 'hors du coffre';
  return null;
};

const moverName = (w) => fold(path.basename(w.value));

/**
 * Invariant « rien ne sort du coffre » (modes triage et ingest, ceux des sessions du circuit) : tout argument d'une
 * commande qui ecrit ou deplace (MOVERS), toute valeur qu'il porte (`=`, option collee), et toute cible de
 * redirection, reste dans le coffre. Un mot de MOVERS n'importe ou dans la commande simple (apres `xargs`, `env`,
 * `-exec`…) compte. scp et rsync : aucune destination distante (`hote:chemin`). Rend la raison, ou null.
 */
const escapesVault = (command, cwd) => {
  for (const { words, redirects } of shellWords(command)) {
    for (const r of redirects) {
      if (r.value === '/dev/null') continue;
      const why = unsafePath(r, cwd);
      if (why) return `redirection vers « ${r.raw} » : ${why}`;
    }
    const at = words.findIndex((w) => MOVERS.has(moverName(w)));
    if (at < 0) continue;
    const mover = moverName(words[at]);
    for (const w of words.slice(at + 1)) {
      if (MOVERS.has(moverName(w))) continue;
      if (REMOTE.has(mover) && /^[^/\s=]+:/.test(w.value) && !w.value.startsWith('-')) return `${mover} « ${w.raw} » : destination distante`;
      const targets = [...(w.value.startsWith('-') ? [] : [w]), ...carried(w)];
      for (const t of targets) {
        const why = unsafePath(t, cwd);
        if (why) return `${words[at].value} « ${w.raw} » : ${why}`;
      }
    }
  }
  return null;
};

// Les dossiers secrets sous leurs deux formes : canonique (liens resolus, casse reelle) ET telle que tapee (un chemin
// `/tmp/…` qui passe par un lien). Constat 3.
const SECRET_FORMS = [
  ...new Set(
    [
      path.join(HOME_DIR, '.config', 'kioku', 'mail'),
      process.env.XDG_CONFIG_HOME ? path.join(process.env.XDG_CONFIG_HOME, 'kioku', 'mail') : null,
      process.env.APPDATA ? path.join(process.env.APPDATA, 'kioku', 'mail') : null,
      path.join(HOME_DIR, 'AppData', 'Roaming', 'kioku', 'mail'),
    ]
      .filter(Boolean)
      .flatMap((p) => [path.resolve(p), ...SECRET_DIRS]),
  ),
];

/**
 * Un mot (motif de glob compris), apres ~ et $HOME, designe-t-il la zone secrete, ou peut-il l'atteindre ? Le motif
 * est normalise (`.`, `//`), sa partie litterale (avant le premier glob) passe par la canonisation (liens, casse), et il
 * est compare, plie sur un volume insensible a la casse, aux formes canonique et brute de chaque dossier secret.
 */
const wordReachesSecret = (value) => {
  const expanded = expandHome(value.replace(/^\$\{HOME\}/, '$HOME'));
  if (!path.isAbsolute(expanded)) return false;
  const norm = path.normalize(expanded);
  const parts = norm.split(path.sep).filter(Boolean);
  const globAt = parts.findIndex((seg) => GLOB.test(seg));
  const literal = path.join(path.parse(norm).root, ...(globAt < 0 ? parts : parts.slice(0, globAt)));
  const candidates = [norm, globAt < 0 ? canonical(norm) : path.join(canonical(literal), ...parts.slice(globAt))];
  for (const cand of candidates) {
    const pat = fold(cand).split(path.sep).filter(Boolean);
    for (const dir of SECRET_FORMS) {
      const seg = fold(dir).split(path.sep).filter(Boolean);
      if (pat.length < seg.length) continue;
      if (seg.every((s, i) => (GLOB.test(pat[i]) ? globCovers(pat[i], s) : pat[i] === s))) return true;
    }
  }
  return globAt < 0 && classify(canonical(norm)).zone === 'secret';
};

/** Un mot de la commande, ou une valeur qu'il porte (`if=…`, `-C…`), atteint-il la zone secrete ? */
const reachesSecret = (command) => {
  for (const { words, redirects } of shellWords(command)) {
    for (const w of [...words, ...redirects]) {
      if ([w, ...carried(w)].some((t) => wordReachesSecret(t.value))) return true;
    }
  }
  return false;
};

const RECURSIVE = [/(^|[\s;&|(])(rg|ag|find|tree|du)\b/, /\bgrep\b[^|;&\n]*\s-\w*[rR]/, /\bls\b[^|;&\n]*\s-\w*R/];

const decide = () => {
  let input;
  try {
    input = JSON.parse(readFileSync(0, 'utf8'));
  } catch {
    refuse('Garde du coffre : entree illisible. Dans le doute, je refuse.');
  }
  const tool = input?.tool_name;
  const args = input?.tool_input ?? {};
  const cwd = typeof input?.cwd === 'string' ? input.cwd : process.cwd();
  const target = (field) => {
    if (typeof args[field] !== 'string' || args[field] === '') return null;
    const p = expandHome(args[field]);
    // Pas de path.resolve sur le chemin donne : il plierait `lien/..` avant que canonical() ne suive le lien.
    return canonical(path.isAbsolute(p) ? p : `${path.resolve(cwd)}${path.sep}${p}`);
  };

  if (EDIT_TOOLS.has(tool)) {
    const abs = target('file_path') ?? target('notebook_path');
    if (abs === null) refuse(`Garde du coffre : ${tool} sans chemin lisible. Dans le doute, je refuse.`);
    const z = classify(abs);
    if (z.zone === 'secret') refuse(SECRET_REFUS);
    if (z.zone === 'garde') refuse("La garde du coffre (hooks du plugin, settings, agents, configuration du coffre et registres) ne se modifie pas depuis une session : c'est ce qui la fait tenir. Demande a l'utilisateur.");
    if (!canWrite(z)) refuse(CONSIGNE_ECRIRE);
    return;
  }

  if (READ_TOOLS.has(tool)) {
    const abs = target('file_path') ?? target('notebook_path');
    if (abs !== null && classify(abs).zone === 'secret') refuse(SECRET_REFUS);
    if (abs !== null && !canRead(classify(abs))) refuse(CONSIGNE_LIRE);
    return;
  }

  if (SEARCH_TOOLS.has(tool)) {
    const abs = target('path');
    if (abs === null) refuse(`Grep/Glob sans path : cela balayerait tout le coffre. Donne un path precis.\n${CONSIGNE_LIRE}`);
    const zone = classify(abs);
    // Une recherche dans le dossier secret, ou depuis un de ses parents (~, ~/.config…), le traverserait.
    if (zone.zone === 'secret' || SECRET_DIRS.some((d) => inside(d, abs))) refuse(SECRET_REFUS);
    if (!canRead(zone)) refuse(CONSIGNE_LIRE);
    // Grep/Glob sur silver/<D> tout entier traverserait heritage/ : les fiches se lisent une a une (Read).
    if (zone.zone === 'silver' && !zone.sub) refuse(`Grep/Glob sur silver/${D} refuse : l'instantane heritage/ (ferme) s'y trouve. Lis les fiches une a une avec Read.\n${CONSIGNE_LIRE}`);
    const scanned = [args.glob, tool === 'Glob' ? args.pattern : undefined].filter((v) => typeof v === 'string');
    for (const text of scanned) {
      // Constat 4 : un motif absolu (ou ~) ne se cantonne pas au `path` donne ; il ne doit pas atteindre la zone secrete.
      if (SECRET_MENTION.some((r) => r.test(text)) || wordReachesSecret(text)) refuse(SECRET_REFUS);
      const normalized = text.replace(/\\/g, '/');
      if (forbiddenMentions().some((r) => r.test(normalized) || r.test(fold(normalized)))) refuse(CONSIGNE_LIRE);
    }
    return;
  }

  if (tool === 'Bash') {
    const raw = args.command;
    if (typeof raw !== 'string') refuse('Garde du coffre : commande Bash illisible. Dans le doute, je refuse.');
    const command = stripMessages(raw);
    if (SECRET_MENTION.some((r) => r.test(command)) || SECRET_DIRS.some((d) => fold(command).includes(fold(d))) || reachesSecret(command)) refuse(SECRET_REFUS);
    if (MODE === 'triage' || MODE === 'ingest') {
      const why = escapesVault(command, canonical(path.resolve(cwd)));
      if (why) refuse(`Session ${MODE}/${D ?? '-'} : rien ne sort du coffre. Une commande qui ecrit ou deplace n'accepte que des chemins relatifs a l'interieur du coffre (ex. mv inbox/x.md raw/<domaine>/meetings/).\n(Refuse : ${why}.)`);
    }
    // Volume insensible a la casse : `cat WIKI/perso/p.md` ou `MV wiki w` ouvrent les memes fichiers et lancent les
    // memes commandes. Chaque regle se teste sur la commande telle quelle ET pliee (motifs en minuscules) ; la forme
    // telle quelle garde les drapeaux dont la casse compte (`ls -R`).
    if (shellWritesProtected(command) || (FOLD && shellWritesProtected(fold(command)))) refuse(`${CONSIGNE_ECRIRE}\n(Commande refusee : elle ecrit dans une zone fermee.)`);
    const normalized = command.replace(/\\/g, '/');
    const forms = FOLD ? [normalized, fold(normalized)] : [normalized];
    const hit = (r) => forms.some((f) => r.test(f));
    if (forbiddenMentions().some(hit)) refuse(`${CONSIGNE_LIRE}\n(Commande refusee : elle nomme une zone fermee.)`);
    if (GIT_CONTENT.some(hit)) {
      refuse(`${CONSIGNE_LIRE}\n(Commande refusee : l'historique git contient le brut et tous les domaines. Lis avec Read/Grep sur le dossier de ton domaine.)`);
    }
    if (RECURSIVE.some(hit) && !hit(allowedMention())) {
      refuse(`${CONSIGNE_LIRE}\n(Commande refusee : recherche recursive sans dossier autorise. Utilise Grep/Glob avec un path.)`);
    }
    if (hit(KIOKU_WRITE) && MODE !== 'setup') {
      refuse(`Session ${MODE}/${D ?? '-'} : configurer le coffre (kioku init, add-domain, upgrade --write) se fait en session setup (npm run setup, ou kioku session --mode setup), ou depuis un terminal hors de Claude Code.`);
    }
    // Filet (revue N4) : la meme commande sans guillemets ni echappements, $'…' reduit a son contenu. `kioku m''ail`,
    // `kioku "m"ail`, `kioku ma\\il` et `kioku $'mail'` y redeviennent `kioku mail`. L'invariant, lui, est dans le
    // circuit : il refuse de demarrer depuis une session (tools/connectors/circuit.mjs, sessionRefusal).
    const squashed = command.replace(/\$'([^']*)'/g, '$1').replace(/['"\\]/g, '');
    const squashedForms = FOLD ? [squashed, fold(squashed)] : [squashed];
    const hitAll = (r) => hit(r) || squashedForms.some((f) => r.test(f));
    // Se faire passer pour un terminal (vider VAULT_MODE ou CLAUDECODE) pour lancer un circuit : refuse partout.
    // Constat 5 : option collee (`env -uVAULT_MODE`), `env -` seul, chemin de l'outil (`/usr/bin/env`), `exec -c`.
    if (hitAll(/(^|[\s;&|(/])(unset\s|env\s+((-\S+\s+)*-\w*[iu]|-(\s|$)|--(ignore-environment|unset))|exec\s+(-\S+\s+)*-\w*c)|\b(VAULT_MODE|VAULT_DOMAIN|CLAUDECODE)\s*=/)) {
      refuse(`Session ${MODE}/${D ?? '-'} : modifier l'environnement de la session (VAULT_MODE, CLAUDECODE, env -i/-u, unset) est refuse : c'est ce qui la fait reconnaitre.`);
    }
    if (CIRCUIT_DENIED.some(hitAll)) {
      refuse(`Session ${MODE}/${D ?? '-'} : un circuit de capture (kioku plaud, npm run plaud:*, ses outils, tools/connectors/) se lance depuis le terminal de l'utilisateur, jamais depuis une session du coffre. Donne-lui la commande.`);
    }
    if (MODE === 'setup' && SETUP_DENIED.some(hitAll)) {
      refuse(`${CONSIGNE_LIRE}\n(Commande refusee : en session setup, ni la gate, ni le circuit Plaud, ni le lanceur, ni le dashboard : ils lisent un domaine ou ouvrent une autre session.)`);
    }
  }
};

try {
  decide();
} catch (error) {
  refuse(`Garde du coffre en panne (${errText(error)}). Dans le doute, je refuse.`);
}
