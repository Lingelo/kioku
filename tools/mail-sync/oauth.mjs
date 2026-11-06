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
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import path from 'node:path';

import { HttpError, requestJson } from './http.mjs';
import { clientPath, configDir, tokenPath } from './paths.mjs';
import { writeSecretFile } from './secret-store.mjs';

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

const parseClient = (text, where) => {
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`client OAuth illisible : ${where} (JSON attendu)`);
  }
  const c = data.installed ?? data;
  if (!c?.client_id || !c?.client_secret) throw new Error(`client OAuth incomplet : ${where} (client_id et client_secret attendus)`);
  return { clientId: c.client_id, clientSecret: c.client_secret };
};

const atKeychain = (store) => Boolean(store && !store.file);

/**
 * Le client OAuth de l'utilisateur. Absent ou incomplet : une erreur qui dit ou le poser.
 * Avec un trousseau (`store`, voir secret-store.mjs) : lu au trousseau ; a defaut, depuis `client.json`, que
 * `importFile` (kioku mail --login) copie au trousseau. Rend aussi `file` quand client.json existe encore.
 */
export const loadClient = (dir = configDir(), { store, importFile = false, log = console.log } = {}) => {
  const file = clientPath(dir);
  if (atKeychain(store)) {
    const kept = store.get('client');
    if (kept) return { ...parseClient(kept, `trousseau (${store.kind})`), file: existsSync(file) ? file : null };
    if (!existsSync(file)) throw new Error(`client OAuth absent du trousseau, et ${file} absent. Cree un client « Desktop » dans ta console Google Cloud, pose son JSON a cet emplacement, puis lance \`kioku mail --login <compte>\` depuis un terminal : il l'importe au trousseau.`);
    const client = parseClient(readFileSync(file, 'utf8'), file);
    if (importFile) {
      store.set('client', JSON.stringify({ client_id: client.clientId, client_secret: client.clientSecret }));
      log(`Client OAuth importe au trousseau (${store.kind}).`);
    }
    return { ...client, file, fromFile: !importFile };
  }
  if (!existsSync(file)) throw new Error(`client OAuth absent : ${file}. Cree un client « Desktop » dans ta console Google Cloud, telecharge son JSON et pose-le a cet emplacement (voir le guide, Capture modules).`);
  return parseClient(readFileSync(file, 'utf8'), file);
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

/**
 * Ecrit un jeton. Au trousseau (`store`) : l'entree `token:<compte>`. En fichier : dossier 0700, fichier temporaire
 * 0600, renommage (jamais de fichier a moitie ecrit). Rend ou il est, jamais le jeton.
 */
export const saveToken = (account, token, dir = configDir(), { store } = {}) => {
  const file = tokenPath(account, dir);
  if (atKeychain(store)) {
    store.set(`token:${account}`, JSON.stringify(token));
    return `${store.kind} (service kioku-mail, entree token:${account})`;
  }
  writeSecretFile(file, `${JSON.stringify(token, null, 1)}\n`);
  return file;
};

/** Deux jetons egaux, cle a cle (JSON normalise : l'ordre des cles et la mise en forme ne comptent pas). */
const normalized = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, normalized(v[k])])) : v);
const sameToken = (a, b) => JSON.stringify(normalized(a)) === JSON.stringify(normalized(b));

const parseToken = (text, account, where) => {
  try {
    const t = JSON.parse(text);
    if (!t?.refresh_token) throw new Error('refresh_token absent');
    return t;
  } catch {
    throw new Error(`jeton illisible pour le compte ${account} (${where}) : relance \`kioku mail --login ${account}\` (npm run mail:login -- ${account})`);
  }
};

/**
 * Le jeton d'un compte. Au trousseau : lu a l'entree `token:<compte>`. Un fichier de jeton laisse par une version
 * anterieure (le core l'avait ecrit lui-meme) est importe au trousseau, relu, puis supprime, et la sortie le dit.
 */
export const loadToken = (account, dir = configDir(), { store, log = console.log } = {}) => {
  const file = tokenPath(account, dir);
  if (atKeychain(store)) {
    const key = `token:${account}`;
    const kept = store.get(key);
    if (kept) {
      // Revue N1 : une entree au trousseau ET un fichier. Le fichier n'est supprime que si l'entree se relit, se parse et
      // vaut le contenu du fichier (JSON normalise), ou si le fichier, plus recent, a ete reecrit au trousseau et relu.
      let fromStore;
      try {
        fromStore = parseToken(kept, account, store.kind);
      } catch {
        if (existsSync(file)) {
          throw new Error(`entree du trousseau illisible pour le compte ${account} ; le fichier de jeton est laisse en place (${file}). Relance \`kioku mail --login ${account}\` (npm run mail:login -- ${account})`);
        }
        throw new Error(`entree du trousseau illisible pour le compte ${account} : relance \`kioku mail --login ${account}\` (npm run mail:login -- ${account})`);
      }
      if (!existsSync(file)) return fromStore;
      let fromFile = null;
      try {
        fromFile = parseToken(readFileSync(file, 'utf8'), account, path.basename(file));
      } catch {
        log(`Attention : fichier de jeton illisible pour le compte ${account}, laisse en place (${file}) ; le trousseau fait foi.`);
        return fromStore;
      }
      if (sameToken(fromStore, fromFile)) {
        rmSync(file, { force: true });
        log(`Ancien fichier de jeton supprime (identique a l'entree du trousseau) : ${file}`);
        return fromStore;
      }
      // Deux jetons differents : le plus recent l'emporte (expiration la plus lointaine).
      if (Number(fromFile.expires_at ?? 0) > Number(fromStore.expires_at ?? 0)) {
        store.set(key, JSON.stringify(fromFile));
        let reread = null;
        try {
          reread = JSON.parse(store.get(key));
        } catch {
          reread = null;
        }
        if (!reread || !sameToken(reread, fromFile)) throw new Error(`deux jetons differents pour le compte ${account} : la reecriture au trousseau du plus recent (le fichier) ne se relit pas ; fichier laisse en place (${file})`);
        rmSync(file, { force: true });
        log(`Deux jetons differents pour le compte ${account} : le fichier, plus recent, a ete reecrit au trousseau puis supprime (${file}).`);
        return fromFile;
      }
      log(`Attention : deux jetons differents pour le compte ${account} ; le trousseau, plus recent, fait foi. Fichier laisse en place : ${file} (a supprimer a la main s'il ne sert plus).`);
      return fromStore;
    }
    if (!existsSync(file)) throw new Error(`pas de jeton pour le compte ${account} au trousseau : relance \`kioku mail --login ${account}\` depuis un terminal (npm run mail:login -- ${account})`);
    const text = readFileSync(file, 'utf8');
    const token = parseToken(text, account, path.basename(file));
    store.set(key, JSON.stringify(token));
    if (store.get(key) !== JSON.stringify(token)) throw new Error(`migration du jeton de ${account} au trousseau : relecture differente, fichier laisse en place`);
    rmSync(file, { force: true });
    log(`Jeton du compte ${account} importe au trousseau (${store.kind}) ; fichier supprime : ${file}`);
    return token;
  }
  if (!existsSync(file)) throw new Error(`pas de jeton pour le compte ${account} : lance une fois \`npm run mail:login -- ${account}\` depuis un terminal`);
  return parseToken(readFileSync(file, 'utf8'), account, path.basename(file));
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
export const login = async (account, { dir = configDir(), fetch, sleep, now = Date.now, openUrl, timeoutMs, verifierBytes, store, log } = {}) => {
  tokenPath(account, dir); // valide l'identifiant avant d'ouvrir quoi que ce soit
  const client = loadClient(dir, { store, importFile: true, log });
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
  return saveToken(account, fromResponse(r, now), dir, { store });
};

/**
 * Un jeton d'acces valide pour le compte, rafraichi au besoin (et reecrit). `force` : rafraichir meme s'il semble
 * valide (une 401 de l'API : jeton revoque cote serveur).
 */
export const accessToken = async (account, { dir = configDir(), fetch, sleep, now = Date.now, force = false, store, log } = {}) => {
  const token = loadToken(account, dir, { store, log });
  if (!force && token.access_token && Number(token.expires_at) - EARLY_REFRESH_MS > now()) return token.access_token;
  const client = loadClient(dir, { store, log });
  let r;
  try {
    r = await tokenRequest({ grant_type: 'refresh_token', refresh_token: token.refresh_token, client_id: client.clientId, client_secret: client.clientSecret }, { fetch, sleep }, 'oauth rafraichissement');
  } catch (error) {
    if (error instanceof HttpError && (error.code === 'invalid_grant' || error.status === 400 || error.status === 401)) {
      throw new Error(`rafraichissement du jeton refuse pour le compte ${account} (${error.code || `HTTP ${error.status}`}) : relance \`npm run mail:login -- ${account}\` (kioku mail --login ${account})`);
    }
    throw error;
  }
  const next = fromResponse(r, now, token);
  saveToken(account, next, dir, { store });
  return next.access_token;
};
