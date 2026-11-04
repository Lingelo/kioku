/**
 * Configuration du coffre (plan core/data, KTD3) : la liste des domaines et ce qui s'y rattache.
 * Seule source de verite des noms de domaine pour la garde, la gate, le lanceur, le lint, le dashboard et Plaud.
 *
 *   loadConfig(vaultDir) -> { file, domains, has(d), others(d), domain(d), rulesPath(d), orgRegistry(d),
 *                             defaultSession, modules, core, protectedPaths }
 *
 * Le fichier vit a la racine du coffre (kioku.config.json). Absent, illisible ou invalide : une erreur qui le nomme,
 * jamais une valeur par defaut silencieuse. Une cle inconnue (extension, module) est une erreur : une faute de frappe
 * sur `org` desactiverait sinon le controle sans bruit.
 *
 * `default_session` (optionnel) : la session que vaut une ouverture sans VAULT_MODE / VAULT_DOMAIN. Absent, une telle
 * session est refusee (R17b). Le defaut est un choix ecrit et versionne du coffre, pas une valeur du code.
 *
 * Le chemin du registre d'une extension `org` est garde tel quel : le registre se charge a part (orgs.mjs), et son
 * absence ne concerne que les pages du domaine qui l'utilise.
 */

import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const CONFIG_NAME = 'kioku.config.json';
export const DOMAIN_ID = /^[a-z0-9]+(-[a-z0-9]+)*$/;
export const SESSION_MODES = ['query', 'ingest', 'triage', 'setup'];
// Un domaine est un segment de chemin (wiki/<D>, raw/<D>…) : un nom deja porteur d'un sens dans l'arborescence est refuse.
const RESERVED = new Set(['heritage']);
const EXTENSIONS = new Set(['org']);
const MODULES = new Set(['plaud', 'dashboard']);

export const configFile = (vaultDir) => path.join(vaultDir, CONFIG_NAME);

// Dossiers propres a un coffre : l'un d'eux sans configuration lisible = coffre abime (chantier 1, plan apres U12).
export const VAULT_MARKERS = ['wiki', 'raw', 'silver', 'domains', '.kioku'];
// Les seuls marqueurs cherches chez les parents : propres a Kioku. `wiki/` ou `raw/` existent hors de tout coffre ;
// un `~/raw` couperait sinon la garde de tous les projets sous le dossier personnel.
const ANCESTOR_MARKERS = [CONFIG_NAME, '.kioku'];

const isDir = (p) => {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
};

/**
 * Ce qu'est un dossier projet pour la garde, avant de charger quoi que ce soit :
 *   'vault'   la configuration est la (lisible ou non : loadConfig tranchera, et un echec vaut refus)
 *   'broken'  pas de configuration, mais un marqueur de coffre ici, ou un marqueur Kioku chez un parent
 *   'none'    rien : un projet ordinaire, ou un dossier vide avant `kioku init`
 * Un parent porteur d'un marqueur rend 'broken', jamais 'vault' : la garde ne se rabat pas sur une autre racine que
 * celle du projet ; une session ouverte dans un sous-dossier du coffre est refusee, pas silencieusement deplacee.
 */
export const locateVault = (dir) => {
  if (existsSync(configFile(dir))) return 'vault';
  if (vaultMarkers(dir).length) return 'broken';
  // Un projet dont les settings declarent Kioku a ete un coffre : marqueurs et configuration absents = effaces depuis
  // une session (revue de securite : `mv wiki w`, `mv kioku.config.j* …`), pas un projet ordinaire. Ces settings sont
  // en zone garde : aucune session ne les ecrit tant que la garde tient.
  return declaresKioku(dir) ? 'broken' : 'none';
};

/**
 * Les settings du projet declarent-ils Kioku (catalogue kioku-pin, plugin kioku@*, hook vers une garde) ? Illisibles :
 * oui (echec ferme : on ne sait pas, donc on garde).
 */
export const declaresKioku = (dir) => {
  // Projet ouvert dans le dossier personnel : <dir>/.claude est alors la configuration UTILISATEUR de Claude Code, ou le
  // plugin est active pour tous les projets. Ce n'est pas une declaration du projet : sans cette sortie, ~ passait pour
  // un coffre abime et la garde refusait tout. Limite, dite : un coffre cree dans ~ dont on aurait efface configuration
  // et marqueurs ne serait plus reconnu par ce seul test (configuration et marqueurs, eux, le sont avant).
  if (realOrResolved(path.join(dir, '.claude')) === userClaudeDir()) return false;
  for (const name of ['settings.json', 'settings.local.json']) {
    const file = path.join(dir, '.claude', name);
    if (!existsSync(file)) continue;
    let s;
    try {
      s = JSON.parse(readFileSync(file, 'utf8'));
    } catch {
      return true;
    }
    if (!isObject(s)) return true;
    if (Object.keys(s.extraKnownMarketplaces ?? {}).some((k) => /kioku/i.test(k))) return true;
    if (Object.keys(s.enabledPlugins ?? {}).some((k) => /^kioku@/.test(k))) return true;
    if (JSON.stringify(s.hooks ?? {}).includes('guard.mjs')) return true;
  }
  return false;
};

// realpath si le chemin existe (macOS : /var -> /private/var, ~/.claude en lien symbolique), sinon le chemin resolu.
const realOrResolved = (p) => {
  try {
    return realpathSync(p);
  } catch {
    return path.resolve(p);
  }
};
// Le dossier de configuration utilisateur de Claude Code : CLAUDE_CONFIG_DIR s'il est pose, sinon ~/.claude.
const userClaudeDir = () => realOrResolved(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'));

/** Les marqueurs trouves, en chemins absolus : ceux du dossier, puis ceux des parents (pour le dire dans doctor). */
export const vaultMarkers = (dir) => {
  const found = VAULT_MARKERS.map((m) => path.join(dir, m)).filter(isDir);
  for (let p = path.dirname(dir); p !== path.dirname(p); p = path.dirname(p)) {
    found.push(...ANCESTOR_MARKERS.map((m) => path.join(p, m)).filter((f) => existsSync(f)));
  }
  return found;
};

// Un chemin de la config est relatif au coffre et y reste : ni absolu, ni remontee.
const vaultRelative = (value) =>
  typeof value === 'string' && value !== '' && !path.isAbsolute(value) && !value.split(/[/\\]/).includes('..');

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

export const loadConfig = (vaultDir) => {
  const file = configFile(vaultDir);
  if (!existsSync(file)) throw new Error(`configuration du coffre absente : ${CONFIG_NAME}`);
  let data;
  try {
    data = JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    throw new Error(`configuration du coffre illisible (${CONFIG_NAME}) : ${error instanceof Error ? error.message : String(error)}`);
  }
  const problems = [];
  if (!isObject(data)) problems.push('la configuration doit etre un objet');
  else if (data.version !== 1) problems.push(`"version" doit valoir 1 (recu ${JSON.stringify(data.version)})`);

  const list = Array.isArray(data?.domains) ? data.domains : (problems.push('"domains" doit etre une liste'), []);
  if (Array.isArray(data?.domains) && list.length === 0) problems.push('"domains" ne peut pas etre vide');
  const byId = new Map();
  for (const d of list) {
    const id = d?.id;
    if (!DOMAIN_ID.test(id ?? '')) {
      problems.push(`identifiant de domaine invalide : "${id ?? ''}" (kebab-case ASCII attendu)`);
      continue;
    }
    if (RESERVED.has(id)) problems.push(`identifiant de domaine reserve : ${id}`);
    if (byId.has(id)) problems.push(`domaine en double : ${id}`);
    if (d.description !== undefined && typeof d.description !== 'string') problems.push(`${id} : "description" doit etre un texte`);
    const ext = d.extensions ?? {};
    if (!isObject(ext)) problems.push(`${id} : "extensions" doit etre un objet`);
    else {
      for (const key of Object.keys(ext)) if (!EXTENSIONS.has(key)) problems.push(`${id} : extension inconnue "${key}"`);
      if (ext.org !== undefined && !vaultRelative(ext.org?.registry)) problems.push(`${id} : extension org, "registry" doit etre un chemin relatif au coffre`);
    }
    byId.set(id, { id, description: d.description ?? '', extensions: isObject(ext) ? ext : {} });
  }

  const modules = data?.modules ?? {};
  if (!isObject(modules)) problems.push('"modules" doit etre un objet');
  else {
    for (const key of Object.keys(modules)) if (!MODULES.has(key)) problems.push(`module inconnu "${key}"`);
    if (modules.plaud !== undefined && !vaultRelative(modules.plaud?.state)) problems.push('module plaud : "state" doit etre un chemin relatif au coffre');
  }
  if (data?.core !== undefined && (typeof data.core !== 'string' || data.core === '')) problems.push('"core" doit etre un chemin');
  // Le format de coffre exige (entier >= 1, 1 s'il manque) : compare au format du core par doctor, le lanceur et le
  // relais (tools/plugin-install.mjs), pas par la garde, qui doit charger la configuration quelle que soit sa version.
  if (data?.format !== undefined && !(Number.isInteger(data.format) && data.format >= 1)) problems.push('"format" doit etre un entier >= 1');

  const ds = data?.default_session;
  if (ds !== undefined) {
    if (!isObject(ds) || !SESSION_MODES.includes(ds.mode)) problems.push(`"default_session.mode" doit valoir ${SESSION_MODES.join('|')}`);
    else if ((ds.mode === 'query' || ds.mode === 'ingest') && !byId.has(ds.domain)) {
      problems.push(`"default_session.domain" doit etre un domaine declare (recu ${JSON.stringify(ds.domain)})`);
    }
  }

  if (problems.length) throw new Error(`configuration du coffre invalide (${CONFIG_NAME}) : ${problems.join(' ; ')}`);

  const domains = [...byId.keys()];
  const known = (d) => {
    if (!byId.has(d)) throw new Error(`domaine non declare : "${d}" (declares : ${domains.join(', ')})`);
    return byId.get(d);
  };
  const orgRegistry = (d) => {
    const reg = known(d).extensions.org?.registry;
    return reg === undefined ? null : path.join(vaultDir, reg);
  };
  return {
    file,
    domains,
    has: (d) => byId.has(d),
    others: (d) => domains.filter((x) => x !== d),
    domain: known,
    rulesPath: (d) => (known(d), path.join(vaultDir, 'domains', d, 'rules.md')),
    orgRegistry,
    defaultSession: ds === undefined ? null : { mode: ds.mode, domain: ds.domain },
    modules: isObject(modules) ? modules : {},
    core: data.core ?? null,
    format: data.format ?? 1,
    // Fichiers qui configurent la garde ou la gate : aucune session ne les ecrit (KTD6). Chemins absolus.
    protectedPaths: [file, ...domains.map(orgRegistry).filter(Boolean)],
  };
};
