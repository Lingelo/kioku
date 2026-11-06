/**
 * Ou vivent le client OAuth et les jetons : HORS du coffre, dans le dossier de configuration de l'utilisateur.
 *
 *   macOS, Linux : $XDG_CONFIG_HOME/kioku/mail, sinon ~/.config/kioku/mail
 *   Windows      : %APPDATA%\kioku\mail
 *
 *   client.json    le client OAuth « Desktop » cree par l'utilisateur dans sa console Google Cloud (tel que telecharge :
 *                  { "installed": { "client_id", "client_secret", … } }, ou { "client_id", "client_secret" })
 *   <compte>.json  le jeton d'un compte (access_token, refresh_token, expires_at), mode 0600
 *
 * Jamais dans le coffre : un coffre se versionne et se synchronise, un jeton donne la lecture de toute la boite.
 */

import os from 'node:os';
import path from 'node:path';

export const ACCOUNT_ID = /^[a-z0-9]+(-[a-z0-9]+)*$/;

export const configDir = (env = process.env, platform = process.platform, home = os.homedir()) => {
  if (platform === 'win32') return path.join(env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'kioku', 'mail');
  return path.join(env.XDG_CONFIG_HOME || path.join(home, '.config'), 'kioku', 'mail');
};

export const clientPath = (dir = configDir()) => path.join(dir, 'client.json');

/** Le fichier de jeton d'un compte. L'identifiant est valide ici aussi : il devient un nom de fichier. */
export const tokenPath = (account, dir = configDir()) => {
  if (!ACCOUNT_ID.test(account ?? '')) throw new Error(`compte mail invalide : "${account ?? ''}" (kebab-case ASCII attendu)`);
  return path.join(dir, `${account}.json`);
};
