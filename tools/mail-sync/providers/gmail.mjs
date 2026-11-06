/**
 * Fournisseur Gmail : l'API REST Gmail v1 par `fetch`, en lecture seule (scope gmail.readonly).
 *
 * Interface commune des fournisseurs (un autre, IMAP par exemple, s'y branche sans toucher au reste) :
 *   listThreads(label, since)     -> [{ id }]   fils portant le libelle, avec un message depuis `since` (AAAA-MM-JJ)
 *   getThread(id)                 -> { id, messages: [message] }, messages dans l'ordre chronologique
 *   getAttachment(msgId, attId)   -> Buffer (le champ `data` de attachments.get, base64url decode)
 * message = { id, threadId, internalDate (ms), headers: { from, to, cc, date, subject }, text, attachments: [
 *             { filename, mimeType, size, attachmentId, data } ] }   (voir mime.mjs, messageFromTree)
 *
 * Le libelle se resout par son NOM (insensible a la casse) en identifiant, puis les fils se listent par `labelIds` :
 * plus sur qu'une requete `label:` (espaces, accents, libelles imbriques). Pagination par `nextPageToken`, bornee.
 * Une 401 en cours de route (jeton revoque cote serveur) : un rafraichissement force, puis une seule nouvelle tentative.
 */

import { HttpError, requestJson } from '../http.mjs';
import { fromBase64, messageFromTree } from '../mime.mjs';

export const API = 'https://gmail.googleapis.com/gmail/v1/users/me';
const MAX_PAGES = 50; // garde-fou : 50 pages de 100 fils

/**
 * L'arbre `payload` de l'API -> l'arbre de mime.mjs. `body.data` : base64url -> octets, et rien d'autre (doc
 * MessagePartBody : « The body data of a MIME message part as a base64url encoded string »). On fait confiance a Gmail
 * pour l'encodage de transfert de la partie (revue I1) ; un texte qui ressemble a du quoted-printable residuel est
 * signale par messageFromTree (`qp-suspect`), jamais decode une seconde fois.
 */
export const treeFromPayload = (p) => ({
  mimeType: String(p?.mimeType ?? 'text/plain').toLowerCase(),
  headers: p?.headers ?? [],
  filename: p?.filename ?? '',
  body: { data: p?.body?.data ? fromBase64(p.body.data) : null, size: Number(p?.body?.size ?? 0), attachmentId: p?.body?.attachmentId ?? null },
  parts: (p?.parts ?? []).map(treeFromPayload),
});

/** Un message de l'API (format=full) -> message neutre. */
export const messageFromApi = (m) => ({ id: m.id, threadId: m.threadId, internalDate: Number(m.internalDate ?? 0), ...messageFromTree(treeFromPayload(m.payload ?? {})) });

/**
 * @param {{ token: (opts?: {force?: boolean}) => Promise<string>, fetch?: Function, sleep?: Function }} deps
 */
export const createGmail = ({ token, fetch = globalThis.fetch, sleep } = {}) => {
  const call = async (url, what) => {
    const once = async (force) => requestJson(url, { headers: { authorization: `Bearer ${await token({ force })}` } }, { fetch, sleep, what: `gmail ${what}` });
    try {
      return await once(false);
    } catch (error) {
      if (error instanceof HttpError && error.status === 401) return once(true);
      throw error;
    }
  };

  const labelId = async (name) => {
    const { labels = [] } = await call(`${API}/labels`, 'labels.list');
    const wanted = String(name).toLowerCase();
    const found = labels.find((l) => String(l.name).toLowerCase() === wanted);
    if (!found) throw new Error(`libelle Gmail introuvable : "${name}" (cree-le dans Gmail et pose-le sur les fils a capter)`);
    return found.id;
  };

  return {
    async listThreads(label, since) {
      const id = await labelId(label);
      const q = since ? `after:${since.replace(/-/g, '/')}` : '';
      const out = [];
      let pageToken;
      for (let page = 0; page < MAX_PAGES; page++) {
        const params = new URLSearchParams({ labelIds: id, maxResults: '100', ...(q ? { q } : {}), ...(pageToken ? { pageToken } : {}) });
        const r = await call(`${API}/threads?${params}`, 'threads.list');
        for (const t of r.threads ?? []) if (!out.some((x) => x.id === t.id)) out.push({ id: t.id });
        pageToken = r.nextPageToken;
        if (!pageToken) return out;
      }
      throw new Error(`gmail threads.list : plus de ${MAX_PAGES} pages, resserre --since ou le libelle`);
    },
    async getThread(id) {
      const r = await call(`${API}/threads/${encodeURIComponent(id)}?format=full`, 'threads.get');
      const messages = (r.messages ?? []).map(messageFromApi).sort((a, b) => a.internalDate - b.internalDate);
      return { id: r.id ?? id, messages };
    },
    async getAttachment(msgId, attId) {
      const r = await call(`${API}/messages/${encodeURIComponent(msgId)}/attachments/${encodeURIComponent(attId)}`, 'attachments.get');
      return fromBase64(r.data ?? '');
    },
  };
};
