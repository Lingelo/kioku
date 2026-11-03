/**
 * Configuration de coffre factice pour les tests de tools/ (plan core/data, U5).
 *
 *   writeTestConfig(vault)                     -> les deux domaines d'aujourd'hui, registre a l'emplacement historique
 *   writeTestConfig(vault, { domains: [...] }) -> une autre liste (tests a trois domaines)
 *
 * Le registre declare pour pro est l'emplacement historique (.claude/hooks/orgs.json) : les tests qui posent un
 * registre l'y ecrivent deja. La configuration ne cree pas le registre : un test sans organisations n'en a pas besoin.
 */

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Les hooks du moteur teste : hooks/ dans le core (plugin). */
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const HOOKS_DIR = existsSync(path.join(ROOT, 'hooks', 'guard.mjs')) ? path.join(ROOT, 'hooks') : path.join(ROOT, '.claude', 'hooks');

export const TEST_CONFIG = {
  version: 1,
  domains: [{ id: 'pro', extensions: { org: { registry: ['.claude', 'hooks', 'orgs.json'].join('/') } } }, { id: 'perso' }],
};

export const writeTestConfig = (vault, config = TEST_CONFIG) => {
  mkdirSync(vault, { recursive: true });
  writeFileSync(path.join(vault, 'kioku.config.json'), JSON.stringify(config));
};

/** Garde factice declaree : un hook PreToolUse du projet vers un script present (lu par registeredGuard). */
export const declareFakeGuard = (vault) => {
  const dir = path.join(vault, '.claude');
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'guard.mjs'), '// garde factice\n');
  const command = `node "${path.join(dir, 'guard.mjs')}"`;
  writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ hooks: { PreToolUse: [{ matcher: 'Write|Edit|Read|Grep|Glob|Bash', hooks: [{ type: 'command', command }] }] } }));
};

/**
 * HOME factice pour un test qui appelle le demarrage (startupRefusal) dans son propre processus : sinon il lit les
 * settings de la machine (~/.claude/settings.json), et un plugin kioku active par l'utilisateur ajoute une seconde
 * garde au hook factice du test (« double garde »). Rend la fonction qui restaure HOME.
 */
/** Meme raison, pour un processus enfant : un HOME vierge sous `dir`, a passer dans son environnement. */
export const testHome = (dir) => {
  const home = path.join(dir, '.home-test');
  mkdirSync(home, { recursive: true });
  return home;
};

export const isolateHome = (dir) => {
  const previous = process.env.HOME;
  const home = path.join(dir, '.home-test');
  mkdirSync(home, { recursive: true });
  process.env.HOME = home;
  return () => {
    if (previous === undefined) delete process.env.HOME;
    else process.env.HOME = previous;
  };
};
