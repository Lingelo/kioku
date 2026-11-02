/**
 * Le PATH d'une session du coffre (plan core/data, U11) : `bin/` du core en tete, pour que `kioku` (gate et CLI) s'y
 * appelle par son nom, comme le fera le plugin (il ajoute son bin/ au PATH des sessions).
 *
 *   withCorePath(env) -> un nouvel environnement dont PATH commence par le bin/ du core
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const CORE_BIN = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin');

export const withCorePath = (env = process.env) => {
  const current = env.PATH ?? '';
  const parts = current.split(path.delimiter).filter((p) => p && p !== CORE_BIN);
  return { ...env, PATH: [CORE_BIN, ...parts].join(path.delimiter) };
};
