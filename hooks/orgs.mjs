/**
 * Registre des organisations du domaine pro (CLAUDE.md §1, §6) : l'employeur et les clients, actifs ou passes.
 * Seule source de verite des identifiants `org:`. Le fichier .claude/hooks/orgs.json vit dans la zone de la garde :
 * toute session le lit, aucune ne l'ecrit (ajouter un client = l'utilisateur edite ce fichier).
 *
 *   loadOrgs(vaultDir) -> { employer, orgs: [{ id, name, role, status, aliases }], clients, active, ids, required }
 *
 * Le coffre est passe explicitement : vault.mjs donne son VAULT, tools/plaud-sync celui de --vault.
 * Un registre absent ou invalide leve une erreur qui le nomme : jamais de valeur par defaut silencieuse.
 */

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

export const ORG_ID = /^[a-z0-9]+(-[a-z0-9]+)*$/;

export const orgsFile = (vaultDir) => path.join(vaultDir, '.claude', 'hooks', 'orgs.json');

// `file` : le registre que declare la configuration du coffre (extension org d'un domaine, voir config.mjs).
// Sans lui, l'emplacement historique : les appelants hors gate (tools/) y passent jusqu'a leur migration (U5).
export const loadOrgs = (vaultDir, file = orgsFile(vaultDir)) => {
  const where = path.relative(vaultDir, file);
  if (!existsSync(file)) throw new Error(`registre des organisations absent : ${where}`);
  let data;
  try {
    data = JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    throw new Error(`registre des organisations illisible (${where}) : ${error instanceof Error ? error.message : String(error)}`);
  }
  const problems = [];
  const list = Array.isArray(data?.orgs) ? data.orgs : (problems.push('"orgs" doit etre une liste'), []);
  const ids = new Set();
  for (const o of list) {
    if (!ORG_ID.test(o?.id ?? '')) problems.push(`identifiant invalide : "${o?.id ?? ''}" (kebab-case ASCII attendu)`);
    else if (ids.has(o.id)) problems.push(`identifiant en double : ${o.id}`);
    else ids.add(o.id);
    if (!o?.name) problems.push(`${o?.id ?? '?'} : "name" manquant`);
    if (o?.role !== 'employer' && o?.role !== 'client') problems.push(`${o?.id ?? '?'} : "role" doit valoir employer ou client`);
    if (o?.role === 'client' && o?.status !== 'active' && o?.status !== 'past') problems.push(`${o?.id ?? '?'} : "status" doit valoir active ou past`);
  }
  const employers = list.filter((o) => o?.role === 'employer');
  if (employers.length !== 1) problems.push(`un seul employeur attendu, ${employers.length} trouve(s)`);
  else if (data?.employer !== employers[0].id) problems.push(`"employer" (${data?.employer ?? ''}) ne designe pas l'employeur de la liste (${employers[0].id})`);
  if (typeof data?.org_required !== 'boolean') problems.push('"org_required" doit valoir true ou false');
  if (problems.length) throw new Error(`registre des organisations invalide (${where}) : ${problems.join(' ; ')}`);
  const orgs = list.map((o) => ({ id: o.id, name: o.name, role: o.role, status: o.role === 'employer' ? 'active' : o.status, aliases: Array.isArray(o.aliases) ? o.aliases : [] }));
  const clients = orgs.filter((o) => o.role === 'client');
  return { employer: employers[0].id, orgs, clients, active: clients.filter((o) => o.status === 'active'), ids, required: data.org_required };
};

/**
 * `org: [a, b]` sur une ligne -> ['a', 'b'] ; null si la valeur n'est pas une liste sur une ligne.
 * Une liste YAML sur plusieurs lignes laisse une valeur vide apres `org:` : elle est rejetee, pas ignoree.
 */
export const parseOrgList = (value) => {
  const m = String(value ?? '').trim().match(/^\[(.*)\]$/);
  if (!m) return null;
  return m[1].split(',').map((s) => s.trim().replace(/^["']|["']$/g, '')).filter(Boolean);
};

/** Forme canonique ecrite par l'outillage : identifiants uniques, ordre alphabetique. */
export const formatOrgList = (ids) => `[${[...new Set(ids)].sort().join(', ')}]`;

export const sameOrgSet = (a, b) => {
  const x = new Set(a);
  const y = new Set(b);
  return x.size === y.size && [...x].every((v) => y.has(v));
};
