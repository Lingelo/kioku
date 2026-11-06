/**
 * OAuth 2.0 « installed app » pour Gmail, sans dependance : PKCE (S256) et boucle locale sur 127.0.0.1.
 *
 * Connexion (une fois par compte, depuis un terminal : `npm run mail:login -- <compte>`) :
 *   1. un serveur `node:http` ecoute sur 127.0.0.1, port choisi par le systeme ;
 *   2. l'URL d'autorisation porte `state` (aleatoire) et `code_challenge` = SHA-256(code_verifier) ;
 *   3. le navigateur revient sur la boucle avec `code` et `state` ; un `state` different est refuse (400), on continue
 *      d'attendre le bon jusqu'au delai ; une `error` (refus de l'utilisateur) arrete tout ;
 *   4. le code est echange contre les jetons avec le `code_verifier` : sans lui, Google refuse (PKCE).
 * Scope unique : gmail.readonly. Aucune ecriture possible dans la boite.
 *
 * Jeton : `<config>/kioku/mail/<compte>.json` (paths.mjs), ecrit en 0600 par fichier temporaire puis renommage,
 * dossier en 0700. Sous Windows, les modes POSIX n'ont pas d'effet : le fichier herite des droits du profil
 * utilisateur (%APPDATA%), c'est la protection disponible. Le jeton n'est jamais affiche ni journalise ; il n'est
 * jamais passe a une session claude, et la garde ferme ce dossier a toute session, en lecture comme en ecriture
 * (zone secrete de hooks/guard.mjs, revue B1).
 *
 * Rafraichissement : accessToken() rend un jeton valide, rafraichi s'il expire dans la minute. Un rafraichissement
 * refuse (`invalid_grant` : jeton revoque, mot de passe change, appli non verifiee expiree au bout de 7 jours en mode
 * test) donne un message qui dit quoi faire : relancer `mail:login`.
 */

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import path from 'node:path';

import { HttpError, requestJson } from './http.mjs';
import { clientPath, configDir, tokenPath } from './paths.mjs';

export const SCOPE = 'https://www.googleapis.com/auth/gmail.readonly';
export const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
export const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const LOGIN_TIMEOUT_MS = 5 * 60_000;
const EARLY_REFRESH_MS = 60_000;

const b64url = (buf) => buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

/** PKCE : un verificateur (43 a 128 caracteres non reserves) et son defi S256. */
export const pkce = (bytes = randomBytes(32)) => {
  const verifier = b64url(bytes);
  return { verifier, challenge: b64url(createHash('sha256').update(verifier).digest()) };
};

/** Le client OAuth de l'utilisateur. Absent ou incomplet : une erreur qui dit ou le poser. */
export const loadClient = (dir = configDir()) => {
  const file = clientPath(dir);
  if (!existsSync(file)) throw new Error(`client OAuth absent : ${file}. Cree un client « Desktop » dans ta console Google Cloud, telecharge son JSON et pose-le a cet emplacement (voir le guide, Capture modules).`);
  let data;
  try {
    data = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    throw new Error(`client OAuth illisible : ${file} (JSON attendu)`);
  }
  const c = data.installed ?? data;
  if (!c?.client_id || !c?.client_secret) throw new Error(`client OAuth incomplet : ${file} (client_id et client_secret attendus)`);
  return { clientId: c.client_id, clientSecret: c.client_secret };
};

/** L'URL d'autorisation. */
export const authUrl = ({ clientId, redirectUri, state, challenge }) => {
  const q = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: SCOPE,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state,
    access_type: 'offline',
    prompt: 'consent',
  });
  return `${AUTH_URL}?${q}`;
};

const sameState = (a, b) => {
  const x = Buffer.from(String(a ?? ''));
  const y = Buffer.from(String(b ?? ''));
  return x.length === y.length && timingSafeEqual(x, y);
};

/**
 * Attend le retour du navigateur sur la boucle locale. Rend { code, redirectUri } ou leve.
 * `onListening(redirectUri)` est appele une fois le port connu (pour construire l'URL d'autorisation).
 */
export const waitForCode = ({ state, onListening, timeoutMs = LOGIN_TIMEOUT_MS, host = '127.0.0.1' }) =>
  new Promise((resolve, reject) => {
    let redirectUri = '';
    const server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', `http://${host}`);
      const reply = (status, text) => {
        res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
        res.end(text);
      };
      if (url.pathname !== '/') return reply(404, 'introuvable');
      if (!sameState(url.searchParams.get('state'), state)) return reply(400, 'Requete refusee : state invalide.');
      const error = url.searchParams.get('error');
      if (error) {
        reply(400, 'Connexion refusee. Tu peux fermer cet onglet.');
        return finish(new Error(`connexion refusee par Google (${error})`));
      }
      const code = url.searchParams.get('code');
      if (!code) return reply(400, 'Requete refusee : code absent.');
      reply(200, 'Connexion Kioku terminee. Tu peux fermer cet onglet.');
      finish(null, { code, redirectUri });
    });
    let timer;
    const finish = (error, value) => {
      clearTimeout(timer);
      server.close();
      server.closeAllConnections?.();
      if (error) reject(error);
      else resolve(value);
    };
    server.on('error', (error) => finish(error));
    server.listen(0, host, () => {
      redirectUri = `http://${host}:${server.address().port}`;
      timer = setTimeout(() => finish(new Error(`connexion non terminee en ${Math.round(timeoutMs / 1000)} s : relance mail:login`)), timeoutMs);
      try {
        onListening?.(redirectUri);
      } catch (error) {
        finish(error);
      }
    });
  });

/** Ecrit un jeton : dossier 0700, fichier temporaire 0600, renommage (jamais de fichier a moitie ecrit). */
export const saveToken = (account, token, dir = configDir()) => {
  const file = tokenPath(account, dir);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  // mkdir ne resserre pas un dossier qui existait deja (en 0755, par exemple) : on le fait (revue m8). Sans effet sous
  // Windows, ou les modes POSIX ne s'appliquent pas.
  if (process.platform !== 'win32') chmodSync(dir, 0o700);
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    writeFileSync(tmp, `${JSON.stringify(token, null, 1)}\n`, { mode: 0o600 });
    chmodSync(tmp, 0o600); // umask : le mode de creation peut avoir ete restreint autrement
    renameSync(tmp, file);
  } catch (error) {
    rmSync(tmp, { force: true });
    throw error;
  }
  return file;
};

export const loadToken = (account, dir = configDir()) => {
  const file = tokenPath(account, dir);
  if (!existsSync(file)) throw new Error(`pas de jeton pour le compte ${account} : lance une fois \`npm run mail:login -- ${account}\` depuis un terminal`);
  try {
    const t = JSON.parse(readFileSync(file, 'utf8'));
    if (!t?.refresh_token) throw new Error('refresh_token absent');
    return t;
  } catch {
    throw new Error(`jeton illisible pour le compte ${account} (${path.basename(file)}) : relance \`npm run mail:login -- ${account}\``);
  }
};

const tokenRequest = (params, deps, what) =>
  requestJson(TOKEN_URL, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(params).toString() }, { ...deps, what });

const fromResponse = (r, now, previous = {}) => ({
  access_token: r.access_token,
  refresh_token: r.refresh_token ?? previous.refresh_token,
  expires_at: now() + Number(r.expires_in ?? 3600) * 1000,
  scope: r.scope ?? previous.scope ?? SCOPE,
  token_type: r.token_type ?? 'Bearer',
});

/**
 * Connexion complete d'un compte. `openUrl(url)` ouvre le navigateur (injecte ; par defaut, l'URL est affichee).
 * Rend le chemin du jeton ecrit, jamais le jeton.
 */
export const login = async (account, { dir = configDir(), fetch, sleep, now = Date.now, openUrl, timeoutMs, verifierBytes } = {}) => {
  tokenPath(account, dir); // valide l'identifiant avant d'ouvrir quoi que ce soit
  const client = loadClient(dir);
  const state = b64url(randomBytes(24));
  const { verifier, challenge } = pkce(verifierBytes);
  const { code, redirectUri } = await waitForCode({
    state,
    timeoutMs,
    onListening: (redirect) => (openUrl ?? ((u) => console.log(`Ouvre cette adresse dans ton navigateur :\n  ${u}`)))(authUrl({ clientId: client.clientId, redirectUri: redirect, state, challenge })),
  });
  const r = await tokenRequest(
    { code, client_id: client.clientId, client_secret: client.clientSecret, redirect_uri: redirectUri, grant_type: 'authorization_code', code_verifier: verifier },
    { fetch, sleep },
    'oauth echange du code',
  );
  if (!r.refresh_token) throw new Error('Google n\'a pas rendu de refresh_token : retire l\'acces de Kioku dans ton compte Google, puis relance mail:login');
  return saveToken(account, fromResponse(r, now), dir);
};

/**
 * Un jeton d'acces valide pour le compte, rafraichi au besoin (et reecrit). `force` : rafraichir meme s'il semble
 * valide (une 401 de l'API : jeton revoque cote serveur).
 */
export const accessToken = async (account, { dir = configDir(), fetch, sleep, now = Date.now, force = false } = {}) => {
  const token = loadToken(account, dir);
  if (!force && token.access_token && Number(token.expires_at) - EARLY_REFRESH_MS > now()) return token.access_token;
  const client = loadClient(dir);
  let r;
  try {
    r = await tokenRequest({ grant_type: 'refresh_token', refresh_token: token.refresh_token, client_id: client.clientId, client_secret: client.clientSecret }, { fetch, sleep }, 'oauth rafraichissement');
  } catch (error) {
    if (error instanceof HttpError && (error.code === 'invalid_grant' || error.status === 400 || error.status === 401)) {
      throw new Error(`rafraichissement du jeton refuse pour le compte ${account} (${error.code || `HTTP ${error.status}`}) : relance \`npm run mail:login -- ${account}\``);
    }
    throw error;
  }
  const next = fromResponse(r, now, token);
  saveToken(account, next, dir);
  return next.access_token;
};
