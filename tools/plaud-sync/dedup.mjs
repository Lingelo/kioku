/**
 * Deduplication des notes Plaud, pour tous les domaines declares a la fois.
 *
 * Une note est deja connue si (dans cet ordre) :
 *   1. son id Plaud (`of_...`) est dans seen.json, ou dans le frontmatter (`plaud_id:`) d'un fichier de inbox/,
 *      inbox/a-trancher/ ou raw/<D>/ (chaque domaine declare)            -> connu:id | ecarte:registre
 *   2. son nom de fichier existe deja dans l'un de ces dossiers             -> connu:nom
 *   3. le sha256 de son contenu egale celui d'un fichier deja present       -> connu:contenu
 * Le nom est derive du titre Plaud, qui change (retitrage, troncature) : l'id est la cle, le contenu le filet.
 *
 * Le hash ignore le frontmatter et les fins de ligne : ajouter `plaud_id:` a un brut ne change pas son empreinte.
 * Ce module lit des ids, des noms et des empreintes ; il ne rend jamais un contenu, et seen.json n'en contient pas.
 * La deduplication ne depend pas du domaine : une note de raw/pro/ re-proposee est connue, quel que soit le domaine
 * que le tri lui donnerait.
 */

import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { domainsOf } from '../vault-config.mjs';

const FRONTMATTER = /^---\n([\s\S]*?)\n---\n?/;
const PLAUD_ID = /^plaud_id:\s*["']?(\S+?)["']?\s*$/m;

export const normalize = (text) => text.replace(/\r\n/g, '\n').replace(FRONTMATTER, '').trim();
export const sha = (text) => createHash('sha256').update(normalize(text)).digest('hex');

export const plaudIdOf = (text) => text.replace(/\r\n/g, '\n').match(FRONTMATTER)?.[1].match(PLAUD_ID)?.[1] ?? null;
export const withPlaudId = (markdown, id) => `---\nplaud_id: ${id}\n---\n\n${markdown}`;

// Coffre sans configuration lisible (anterieur au plan core/data, ou test) : les deux domaines d'origine.
const LEGACY_DOMAINS = ['pro', 'perso'];
const domainsOrLegacy = (vault) => {
  try {
    return domainsOf(vault);
  } catch {
    return LEGACY_DOMAINS;
  }
};

/** Les dossiers ou une note peut deja se trouver : [chemin relatif au coffre, recursif ?]. Un raw/<D> par domaine declare. */
const places = (vault) => [
  ['inbox', false],
  [path.join('inbox', 'a-trancher'), false],
  ...domainsOrLegacy(vault).map((d) => [path.join('raw', d), true]),
];

const mdFiles = (dir, recursive) => {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const abs = path.join(dir, e.name);
    if (e.isDirectory()) return recursive ? mdFiles(abs, true) : [];
    return e.name.endsWith('.md') && !e.name.startsWith('_') ? [abs] : [];
  });
};

const posix = (p) => p.split(path.sep).join('/');

/** Photo de ce que le coffre contient deja : id, nom, empreinte -> dossier (`raw/pro`, `inbox`...). */
export const scanKnown = (vault) => {
  const ids = new Map();
  const names = new Map();
  const hashes = new Map();
  for (const [rel, recursive] of places(vault)) {
    const place = posix(rel);
    for (const file of mdFiles(path.join(vault, rel), recursive)) {
      const text = readFileSync(file, 'utf8');
      const id = plaudIdOf(text);
      if (id && !ids.has(id)) ids.set(id, place);
      const name = path.basename(file);
      if (!names.has(name)) names.set(name, place);
      const h = sha(text);
      if (!hashes.has(h)) hashes.set(h, place);
    }
  }
  return { ids, names, hashes };
};

// --- Registre : {id, domaine | "ecarte", date}, sans titre ni contenu. Versionne. ---

export const registryPath = (vault) => path.join(vault, 'tools', 'plaud-sync', 'seen.json');

export const loadRegistry = (vault) => {
  const file = registryPath(vault);
  return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : [];
};

/** Ajoute une entree si l'id n'y est pas deja. Rend true si le registre a change. */
export const addToRegistry = (vault, id, domaine, date = new Date().toISOString().slice(0, 10)) => {
  const entries = loadRegistry(vault);
  if (entries.some((e) => e.id === id)) return false;
  entries.push({ id, domaine, date });
  writeFileSync(registryPath(vault), `${JSON.stringify(entries, null, 1)}\n`);
  return true;
};

/**
 * Classe une note candidate. `markdown` est optionnel : sans lui (avant get_note) seuls l'id et le nom jouent ;
 * avec lui, l'empreinte du contenu est aussi comparee. Rend l'etiquette du rapport, ou null si la note est nouvelle.
 */
export const classify = ({ id, fileName, markdown }, { known, registry }) => {
  const entry = registry.find((e) => e.id === id);
  if (entry) return entry.domaine === 'ecarte' ? 'ecarte:registre' : 'connu:id';
  if (known.ids.has(id)) return 'connu:id';
  if (known.names.has(fileName)) return 'connu:nom';
  if (markdown !== undefined && known.hashes.has(sha(markdown))) return 'connu:contenu';
  return null;
};

/** Pour l'amorcage : dans quel domaine (pro | perso) un brut existant correspond-il a cette note ? null sinon. */
export const legacyDomain = ({ fileName, markdown }, known) => {
  const place = ((markdown === undefined ? undefined : known.hashes.get(sha(markdown))) ?? known.names.get(fileName)) ?? '';
  // Seuls des dossiers raw/<D> de domaines declares sont dans `known` (places) : le segment suffit.
  const m = place.match(/^raw\/([a-z0-9-]+)$/);
  return m ? m[1] : null;
};
