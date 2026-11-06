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

import path from 'node:path';

import { addToRegistryAt, loadRegistryAt, frontmatterValue, normalize, scanKnown as scanKnownBy, sha, withFrontmatterId } from '../connectors/dedup.mjs';

// Les primitives (empreinte, dossiers parcourus, registre JSON) sont communes aux connecteurs : tools/connectors/dedup.mjs.
// Ici, ce qui est propre a Plaud : l'identifiant `plaud_id:`, le registre seen.json, l'ordre id -> nom -> contenu.
export { normalize, sha };

export const plaudIdOf = (text) => frontmatterValue(text, 'plaud_id');
export const withPlaudId = (markdown, id) => withFrontmatterId(markdown, 'plaud_id', id);

/** Photo de ce que le coffre contient deja : id, nom, empreinte -> dossier (`raw/pro`, `inbox`...). */
export const scanKnown = (vault) => scanKnownBy(vault, plaudIdOf);

// --- Registre : {id, domaine | "ecarte", date}, sans titre ni contenu. Versionne. ---

export const registryPath = (vault) => path.join(vault, 'tools', 'plaud-sync', 'seen.json');

export const loadRegistry = (vault) => loadRegistryAt(registryPath(vault));

/** Ajoute une entree si l'id n'y est pas deja. Rend true si le registre a change. */
export const addToRegistry = (vault, id, domaine, date = new Date().toISOString().slice(0, 10)) =>
  addToRegistryAt(registryPath(vault), { id, domaine, date });

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
