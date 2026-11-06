/**
 * Requetes HTTP du module mail : `fetch` de Node (aucune dependance), injectable pour les tests.
 *
 * Relance bornee : 429 (quota) et 5xx (panne passagere), et une erreur reseau, au plus `retries` fois, apres
 * `Retry-After` s'il est donne (plafonne), sinon une attente qui double (1 s, 2 s, 4 s…). Au-dela, l'erreur remonte :
 * mieux vaut un echec franc qu'une boucle. Une 4xx autre que 429 ne se relance pas : elle se reproduirait.
 *
 * Aucun corps de reponse n'est recopie dans un message d'erreur au-dela du champ `error` : une reponse du serveur de
 * jetons peut porter un jeton, une reponse de l'API un contenu de mail.
 */

export class HttpError extends Error {
  constructor(message, { status, code } = {}) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const RETRYABLE = new Set([429, 500, 502, 503, 504]);
const MAX_WAIT_MS = 30_000;

export const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Le champ `error` d'un corps JSON d'erreur (Google : chaine, ou objet { code, message, status }), sans plus. */
const errorCode = (body) => {
  const e = body?.error;
  if (typeof e === 'string') return e;
  if (e && typeof e === 'object') return e.status ?? String(e.code ?? '');
  return '';
};

/**
 * Une requete qui rend le JSON de la reponse. `what` nomme l'appel dans les erreurs (« gmail threads.list »).
 * Options : fetch, sleep, retries (3), baseDelayMs (1000).
 */
export const requestJson = async (url, init = {}, { fetch = globalThis.fetch, sleep = defaultSleep, retries = 3, baseDelayMs = 1000, what = 'requete' } = {}) => {
  for (let attempt = 0; ; attempt++) {
    let res;
    try {
      res = await fetch(url, init);
    } catch (error) {
      if (attempt >= retries) throw new HttpError(`${what} : reseau indisponible (${error?.cause?.code ?? error?.message ?? 'erreur'}) apres ${attempt} relance(s)`, { code: 'network' });
      await sleep(baseDelayMs * 2 ** attempt);
      continue;
    }
    if (res.ok) {
      const text = await res.text();
      try {
        return text ? JSON.parse(text) : {};
      } catch {
        throw new HttpError(`${what} : reponse non JSON (HTTP ${res.status})`, { status: res.status });
      }
    }
    let body = null;
    try {
      body = JSON.parse(await res.text());
    } catch {
      body = null;
    }
    if (RETRYABLE.has(res.status) && attempt < retries) {
      const after = Number(res.headers?.get?.('retry-after'));
      await sleep(Number.isFinite(after) && after >= 0 ? Math.min(after * 1000, MAX_WAIT_MS) : baseDelayMs * 2 ** attempt);
      continue;
    }
    const code = errorCode(body);
    throw new HttpError(`${what} : HTTP ${res.status}${code ? ` (${code})` : ''}${RETRYABLE.has(res.status) ? ` apres ${attempt} relance(s)` : ''}`, { status: res.status, code });
  }
};
