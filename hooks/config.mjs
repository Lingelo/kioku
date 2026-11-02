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

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

export const CONFIG_NAME = 'kioku.config.json';
export const DOMAIN_ID = /^[a-z0-9]+(-[a-z0-9]+)*$/;
export const SESSION_MODES = ['query', 'ingest', 'triage', 'setup'];
// Un domaine est un segment de chemin (wiki/<D>, raw/<D>…) : un nom deja porteur d'un sens dans l'arborescence est refuse.
const RESERVED = new Set(['heritage']);
const EXTENSIONS = new Set(['org']);
const MODULES = new Set(['plaud', 'dashboard']);

export const configFile = (vaultDir) => path.join(vaultDir, CONFIG_NAME);

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
    // Fichiers qui configurent la garde ou la gate : aucune session ne les ecrit (KTD6). Chemins absolus.
    protectedPaths: [file, ...domains.map(orgRegistry).filter(Boolean)],
  };
};
