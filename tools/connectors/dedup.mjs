/**
 * Primitives de deduplication communes aux connecteurs : ou une source peut deja se trouver dans le coffre, son
 * empreinte, l'identifiant porte en frontmatter, et un registre JSON versionne des identifiants deja vus.
 *
 * Ce qui reste a chaque connecteur : QUEL identifiant fait foi et dans quel ordre on compare (Plaud : id, puis nom, puis
 * contenu ; mail : fil + dernier message, une reponse tardive etant une nouvelle source). Ces regles ne sont pas les
 * memes d'un connecteur a l'autre : elles ne sont pas ici.
 *
 * L'empreinte ignore le frontmatter et les fins de ligne : ajouter un identifiant a un brut ne change pas son empreinte.
 * Ce module lit des identifiants, des noms et des empreintes ; il ne rend jamais un contenu, et un registre n'en contient
 * pas. La deduplication ne depend pas du domaine : une source de raw/pro/ re-proposee est connue, quel que soit le
 * domaine que le tri lui donnerait.
 */

import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { domainsOf } from '../vault-config.mjs';

export const FRONTMATTER = /^---\n([\s\S]*?)\n---\n?/;

export const normalize = (text) => text.replace(/\r\n/g, '\n').replace(FRONTMATTER, '').trim();
export const sha = (text) => createHash('sha256').update(normalize(text)).digest('hex');

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** La valeur d'un champ simple du frontmatter (`<cle>: valeur`, guillemets toleres), ou null. */
export const frontmatterValue = (text, key) => {
  const head = text.replace(/\r\n/g, '\n').match(FRONTMATTER)?.[1];
  return head?.match(new RegExp(`^${escapeRe(key)}:\\s*["']?(\\S+?)["']?\\s*$`, 'm'))?.[1] ?? null;
};

/** Un depot : le markdown precede d'un frontmatter qui ne porte que l'identifiant. */
export const withFrontmatterId = (markdown, key, id) => `---\n${key}: ${id}\n---\n\n${markdown}`;

// Coffre sans configuration lisible (anterieur au plan core/data, ou test) : les deux domaines d'origine.
const LEGACY_DOMAINS = ['pro', 'perso'];
export const domainsOrLegacy = (vault) => {
  try {
    return domainsOf(vault);
  } catch {
    return LEGACY_DOMAINS;
  }
};

/** Les dossiers ou une source peut deja se trouver : [chemin relatif au coffre, recursif ?]. Un raw/<D> par domaine declare. */
export const places = (vault) => [
  ['inbox', false],
  [path.join('inbox', 'a-trancher'), false],
  ...domainsOrLegacy(vault).map((d) => [path.join('raw', d), true]),
];

export const mdFiles = (dir, recursive) => {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const abs = path.join(dir, e.name);
    if (e.isDirectory()) return recursive ? mdFiles(abs, true) : [];
    return e.name.endsWith('.md') && !e.name.startsWith('_') ? [abs] : [];
  });
};

const posix = (p) => p.split(path.sep).join('/');

/**
 * Photo de ce que le coffre contient deja : identifiant, nom, empreinte -> dossier (`raw/pro`, `inbox`...).
 * `idOf(text)` lit l'identifiant du connecteur dans un fichier (null s'il n'en porte pas).
 */
export const scanKnown = (vault, idOf) => {
  const ids = new Map();
  const names = new Map();
  const hashes = new Map();
  for (const [rel, recursive] of places(vault)) {
    const place = posix(rel);
    for (const file of mdFiles(path.join(vault, rel), recursive)) {
      const text = readFileSync(file, 'utf8');
      const id = idOf(text);
      if (id && !ids.has(id)) ids.set(id, place);
      const name = path.basename(file);
      if (!names.has(name)) names.set(name, place);
      const h = sha(text);
      if (!hashes.has(h)) hashes.set(h, place);
    }
  }
  return { ids, names, hashes };
};

// --- Registre : un tableau JSON d'entrees {id, …}, sans titre ni contenu. Versionne par le coffre. ---

/** Le registre, ou [] s'il n'existe pas. Un registre illisible leve : on ne repart pas d'un registre vide en silence. */
export const loadRegistryAt = (file) => (existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : []);

/** Ajoute une entree si son id n'y est pas deja. Rend true si le registre a change. */
export const addToRegistryAt = (file, entry) => {
  const entries = loadRegistryAt(file);
  if (entries.some((e) => e.id === entry.id)) return false;
  entries.push(entry);
  writeFileSync(file, `${JSON.stringify(entries, null, 1)}\n`);
  return true;
};
