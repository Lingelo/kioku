/**
 * Verrou du circuit Plaud : c'est le verrou commun du coffre, defini dans tools/connectors/lock.mjs (un seul lanceur a
 * la fois, tous circuits de capture et commandes de reecriture confondus). Ce module reste pour les importeurs
 * existants.
 *
 * `lockDir` / `lockPath` designent ici l'ANCIEN fichier, `tools/plaud-sync/.lock.json`, toujours tenu en miroir du
 * verrou canonique `tools/connectors/.lock.json` pendant la transition (voir l'en-tete de connectors/lock.mjs).
 */

export { acquire, isAlive, release, legacyLockDir as lockDir, legacyLockPath as lockPath } from '../connectors/lock.mjs';
