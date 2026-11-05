/**
 * Les parties gerees d'un coffre (decision 2 du 2026-11-02) : ce que init cree et que upgrade / add-domain remettent a
 * la forme courante, sans toucher au reste. Fonctions pures (texte ou objet en entree, en sortie) : l'ecriture et la
 * simulation sont du ressort de l'appelant.
 *
 *   fichier                 partie geree
 *   package.json            scripts dont la valeur commence par `kioku ` (ou ancien format genere, voir LEGACY) :
 *                           reecrits ; les autres intacts
 *   .gitignore              bloc `# >>> kioku` … `# <<< kioku`
 *   .claude/settings.json   enabledPlugins["kioku@dojo"] ; retire l'ancien catalogue epingle (kioku-pin) et les
 *                           anciennes cles kioku (seuls retraits : elles etaient gerees par Kioku)
 *   kioku.config.json       ajout seul (format, default_session, modules) : jamais d'ecrasement d'une valeur posee
 *
 * Un script gere qui n'est plus voulu (module retire) n'est PAS supprime : la valeur `kioku …` peut avoir ete ecrite a
 * la main, et une suppression silencieuse perdrait ce travail. Il est signale.
 */

import { readFileSync } from 'node:fs';

import { KIOKU_ID as PLUGIN_ID } from './plugin-install.mjs';

export const MANAGED_PREFIX = 'kioku ';
// Le plugin vient de la marketplace dojo, installe au niveau utilisateur et mis a jour par Claude Code : le coffre
// declare seulement qu'il l'utilise (enabledPlugins), sans version ni marketplace. La compatibilite tient au format.
export { INSTALL_HINT, KIOKU_ID as PLUGIN_ID, MARKETPLACE } from './plugin-install.mjs';
// Ancien catalogue epingle par coffre (avant 2026-11-03) : une marketplace par nom et par machine, donc un seul SHA
// pour tous les coffres. Retire par upgrade.
export const LEGACY_PIN = 'kioku-pin';
// Source unique : hooks/format.json (lu aussi par le relais, copie hors du core).
export const VAULT_FORMAT = JSON.parse(readFileSync(new URL('../hooks/format.json', import.meta.url), 'utf8')).vault;
export const BLOCK_START = '# >>> kioku (gere par kioku init / upgrade : ne pas editer entre ces lignes)';
export const BLOCK_END = '# <<< kioku';

// Ancien format genere par init avant le relais (2b5bf7a) ; a retirer quand plus aucun coffre ne le porte.
// Ancre sur toute la valeur, `${KIOKU_HOME:-$HOME/kioku}` litteral, arguments limites a des mots et options : un `&&`,
// un `;`, un `|` ou un autre chemin ne correspondent pas, et le script reste maison.
const OLD_CORE = '${KIOKU_HOME:-$HOME/kioku}';
const ARGS = '((?: [\\w.:-]+)*)';
const esc = (t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const LEGACY = [
  [new RegExp(`^node ${esc(OLD_CORE)}/tools/vault\\.mjs${ARGS}$`), (a) => sessionFromVaultArgs(a)],
  [new RegExp(`^node ${esc(OLD_CORE)}/tools/dashboard/run\\.mjs${ARGS}$`), (a) => `kioku dashboard${a}`],
  [new RegExp(`^node ${esc(OLD_CORE)}/tools/dashboard/serve\\.mjs${ARGS}$`), (a) => `kioku dashboard${a} --serve`],
  [new RegExp(`^node ${esc(OLD_CORE)}/tools/plaud-sync/run\\.mjs --vault \\.${ARGS}$`), (a) => `kioku plaud${a}`],
  [new RegExp(`^${esc(OLD_CORE)}/bin/kioku${ARGS}$`), (a) => `kioku${a}`],
];
// vault.mjs [--mode M] [--lint] [--domain D] -> kioku session [D] [--mode M] [--lint] (ordre des scripts generes).
const sessionFromVaultArgs = (args) => {
  const words = args.trim() ? args.trim().split(' ') : [];
  const i = words.indexOf('--domain');
  const domain = i >= 0 ? words[i + 1] : undefined;
  if (i >= 0 && !domain) return null;
  const rest = i < 0 ? words : words.filter((_, j) => j !== i && j !== i + 1);
  return ['kioku session', domain, ...rest].filter(Boolean).join(' ');
};

/** La forme `kioku …` d'un script de l'ancien format genere, ou null (script maison, ou deja au format courant). */
export const legacyTranslation = (value) => {
  if (typeof value !== 'string') return null;
  for (const [re, translate] of LEGACY) {
    const m = value.match(re);
    if (m) return translate(m[1]);
  }
  return null;
};

const isManaged = (value) => typeof value === 'string' && (value.startsWith(MANAGED_PREFIX) || legacyTranslation(value) !== null);

/** Les scripts npm d'un domaine. */
export const domainScripts = (d) => ({
  [d]: `kioku session ${d}`,
  [`ingest:${d}`]: `kioku session ${d} --mode ingest`,
  [`lint:${d}`]: `kioku session ${d} --lint`,
  [`audit:${d}`]: `kioku audit ${d}`,
  [`dashboard:${d}`]: `kioku dashboard ${d}`,
  [`dashboard:serve:${d}`]: `kioku dashboard ${d} --serve`,
});

/** Tous les scripts geres d'un coffre : communs, par domaine, Plaud si le module est declare. */
export const managedScripts = (domains, { plaud = false } = {}) => ({
  vault: 'kioku session',
  triage: 'kioku session --mode triage',
  setup: 'kioku session --mode setup',
  doctor: 'kioku doctor --vault .',
  undecided: 'kioku undecided',
  dashboard: `kioku dashboard ${domains[0]}`,
  'dashboard:serve': `kioku dashboard ${domains[0]} --serve`,
  'dashboard:all': 'kioku dashboard all',
  ...Object.assign({}, ...domains.map(domainScripts)),
  ...(plaud
    ? { 'plaud:sync': 'kioku plaud', 'plaud:dry-run': 'kioku plaud --dry-run', 'plaud:pending': 'kioku plaud --skip-fetch', 'plaud:drop': 'kioku plaud --drop' }
    : {}),
});

/**
 * Fusionne les scripts voulus dans ceux du package.json. Rend { scripts, changes, kept, stale } :
 *   changes  cles ajoutees ou reecrites (gerees)
 *   kept     cles voulues mais occupees par un script maison (valeur sans `kioku `) : laissees
 *   stale    scripts geres que la forme courante ne produit plus : laisses, signales
 * L'ordre des cles existantes est conserve ; les nouvelles s'ajoutent a la fin.
 */
export const mergeScripts = (existing = {}, wanted = {}) => {
  const scripts = { ...existing };
  const changes = [];
  const kept = [];
  for (const [k, v] of Object.entries(wanted)) {
    if (!(k in scripts)) {
      scripts[k] = v;
      changes.push(k);
    } else if (isManaged(scripts[k])) {
      if (scripts[k] !== v) {
        scripts[k] = v;
        changes.push(k);
      }
    } else kept.push(k);
  }
  // Ancien format sans equivalent voulu : traduit sur place (il reste gere), et signale comme obsolete.
  const stale = Object.keys(existing).filter((k) => isManaged(existing[k]) && !(k in wanted));
  for (const k of stale) {
    const t = legacyTranslation(existing[k]);
    if (t) {
      scripts[k] = t;
      changes.push(k);
    }
  }
  return { scripts, changes, kept, stale };
};

/** Le bloc gere du .gitignore. */
export const gitignoreBlock = ({ plaud = false } = {}) =>
  [
    BLOCK_START,
    "# L'entrant n'est pas encore classe ; les secrets ne se versionnent pas",
    'inbox/',
    '.env',
    '.env.*',
    '# HTML du dashboard : le contenu du wiki en clair',
    'tools/dashboard/dashboard-*.html',
    // Le verrou commun du coffre (tools/connectors/lock.mjs) : pris par tout circuit de capture et par rotate-log,
    // tag-org, upgrade, add-domain, donc dans tout coffre, module Plaud ou non.
    '# Verrou local du coffre (circuits de capture, reecritures de la gate)',
    'tools/connectors/.lock.json',
    ...(plaud ? ['# Etat local du circuit Plaud', 'tools/plaud-sync/.snapshot.json', 'tools/plaud-sync/.queue.json', 'tools/plaud-sync/.lock.json'] : []),
    BLOCK_END,
  ].join('\n');

/**
 * Remplace le bloc gere (s'il existe) ou l'ajoute en fin de fichier. Un bloc ouvert sans fin, ou en double : erreur
 * (on ne devine pas ou s'arrete la partie geree). Rend le nouveau texte.
 */
export const mergeGitignore = (text = '', block) => {
  const lines = text.split('\n');
  const starts = lines.flatMap((l, i) => (l.startsWith('# >>> kioku') ? [i] : []));
  const ends = lines.flatMap((l, i) => (l === BLOCK_END ? [i] : []));
  if (starts.length > 1 || ends.length > 1) throw new Error('.gitignore : bloc kioku en double, a corriger a la main');
  if (starts.length !== ends.length || (starts.length && ends[0] < starts[0])) throw new Error('.gitignore : bloc kioku ouvert sans fin (ou fin sans debut), a corriger a la main');
  if (starts.length) return [...lines.slice(0, starts[0]), block, ...lines.slice(ends[0] + 1)].join('\n');
  const base = text === '' ? '' : text.endsWith('\n') ? text : `${text}\n`;
  return `${base}${base === '' ? '' : '\n'}${block}\n`;
};

// Les identifiants Kioku anterieurs, retires par upgrade : catalogue epingle par coffre (kioku-pin), puis marketplace
// du core (kioku). Un coffre n'active plus que kioku@dojo.
const LEGACY_PLUGINS = [`kioku@${LEGACY_PIN}`, 'kioku@kioku'];
const LEGACY_MARKETS = [LEGACY_PIN, 'kioku'];

/** Les cles gerees des settings : le plugin active, sans version. Le reste des settings est conserve tel quel. */
export const mergeSettings = (settings = {}) => {
  const markets = Object.fromEntries(Object.entries(settings.extraKnownMarketplaces ?? {}).filter(([k]) => !LEGACY_MARKETS.includes(k)));
  const plugins = Object.fromEntries(Object.entries(settings.enabledPlugins ?? {}).filter(([k]) => !LEGACY_PLUGINS.includes(k)));
  const { extraKnownMarketplaces: _m, ...rest } = settings;
  return { ...rest, ...(Object.keys(markets).length ? { extraKnownMarketplaces: markets } : {}), enabledPlugins: { ...plugins, [PLUGIN_ID]: true } };
};

/** Ajout seul : une cle absente de la config est posee, une valeur presente n'est jamais remplacee. */
export const mergeConfig = (config, { domains, plaud = false }) => {
  const out = { ...config };
  const added = [];
  if (out.format === undefined) {
    out.format = VAULT_FORMAT;
    added.push('format');
  }
  if (out.default_session === undefined) {
    out.default_session = { mode: 'query', domain: domains[0] };
    added.push('default_session');
  }
  const modules = { ...(out.modules ?? {}) };
  if (modules.dashboard === undefined) {
    modules.dashboard = {};
    added.push('modules.dashboard');
  }
  if (plaud && modules.plaud === undefined) {
    modules.plaud = { state: 'tools/plaud-sync' };
    added.push('modules.plaud');
  }
  out.modules = modules;
  return { config: out, added };
};

/**
 * Ajoute des cles de premier niveau a un objet JSON sans reformater le reste : insertion avant la derniere accolade,
 * a l'indentation de la premiere cle. Rend le texte, ou null si l'insertion simple ne s'applique pas (l'appelant
 * reecrit alors tout le fichier). Le resultat est toujours relu et compare a l'objet attendu.
 */
export const appendTopLevelKeys = (text, entries, expected) => {
  const end = text.lastIndexOf('}');
  if (end < 0) return null;
  const head = text.slice(0, end).replace(/\s*$/, '');
  const indent = text.match(/\n([ \t]+)"/)?.[1] ?? '  ';
  const add = Object.entries(entries).map(([k, v]) => `${indent}${JSON.stringify(k)}: ${JSON.stringify(v)}`).join(',\n');
  const out = `${head}${head.endsWith('{') ? '' : ','}\n${add}\n${text.slice(end)}`;
  try {
    return JSON.stringify(JSON.parse(out)) === JSON.stringify(expected) ? out : null;
  } catch {
    return null;
  }
};
