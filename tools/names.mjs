/**
 * Les noms par lesquels les outils appellent les skills et l'agent du core (plan core/data, U11).
 *
 * Installe comme plugin Claude Code, le core prefixe ses composants du nom du plugin : `/kioku:ingest`, agent
 * `kioku:reviewer`. Tant que le coffre porte encore ses propres `.claude/skills` et `.claude/agents` (phases A et B),
 * les noms sont nus. Un seul interrupteur, la variable KIOKU_PLUGIN :
 *   absente       noms nus (/ingest, reviewer)   -- etat actuel du coffre
 *   KIOKU_PLUGIN=kioku   noms prefixes (/kioku:ingest, kioku:reviewer) -- apres la bascule (U12)
 * La bascule fixe la valeur dans le lanceur ; les tests verifient les deux formes.
 */

const PREFIX = (env = process.env) => (env.KIOKU_PLUGIN ? `${env.KIOKU_PLUGIN}:` : '');

/** `/ingest` ou `/kioku:ingest`. */
export const skill = (name, env) => `/${PREFIX(env)}${name}`;

/** `reviewer` ou `kioku:reviewer`, tel que l'agent est nomme pour Claude Code. */
export const agent = (name, env) => `${PREFIX(env)}${name}`;
