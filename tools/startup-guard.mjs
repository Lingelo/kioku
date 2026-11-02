/**
 * Avant d'ouvrir une session sur le coffre : la garde est-elle la ? (plan core/data, U12, etape 3)
 *
 *   startupRefusal(vault) -> null si une session peut s'ouvrir, sinon la raison du refus
 *
 * Deux gardes possibles, celles que lit `kioku doctor` (registeredGuard) :
 * - un hook du projet (.claude/settings.json) vers un script present : rien de plus a verifier ;
 * - le plugin kioku active : il faut encore qu'il soit INSTALLE sur cette machine pour ce coffre, sinon Claude Code
 *   ouvre la session sans garde (un plugin active mais absent n'est qu'un avertissement dans /plugin). Une machine qui
 *   recoit le commit de bascule sans avoir installe le plugin doit refuser de demarrer, pas ouvrir le coffre.
 *
 * L'installation se lit dans ~/.claude/plugins/installed_plugins.json, format interne de Claude Code, non documente :
 * s'il change, la lecture echoue et le demarrage est refuse (echec ferme). La preuve forte reste `kioku doctor --live`,
 * a lancer a l'installation et apres chaque montee de version.
 */

import { existsSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';

import { registeredGuard } from './kioku.mjs';

const real = (p) => {
  try {
    return realpathSync(p);
  } catch {
    return path.resolve(p);
  }
};

/** Le SHA epingle pour kioku dans un catalogue inline des settings du coffre, ou null. */
const pinnedSha = (vault) => {
  try {
    const s = JSON.parse(readFileSync(path.join(vault, '.claude', 'settings.json'), 'utf8'));
    for (const [name, m] of Object.entries(s.extraKnownMarketplaces ?? {})) {
      const entry = (m.source?.plugins ?? []).find((p) => p.name === 'kioku');
      if (entry?.source?.sha) return { marketplace: name, sha: entry.source.sha };
    }
  } catch {
    // settings illisibles : registeredGuard l'a deja dit
  }
  return null;
};

/** L'installation de kioku vue par Claude Code pour ce coffre : { found, sha, path } ou { error }. */
export const installedKioku = (vault, { home = process.env.HOME, marketplace } = {}) => {
  const file = path.join(home ?? '', '.claude', 'plugins', 'installed_plugins.json');
  if (!existsSync(file)) return { found: false }; // machine neuve : aucun plugin installe
  let data;
  try {
    data = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return { error: `${file} illisible` };
  }
  if (!data || typeof data.plugins !== 'object') return { error: `${file} : format inconnu (lance kioku doctor --live)` };
  const here = real(vault);
  for (const [id, installs] of Object.entries(data.plugins)) {
    if (!/^kioku@/.test(id) || (marketplace && id !== `kioku@${marketplace}`) || !Array.isArray(installs)) continue;
    for (const i of installs) {
      const applies = i.scope === 'user' || (i.projectPath && real(i.projectPath) === here);
      if (applies && i.installPath && existsSync(path.join(i.installPath, 'hooks', 'guard.mjs'))) return { found: true, sha: i.gitCommitSha ?? null, path: i.installPath, id };
    }
  }
  return { found: false };
};

export const startupRefusal = (vault, { home } = {}) => {
  const g = registeredGuard(vault, { home });
  if (!g.guard) return `garde absente : ${g.why}. Corrige, puis kioku doctor --live.`;
  if (g.double) return 'double garde (hook du projet ET plugin kioku) : retire le hook du projet.';
  if (g.source !== 'plugin') return null;
  const pin = pinnedSha(vault);
  const inst = installedKioku(vault, { home, marketplace: pin?.marketplace });
  if (inst.error) return `plugin kioku active, installation illisible : ${inst.error}.`;
  if (!inst.found) {
    const id = pin ? `kioku@${pin.marketplace}` : 'kioku@<marketplace>';
    return `plugin kioku active mais pas installe sur cette machine pour ce coffre : la session tournerait sans garde. Lance : claude plugin install ${id} --scope project, puis kioku doctor --live.`;
  }
  if (pin && inst.sha && inst.sha !== pin.sha) {
    return `plugin kioku installe en ${inst.sha.slice(0, 7)}, le coffre epingle ${pin.sha.slice(0, 7)} : lance claude plugin update ${inst.id}, puis kioku doctor --live.`;
  }
  return null;
};
