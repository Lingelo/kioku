/**
 * La configuration du coffre vue de tools/ (plan core/data, U5) : un seul point d'entree vers config.mjs, pour que le
 * dashboard, le circuit Plaud et le lanceur lisent la meme liste de domaines que la garde et la gate.
 *
 *   domainsOf(vault)      -> ['pro', 'perso', ...]   (erreur nommee si la configuration manque ou est invalide)
 *   assertDomain(vault, d) -> d, ou erreur qui liste les domaines declares
 *   orgDomains(vault)     -> domaines a extension org
 *   orgRegistryOf(vault, d) -> chemin absolu du registre, ou null
 *   isVault(vault)        -> un coffre est un dossier qui porte une configuration lisible
 */

import path from 'node:path';
import { existsSync } from 'node:fs';

import { configFile, loadConfig } from '../hooks/config.mjs';

export { configFile, loadConfig };

export const domainsOf = (vault) => loadConfig(vault).domains;

export const assertDomain = (vault, domain) => {
  const cfg = loadConfig(vault);
  if (!cfg.has(domain)) throw new Error(`Domaine inconnu : ${domain} (declares : ${cfg.domains.join(', ')})`);
  return domain;
};

export const orgDomains = (vault) => {
  const cfg = loadConfig(vault);
  return cfg.domains.filter((d) => cfg.orgRegistry(d));
};

export const orgRegistryOf = (vault, domain) => loadConfig(vault).orgRegistry(domain);

export const isVault = (vault) => {
  if (!existsSync(configFile(vault))) return false;
  try {
    loadConfig(vault);
    return true;
  } catch {
    return false;
  }
};

/**
 * Le coffre vise par un outil du core : --vault (passe par l'appelant), sinon CLAUDE_PROJECT_DIR, sinon le dossier
 * courant. Jamais l'emplacement du script : le core est installe a part (plugin, clone ~/kioku), un repli sur lui
 * ouvrirait une session sur le moteur au lieu du coffre.
 */
export const vaultRoot = (explicit, env = process.env) => path.resolve(explicit ?? env.CLAUDE_PROJECT_DIR ?? process.cwd());
