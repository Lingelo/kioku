/**
 * Ecarter pour de bon une source Plaud parquee dans inbox/a-trancher/ : `run.mjs --drop <fichier>`.
 *
 * La mecanique est commune aux connecteurs (tools/connectors/parked.mjs : registre d'abord, fichier ensuite, refus sans
 * identifiant). Ce qui est propre a Plaud : l'identifiant est le `plaud_id:` du frontmatter, et le registre est
 * seen.json (dedup.mjs), comme `--skip` mais sans avoir a connaitre l'id.
 */

import { dropParkedWith, parkedDir, parseEmptyLines, pruneReasons } from '../connectors/parked.mjs';
import { addToRegistry, plaudIdOf } from './dedup.mjs';

export { parkedDir, parseEmptyLines, pruneReasons };

/** Rend { ok: true, id, registered } ou { ok: false, reason }. */
export const dropParked = (vault, file) =>
  dropParkedWith(vault, file, {
    idOf: plaudIdOf,
    register: (id) => addToRegistry(vault, id, 'ecarte'),
    noId: 'pas de plaud_id: en frontmatter, il reviendrait au prochain fetch ; laisse en place',
  });
