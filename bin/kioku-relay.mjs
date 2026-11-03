#!/usr/bin/env node
/**
 * Le relais `kioku` du PATH (decision 1 du 2026-11-02) : pose une fois par machine par le script d'installation, il
 * ne vise aucun SHA. A chaque appel, il trouve le core et lui passe la commande telle quelle :
 *
 *   1. KIOKU_HOME pose et non vide  -> ce core (developpement sur un clone). Doit contenir tools/kioku.mjs, sinon refus.
 *                                      Note sur stderr : chemin et SHA court.
 *   2. sinon, le plugin             -> kioku@dojo installe sur cette machine (~/.claude/plugins/installed_plugins.json,
 *                                      le plus recent qui s'applique au dossier courant). Sinon refus.
 *   Dans un coffre, le core doit savoir lire son format (kioku.config.json "format") : sinon refus, avec la commande de
 *   mise a jour du plugin.
 *   Aucun repli sur ~/kioku : sans core resolu, c'est un refus, pas un clone pris en silence.
 *
 * Le coffre est le dossier courant : npm lance les scripts depuis la racine du paquet (le coffre).
 * Copie hors du core avec plugin-install.mjs a cote de lui ; dans le core, ce module est sous tools/.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MODULE = [path.join(HERE, 'plugin-install.mjs'), path.join(HERE, '..', 'tools', 'plugin-install.mjs')].find((f) => existsSync(f));
if (!MODULE) {
  process.stderr.write(`kioku : relais incomplet (plugin-install.mjs absent a cote de ${HERE}) : relance le script d'installation.\n`);
  process.exit(1);
}
const { formatRefusal, INSTALL_HINT, installedKioku, KIOKU_ID } = await import(pathToFileURL(MODULE).href);

const ENTRY = path.join('tools', 'kioku.mjs');
const short = (sha) => (sha ? sha.slice(0, 7) : '?');
const gitSha = (dir) => {
  const r = spawnSync('git', ['-C', dir, 'rev-parse', 'HEAD'], { encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim() : null;
};

/** Le core a lancer : { core, notes } ou { error }. Aucune valeur par defaut. */
export const resolveCore = ({ cwd = process.cwd(), env = process.env } = {}) => {
  if (env.KIOKU_HOME) {
    const core = path.resolve(env.KIOKU_HOME);
    if (!existsSync(path.join(core, ENTRY))) return { error: `KIOKU_HOME=${core} ne contient pas ${ENTRY} : corrige ou retire KIOKU_HOME (aucun repli sur le plugin quand il est pose).` };
    const tooOld = formatRefusal(core, cwd);
    if (tooOld) return { error: `KIOKU_HOME=${core} : ${tooOld}` };
    return { core, notes: [`core local KIOKU_HOME=${core}, SHA ${short(gitSha(core))}`] };
  }
  const inst = installedKioku(cwd, { home: env.HOME });
  if (inst.error) return { error: `installation du plugin illisible : ${inst.error}.` };
  if (!inst.found) {
    return { error: `aucun core : le plugin ${KIOKU_ID} n'est pas installe sur cette machine. Lance : ${INSTALL_HINT} (ou pose KIOKU_HOME vers un clone du core).` };
  }
  if (!existsSync(path.join(inst.path, ENTRY))) return { error: `plugin installe sans ${ENTRY} (${inst.path}) : reinstalle-le.` };
  const tooOld = formatRefusal(inst.path, cwd);
  if (tooOld) return { error: tooOld };
  return { core: inst.path, notes: [] };
};

// Lance par un lien symbolique (~/.local/bin/kioku) : argv[1] est le lien, import.meta.url le fichier reel. Comparer
// les chemins reels, sinon le relais sortirait en code 0 sans rien faire.
const realOr = (p) => {
  try {
    return realpathSync(p);
  } catch {
    return path.resolve(p);
  }
};
const isDirect = Boolean(process.argv[1]) && realOr(process.argv[1]) === realOr(fileURLToPath(import.meta.url));
if (isDirect) {
  const r = resolveCore();
  if (r.error) {
    process.stderr.write(`kioku : ${r.error}\n`);
    process.exit(1);
  }
  for (const n of r.notes) process.stderr.write(`kioku : ${n}\n`);
  const child = spawnSync(process.execPath, [path.join(r.core, ENTRY), ...process.argv.slice(2)], { stdio: 'inherit' });
  process.exit(child.status ?? 1);
}
