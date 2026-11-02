/**
 * Ecarter pour de bon une source parquee dans inbox/a-trancher/ : `run.mjs --drop <fichier>`.
 *
 * Supprimer le fichier ne suffit pas : la deduplication (dedup.mjs) ne reconnait une note que par seen.json ou par un
 * fichier present. Sans trace, le fetch suivant la redepose. On consigne donc son `plaud_id:` comme « ecarte » dans
 * seen.json (comme `--skip`, mais sans avoir a connaitre l'id), puis on supprime le fichier et sa ligne de _raisons.md.
 *
 * Ordre : registre d'abord, fichier ensuite. Un arret entre les deux laisse un fichier deja consigne, qu'une relance
 * supprime ; l'ordre inverse laisserait une note supprimee mais non consignee, donc redeposee.
 * Sans `plaud_id:` (depot anterieur au registre), on refuse et on ne touche a rien : la note reviendrait.
 * Ce module lit un id, jamais un contenu a afficher.
 */

import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { addToRegistry, plaudIdOf } from './dedup.mjs';

export const parkedDir = (vault) => path.join(vault, 'inbox', 'a-trancher');

/**
 * Retire de _raisons.md les lignes `- <fichier> (date) : …` dont le fichier n'est plus parque (tranche par --decide,
 * ou deplace a la main). Les autres lignes restent. Rend le nombre de lignes retirees.
 */
export const pruneReasons = (vault) => {
  const reasons = path.join(parkedDir(vault), '_raisons.md');
  if (!existsSync(reasons)) return 0;
  const lines = readFileSync(reasons, 'utf8').split('\n');
  const kept = lines.filter((l) => {
    const file = l.match(/^- (\S+\.md) \(/)?.[1];
    return !file || existsSync(path.join(parkedDir(vault), file));
  });
  if (kept.length !== lines.length) writeFileSync(reasons, kept.join('\n'));
  return lines.length - kept.length;
};

/** Rend { ok: true, id, registered } ou { ok: false, reason }. */
export const dropParked = (vault, file) => {
  // Un nom de fichier, pas un chemin : rien ne sort de inbox/a-trancher/.
  if (!file || file !== path.basename(file) || !file.endsWith('.md') || file.startsWith('_')) {
    return { ok: false, reason: `nom invalide (attendu : un fichier .md de inbox/a-trancher/, sans chemin)` };
  }
  const abs = path.join(parkedDir(vault), file);
  if (!existsSync(abs)) return { ok: false, reason: 'absent de inbox/a-trancher/' };
  const id = plaudIdOf(readFileSync(abs, 'utf8'));
  if (!id) return { ok: false, reason: 'pas de plaud_id: en frontmatter, il reviendrait au prochain fetch ; laisse en place' };

  const registered = addToRegistry(vault, id, 'ecarte');
  rmSync(abs);
  const reasons = path.join(parkedDir(vault), '_raisons.md');
  if (existsSync(reasons)) {
    const lines = readFileSync(reasons, 'utf8').split('\n');
    const kept = lines.filter((l) => !l.startsWith(`- ${file} (`));
    if (kept.length !== lines.length) writeFileSync(reasons, kept.join('\n'));
  }
  return { ok: true, id, registered };
};
