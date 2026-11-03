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

import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { registeredGuard } from './kioku.mjs';
import { formatRefusal, INSTALL_HINT, installedKioku, KIOKU_ID } from './plugin-install.mjs';

export { installedKioku };

const CORE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const startupRefusal = (vault, { home, core = CORE } = {}) => {
  const g = registeredGuard(vault, { home });
  if (!g.guard) return `garde absente : ${g.why}. Corrige, puis kioku doctor --live.`;
  if (g.double) return 'double garde (hook du projet ET plugin kioku) : retire le hook du projet.';
  // Le core qui ouvre la session sait-il lire ce coffre ? (format exige par le coffre, format lu par le core)
  const tooOld = formatRefusal(core, vault);
  if (tooOld) return tooOld;
  if (g.source !== 'plugin') return null;
  const inst = installedKioku(vault, { home });
  if (inst.error) return `plugin kioku active, installation illisible : ${inst.error}.`;
  if (!inst.found) {
    return `plugin ${KIOKU_ID} active par ce coffre mais pas installe sur cette machine : la session tournerait sans garde. Lance : ${INSTALL_HINT}, puis kioku doctor --live.`;
  }
  const pluginTooOld = formatRefusal(inst.path, vault);
  if (pluginTooOld) return `plugin installe : ${pluginTooOld}`;
  return null;
};
