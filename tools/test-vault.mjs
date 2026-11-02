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
