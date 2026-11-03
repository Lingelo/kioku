/**
 * Le plugin kioku installe sur cette machine, et la compatibilite de format entre ce core et un coffre.
 *
 * Le plugin vient de la marketplace dojo (kioku@dojo), installe au niveau utilisateur et mis a jour par Claude Code : le
 * coffre ne porte aucune version. La compatibilite tient a un numero de format (hooks/format.json du core, cle
 * `format` de kioku.config.json) : le core lit les coffres de son format ou plus anciens.
 *
 * Autonome (seulement des modules node:) : le relais `kioku` du PATH (bin/kioku-relay.mjs) l'importe depuis une copie
 * posee hors du core par le script d'installation. Ne pas y ajouter d'import du core.
 *
 *   installedKioku(vault, { home })  -> { found, sha, path, id } | { found: false } | { error }
 *   coreFormat(coreDir)              -> entier, ou null si illisible
 *   vaultFormat(vault)               -> entier (1 si la configuration ne le declare pas), ou null si illisible
 *   formatRefusal(coreDir, vault)    -> null, ou la raison d'un refus (core trop ancien pour ce coffre)
 * installed_plugins.json est un format interne de Claude Code, non documente : s'il change, echec ferme.
 */

import { existsSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';

export const MARKETPLACE = 'dojo';
export const KIOKU_ID = `kioku@${MARKETPLACE}`;
// Le depot de la marketplace n'est pas ecrit dans le core : l'utilisateur le connait (README, page de la marketplace).
export const INSTALL_HINT = `claude plugin marketplace add <owner>/${MARKETPLACE} && claude plugin install ${KIOKU_ID} --scope user`;

const real = (p) => {
  try {
    return realpathSync(p);
  } catch {
    return path.resolve(p);
  }
};

/** L'installation de kioku@dojo qui s'applique a ce dossier (la plus recente) : { found, sha, path, id } ou { error }. */
export const installedKioku = (vault, { home = process.env.HOME } = {}) => {
  const file = path.join(home ?? '', '.claude', 'plugins', 'installed_plugins.json');
  if (!existsSync(file)) return { found: false }; // machine neuve : aucun plugin installe
  let data;
  try {
    data = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return { error: `${file} illisible` };
  }
  if (!data || typeof data.plugins !== 'object' || data.plugins === null) return { error: `${file} : format inconnu (lance kioku doctor --live)` };
  const installs = data.plugins[KIOKU_ID];
  if (installs === undefined) return { found: false };
  if (!Array.isArray(installs)) return { error: `${file} : format inconnu pour ${KIOKU_ID}` };
  const here = real(vault);
  const usable = installs
    .filter((i) => i && (i.scope === 'user' || (i.projectPath && real(i.projectPath) === here)))
    .filter((i) => i.installPath && existsSync(path.join(i.installPath, 'hooks', 'guard.mjs')))
    .sort((a, b) => String(b.lastUpdated ?? '').localeCompare(String(a.lastUpdated ?? '')));
  if (!usable.length) return { found: false };
  return { found: true, sha: usable[0].gitCommitSha ?? null, path: usable[0].installPath, id: KIOKU_ID };
};

const readInt = (file, key) => {
  try {
    const v = JSON.parse(readFileSync(file, 'utf8'))[key];
    return Number.isInteger(v) && v >= 1 ? v : null;
  } catch {
    return null;
  }
};

/** Le format de coffre que ce core sait lire. Un core anterieur au numero de format lit le format 1. */
export const coreFormat = (coreDir) => {
  const file = path.join(coreDir, 'hooks', 'format.json');
  return existsSync(file) ? readInt(file, 'vault') : 1;
};

/** Le format qu'exige ce coffre : `format` de kioku.config.json, 1 s'il ne le declare pas. */
export const vaultFormat = (vault) => {
  const file = path.join(vault, 'kioku.config.json');
  if (!existsSync(file)) return null;
  try {
    const v = JSON.parse(readFileSync(file, 'utf8')).format;
    if (v === undefined) return 1;
    return Number.isInteger(v) && v >= 1 ? v : null;
  } catch {
    return null;
  }
};

/** Refus si le core ne sait pas lire ce coffre ; null sinon (et hors coffre : rien a comparer). */
export const formatRefusal = (coreDir, vault) => {
  if (!existsSync(path.join(vault, 'kioku.config.json'))) return null;
  const core = coreFormat(coreDir);
  const want = vaultFormat(vault);
  if (core === null) return `format du core illisible (${path.join(coreDir, 'hooks', 'format.json')}) : reinstalle le plugin`;
  if (want === null) return 'kioku.config.json : "format" doit etre un entier >= 1 (ou absent)';
  if (want > core) return `ce coffre exige le format ${want}, le core installe ne lit que le format ${core} : mets le plugin a jour (claude plugin update ${KIOKU_ID}), puis kioku doctor`;
  return null;
};
