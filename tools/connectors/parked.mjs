/**
 * Les sources parquees d'un circuit de capture : `inbox/a-trancher/`, et leurs raisons dans `_raisons.md`.
 *
 * Le tri s'abstient au moindre doute : la source ne va dans aucun domaine, elle attend l'utilisateur ici (local, jamais
 * versionne, comme inbox/). Ce dossier est commun a tous les connecteurs : une source parquee ne dit pas d'ou elle vient,
 * c'est son identifiant en frontmatter (`plaud_id:`, …) qui le dit, et c'est le connecteur qui sait le lire.
 *
 * Ecarter pour de bon (`dropParkedWith`) : supprimer le fichier ne suffit pas, la deduplication du connecteur ne
 * reconnait une source que par son registre ou par un fichier present. Sans trace, le fetch suivant la redepose. On
 * consigne donc son identifiant comme « ecarte » dans le registre du connecteur, puis on supprime le fichier et sa
 * ligne de _raisons.md.
 *
 * Ordre : registre d'abord, fichier ensuite. Un arret entre les deux laisse un fichier deja consigne, qu'une relance
 * supprime ; l'ordre inverse laisserait une source supprimee mais non consignee, donc redeposee.
 * Sans identifiant (depot anterieur au registre), on refuse et on ne touche a rien : la source reviendrait.
 * Ce module lit un identifiant, jamais un contenu a afficher.
 */

import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export const inboxDir = (vault) => path.join(vault, 'inbox');
export const parkedDir = (vault) => path.join(inboxDir(vault), 'a-trancher');
export const reasonsPath = (vault) => path.join(parkedDir(vault), '_raisons.md');

/** Les sources .md d'un dossier (pas les fichiers `_…` comme _raisons.md) ; dossier absent : aucune. */
export const mdIn = (dir) => (existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.md') && !f.startsWith('_')) : []);

/** Consigne la raison d'un parcage : `- <fichier> (<date>) : <raison>`. */
export const logReason = (vault, file, reason, today = new Date().toISOString().slice(0, 10)) => {
  mkdirSync(parkedDir(vault), { recursive: true });
  appendFileSync(reasonsPath(vault), `- ${file} (${today}) : ${reason}\n`);
};

/** Parque une source de l'entrant (parquer ne classe rien) et consigne pourquoi. */
export const park = (vault, file, reason) => {
  mkdirSync(parkedDir(vault), { recursive: true });
  renameSync(path.join(inboxDir(vault), file), path.join(parkedDir(vault), file));
  logReason(vault, file, reason);
};

/**
 * Les lignes `VIDE <fichier> : <raison>` de la sortie du tri -> Map(fichier -> raison), dans l'ordre de la sortie.
 * Seuls les fichiers de `parkedFiles` (noms de inbox/a-trancher/, deja filtres par l'appelant) sont retenus : un nom
 * invente par la session, un fichier range dans un domaine ou reste dans l'entrant n'est jamais propose a l'ecart.
 * La session peut ecrire le chemin de son `mv` (a-trancher/x.md, inbox/a-trancher/x.md) : seul le nom compte.
 * (Venu de main, PR 11, pour le circuit Plaud ; commun aux connecteurs.)
 */
export const parseEmptyLines = (out, parkedFiles) => {
  const parked = new Set(parkedFiles);
  const empties = new Map();
  for (const m of String(out ?? '').matchAll(/^VIDE\s+(\S+)\s*:\s*(.+)$/gm)) {
    const file = path.basename(m[1].replace(/\\/g, '/'));
    if (parked.has(file) && !empties.has(file)) empties.set(file, m[2].trim());
  }
  return empties;
};

/**
 * Retire de _raisons.md les lignes `- <fichier> (date) : …` dont le fichier n'est plus parque (tranche par --decide,
 * ou deplace a la main). Les autres lignes restent. Rend le nombre de lignes retirees.
 */
export const pruneReasons = (vault) => {
  const reasons = reasonsPath(vault);
  if (!existsSync(reasons)) return 0;
  const lines = readFileSync(reasons, 'utf8').split('\n');
  const kept = lines.filter((l) => {
    const file = l.match(/^- (\S+\.md) \(/)?.[1];
    return !file || existsSync(path.join(parkedDir(vault), file));
  });
  if (kept.length !== lines.length) writeFileSync(reasons, kept.join('\n'));
  return lines.length - kept.length;
};

/**
 * Ecarte une source parquee. Le connecteur fournit :
 *   idOf(text)      -> son identifiant lu dans le frontmatter, ou null
 *   register(id)    -> le consigne « ecarte » dans son registre ; rend true si le registre a change
 *   noId            -> la raison du refus quand l'identifiant manque (elle nomme le champ attendu)
 * Rend { ok: true, id, registered } ou { ok: false, reason }.
 */
export const dropParkedWith = (vault, file, { idOf, register, noId }) => {
  // Un nom de fichier, pas un chemin : rien ne sort de inbox/a-trancher/.
  if (!file || file !== path.basename(file) || !file.endsWith('.md') || file.startsWith('_')) {
    return { ok: false, reason: `nom invalide (attendu : un fichier .md de inbox/a-trancher/, sans chemin)` };
  }
  const abs = path.join(parkedDir(vault), file);
  if (!existsSync(abs)) return { ok: false, reason: 'absent de inbox/a-trancher/' };
  const id = idOf(readFileSync(abs, 'utf8'));
  if (!id) return { ok: false, reason: noId };

  const registered = register(id);
  rmSync(abs);
  const reasons = reasonsPath(vault);
  if (existsSync(reasons)) {
    const lines = readFileSync(reasons, 'utf8').split('\n');
    const kept = lines.filter((l) => !l.startsWith(`- ${file} (`));
    if (kept.length !== lines.length) writeFileSync(reasons, kept.join('\n'));
  }
  return { ok: true, id, registered };
};
