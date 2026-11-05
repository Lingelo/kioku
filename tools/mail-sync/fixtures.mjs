/**
 * Faux Gmail pour les tests du module mail : aucun appel reseau, contenus inventes, adresses en example.com.
 *
 *   fakeGmail({ labels, threads })  -> { fetch, calls }   un `fetch` qui repond comme l'API REST Gmail v1
 *   gmailMessage({...})             -> un message au format de l'API (format=full)
 *   jsonResponse(status, body, headers) -> une Response minimale
 */

const b64url = (s) => Buffer.from(s).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

export const jsonResponse = (status, body, headers = {}) => ({
  ok: status >= 200 && status < 300,
  status,
  headers: { get: (k) => headers[k.toLowerCase()] ?? null },
  text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
});

/**
 * Un message Gmail. `text` (text/plain), `html` (text/html, en alternative), `attachments` : [{ filename, mimeType,
 * data (Buffer) | size + attachmentId }].
 */
export const gmailMessage = ({ id, threadId, internalDate, from = 'Alice Martin <alice@example.com>', to = 'Bruno Petit <bruno@example.com>', cc, subject = 'Point projet Atlas', date, text, html, charset = 'utf-8', attachments = [] }) => {
  const headers = [
    { name: 'From', value: from },
    { name: 'To', value: to },
    ...(cc ? [{ name: 'Cc', value: cc }] : []),
    { name: 'Subject', value: subject },
    { name: 'Date', value: date ?? new Date(internalDate).toUTCString() },
  ];
  const textPart = (mime, body) => ({ mimeType: mime, filename: '', headers: [{ name: 'Content-Type', value: `${mime}; charset=${charset}` }], body: { size: Buffer.byteLength(body), data: b64url(Buffer.isBuffer(body) ? body : Buffer.from(body, charset === 'utf-8' ? 'utf8' : 'latin1')) } });
  const alt = { mimeType: 'multipart/alternative', filename: '', headers: [], body: { size: 0 }, parts: [...(text !== undefined ? [textPart('text/plain', text)] : []), ...(html !== undefined ? [textPart('text/html', html)] : [])] };
  const atts = attachments.map((a, i) => ({
    mimeType: a.mimeType ?? 'application/pdf',
    filename: a.filename,
    headers: [{ name: 'Content-Disposition', value: `attachment; filename="${a.filename}"` }],
    body: a.data ? { size: a.data.length, attachmentId: a.attachmentId ?? `att-${id}-${i}` } : { size: a.size, attachmentId: a.attachmentId ?? `att-${id}-${i}` },
  }));
  return { id, threadId, internalDate: String(internalDate), payload: { mimeType: 'multipart/mixed', filename: '', headers, body: { size: 0 }, parts: [alt, ...atts] } };
};

/**
 * @param {{labels?: {id: string, name: string}[], threads: {id: string, messages: object[]}[], pageSize?: number,
 *          attachments?: Record<string, Buffer>, failures?: Function}} opts
 * `failures(url, n)` peut rendre une Response pour simuler une erreur (n = numero d'appel).
 */
export const fakeGmail = ({ labels = [{ id: 'Label_1', name: 'kb' }], threads, pageSize = 100, attachments = {}, failures } = {}) => {
  const calls = [];
  const fetch = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    const injected = failures?.(String(url), calls.length, init);
    if (injected) return injected;
    const u = new URL(url);
    const p = u.pathname.replace('/gmail/v1/users/me', '');
    if (p === '/labels') return jsonResponse(200, { labels });
    if (p === '/threads') {
      const start = Number(u.searchParams.get('pageToken') ?? 0);
      const page = threads.slice(start, start + pageSize).map((t) => ({ id: t.id }));
      return jsonResponse(200, { threads: page, ...(start + pageSize < threads.length ? { nextPageToken: String(start + pageSize) } : {}) });
    }
    const t = p.match(/^\/threads\/([^/]+)$/);
    if (t) {
      const thread = threads.find((x) => x.id === decodeURIComponent(t[1]));
      return thread ? jsonResponse(200, { id: thread.id, messages: thread.messages }) : jsonResponse(404, { error: { code: 404, status: 'NOT_FOUND' } });
    }
    const a = p.match(/^\/messages\/([^/]+)\/attachments\/([^/]+)$/);
    if (a) {
      const data = attachments[decodeURIComponent(a[2])];
      return data ? jsonResponse(200, { size: data.length, data: b64url(data) }) : jsonResponse(404, { error: { code: 404 } });
    }
    return jsonResponse(404, { error: { code: 404 } });
  };
  return { fetch, calls };
};
