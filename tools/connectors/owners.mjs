/**
 * A quel connecteur appartient une source de l'entrant (revue I2).
 *
 * Chaque connecteur marque ses depots d'un champ de frontmatter qui lui est propre (Plaud : `plaud_id:`). Un circuit
 * ne trie, ne parque et ne met en file que ses propres sources : le tri d'un autre circuit n'a ni sa consigne
 * (`triageNote` : donnee non fiable, indices) ni sa file. Le reste reste dans l'entrant, signale au rapport, pour le
 * circuit qui le possede.
 *
 * Une source sans marque (deposee a la main, ou anterieure aux marques) reste au circuit par defaut, Plaud, comme
 * avant l'existence du socle : `kioku plaud --skip-fetch` triait tout l'entrant.
 */

import { readFileSync } from 'node:fs';

/** Les marques connues : identifiant du connecteur -> champ de frontmatter. */
export const MARKERS = { plaud: 'plaud_id' };
export const DEFAULT_OWNER = 'plaud';

const head = (text) => String(text ?? '').replace(/\r\n/g, '\n').match(/^---\n([\s\S]*?)\n---/)?.[1] ?? '';

/** Le connecteur dont la marque est dans le frontmatter, ou null. */
export const markerOf = (text) => {
  const h = head(text);
  for (const [id, key] of Object.entries(MARKERS)) if (new RegExp(`^${key}:\\s*\\S`, 'm').test(h)) return id;
  return null;
};

/** Le connecteur `id` possede-t-il cette source ? */
export const owns = (id, text) => (markerOf(text) ?? DEFAULT_OWNER) === id;

/** Meme question sur un fichier ; illisible : non (on ne trie pas ce qu'on ne sait pas lire). */
export const ownsFile = (id, file) => {
  try {
    return owns(id, readFileSync(file, 'utf8'));
  } catch {
    return false;
  }
};
