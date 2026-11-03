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
 * des noms de pages), le circuit Plaud et le lanceur (ils ouvrent des sessions avec leurs propres droits), le dashboard.
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

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const VAULT = path.resolve(process.env.CLAUDE_PROJECT_DIR ?? path.join(HERE, '..', '..'));
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

const CONSIGNE_ECRIRE =
  `Ecriture directe interdite ici (session ${MODE}/${D ?? '-'}).\n` +
  `- wiki/ : ecris la page sous .candidats/wiki/${D ?? '<domaine>'}/<dossier>/<slug>.md, puis\n` +
  `  kioku check <candidate>, le relecteur (agent "reviewer", regles de domains/${D ?? '<domaine>'}/) rend un verdict, puis\n` +
  `  kioku promote <candidate>. Seuls wiki/${D ?? '<domaine>'}/index.md et log.md s'editent en place (et overview.md en mode ingest).\n` +
  `- raw/ est immuable, quarantine/ et .verdicts/ ne s'ecrivent que par vault.mjs, silver/ seulement en mode ingest.\n` +
  `- la configuration du coffre et les regles de domaine (domains/) ne s'ecrivent depuis aucune session.`;

const inside = (abs, dir) => {
  const rel = path.relative(dir, abs);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
};
const PROTECTED = new Set(cfg.protectedPaths.map((p) => path.resolve(p)));

const classify = (abs) => {
  if (inside(abs, HERE) || PROTECTED.has(abs)) return { zone: 'garde' };
  const rel = path.relative(VAULT, abs);
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
// En setup, ce qui lirait un domaine ou ouvrirait une session d'un autre mode : la gate, le circuit Plaud, le lanceur,
// le dashboard. Ni lecture de nom de page, ni escalade par processus enfant.
// La gate s'appelle `kioku <commande>` : ses sous-commandes (pas init, add-domain, doctor) lisent ou ecrivent un domaine.
const KIOKU_GATE = /(^|[\s;&|(/\\])kioku(\.mjs)?["']?\s+(check|verdict|promote|stage|rotate-log|propose-org|tag-org|propose-raw|tag-raw|quarantine|undecided|audit|flag|decide|seed)\b/;
// Les scripts npm du coffre (generes par init) : un par domaine declare (session query/<D>) et les prefixes communs.
// Les domaines viennent de la configuration : une liste figee laisserait `npm run travail` ouvrir une session de domaine
// depuis setup. `pro` et `perso` restent, pour les coffres anterieurs a la configuration.
const NPM_SCRIPTS = [...new Set([...cfg.domains, 'pro', 'perso', 'vault', 'ingest', 'triage', 'lint', 'dashboard', 'plaud', 'audit', 'undecided'])];
const NPM_DENIED = new RegExp(`(^|[\\s;&|(])npm\\s+(run\\s+)?(${NPM_SCRIPTS.join('|')})(?![\\w-])`);
// Les relais du CLI vers le lanceur, le dashboard et Plaud : sans chemin d'outil dans la commande, refuses par leur nom.
const KIOKU_TOOLS = /(^|[\s;&|(/\\])kioku(\.mjs)?["']?\s+(session|dashboard|plaud)\b/;
const SETUP_DENIED = [/vault\.mjs/, KIOKU_GATE, KIOKU_TOOLS, /plaud-sync[/\\]/, /tools[/\\]dashboard[/\\]/, NPM_DENIED];

// Une commande shell qui ecrit, et qui vise une zone fermee en ecriture.
const WRITERS = [/(^|[\s;&|(])(sed|perl)\b[^\n;&|]*\s-\w*i/, /(^|[\s;&|(])tee\b/, /(^|[\s;&|(])(mv|cp|rm|touch|truncate|ln|install|dd)\b/];
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const PROTECTED_REL = [...PROTECTED].filter((p) => inside(p, VAULT)).map((p) => escapeRe(path.relative(VAULT, p)).replace(/\\\\|\//g, '[/\\\\]'));
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
const PROTECTED_NAMES = [...PROTECTED].filter((p) => inside(p, VAULT)).map((p) => path.relative(VAULT, p).split(path.sep).join('/'));
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
  const target = (field) => (typeof args[field] === 'string' && args[field] !== '' ? path.resolve(cwd, args[field]) : null);

  if (EDIT_TOOLS.has(tool)) {
    const abs = target('file_path') ?? target('notebook_path');
    if (abs === null) refuse(`Garde du coffre : ${tool} sans chemin lisible. Dans le doute, je refuse.`);
    const z = classify(abs);
    if (z.zone === 'garde') refuse("La garde du coffre (hooks du plugin, settings, agents, configuration du coffre et registres) ne se modifie pas depuis une session : c'est ce qui la fait tenir. Demande a l'utilisateur.");
    if (!canWrite(z)) refuse(CONSIGNE_ECRIRE);
    return;
  }

  if (READ_TOOLS.has(tool)) {
    const abs = target('file_path') ?? target('notebook_path');
    if (abs !== null && !canRead(classify(abs))) refuse(CONSIGNE_LIRE);
    return;
  }

  if (SEARCH_TOOLS.has(tool)) {
    const abs = target('path');
    if (abs === null) refuse(`Grep/Glob sans path : cela balayerait tout le coffre. Donne un path precis.\n${CONSIGNE_LIRE}`);
    const zone = classify(abs);
    if (!canRead(zone)) refuse(CONSIGNE_LIRE);
    // Grep/Glob sur silver/<D> tout entier traverserait heritage/ : les fiches se lisent une a une (Read).
    if (zone.zone === 'silver' && !zone.sub) refuse(`Grep/Glob sur silver/${D} refuse : l'instantane heritage/ (ferme) s'y trouve. Lis les fiches une a une avec Read.\n${CONSIGNE_LIRE}`);
    const scanned = [args.glob, tool === 'Glob' ? args.pattern : undefined].filter((v) => typeof v === 'string');
    for (const text of scanned) {
      const normalized = text.replace(/\\/g, '/');
      if (forbiddenMentions().some((r) => r.test(normalized))) refuse(CONSIGNE_LIRE);
    }
    return;
  }

  if (tool === 'Bash') {
    const raw = args.command;
    if (typeof raw !== 'string') refuse('Garde du coffre : commande Bash illisible. Dans le doute, je refuse.');
    const command = stripMessages(raw);
    if (shellWritesProtected(command)) refuse(`${CONSIGNE_ECRIRE}\n(Commande refusee : elle ecrit dans une zone fermee.)`);
    const normalized = command.replace(/\\/g, '/');
    if (forbiddenMentions().some((r) => r.test(normalized))) refuse(`${CONSIGNE_LIRE}\n(Commande refusee : elle nomme une zone fermee.)`);
    if (GIT_CONTENT.some((r) => r.test(normalized))) {
      refuse(`${CONSIGNE_LIRE}\n(Commande refusee : l'historique git contient le brut et tous les domaines. Lis avec Read/Grep sur le dossier de ton domaine.)`);
    }
    if (RECURSIVE.some((r) => r.test(normalized)) && !allowedMention().test(normalized)) {
      refuse(`${CONSIGNE_LIRE}\n(Commande refusee : recherche recursive sans dossier autorise. Utilise Grep/Glob avec un path.)`);
    }
    if (KIOKU_WRITE.test(normalized) && MODE !== 'setup') {
      refuse(`Session ${MODE}/${D ?? '-'} : configurer le coffre (kioku init, add-domain, upgrade --write) se fait en session setup (npm run setup, ou kioku session --mode setup), ou depuis un terminal hors de Claude Code.`);
    }
    if (MODE === 'setup' && SETUP_DENIED.some((r) => r.test(normalized))) {
      refuse(`${CONSIGNE_LIRE}\n(Commande refusee : en session setup, ni la gate, ni le circuit Plaud, ni le lanceur, ni le dashboard : ils lisent un domaine ou ouvrent une autre session.)`);
    }
  }
};

try {
  decide();
} catch (error) {
  refuse(`Garde du coffre en panne (${errText(error)}). Dans le doute, je refuse.`);
}
