/**
 * MIME sans dependance : ce qu'il faut pour lire un mail, quel que soit le fournisseur.
 *
 * Deux entrees, une seule forme d'arbre :
 *   - parseRaw(bytes)  : un message RFC 822 brut (IMAP, Gmail `format=raw`, piece jointe message/rfc822) ;
 *   - l'arbre `payload` de l'API Gmail, converti par le fournisseur (providers/gmail.mjs).
 * Arbre : { mimeType, headers: [{ name, value }], filename, body: { data: Buffer|null, size, attachmentId? }, parts: [] }.
 * `body.data` est TOUJOURS le contenu apres decodage du transfert (base64, quoted-printable) : parseRaw le decode ;
 * pour l'API Gmail, le fournisseur decode le base64url puis, au besoin, l'encodage de transfert (undoTransferIfStill).
 *
 * Puis messageFromTree(tree) : en-tetes utiles, texte (text/plain, sinon HTML converti), pieces jointes.
 * Charsets par TextDecoder (utf-8, iso-8859-1, windows-1252, et ce que Node connait). Sujets RFC 2047.
 * Ce module ne juge rien du contenu : il decode.
 */

const LATIN = new Set(['iso-8859-1', 'latin1', 'iso_8859-1', 'us-ascii', 'ascii', 'windows-1252', 'cp1252', 'iso-8859-15']);

/** base64url ou base64 -> Buffer (Gmail rend du base64url ; les espaces et retours de ligne sont toleres). */
export const fromBase64 = (text) => Buffer.from(String(text ?? '').replace(/\s+/g, '').replace(/-/g, '+').replace(/_/g, '/'), 'base64');

/** quoted-printable -> Buffer. `=\r?\n` est une coupure douce ; `=XX` un octet ; un `=` isole reste tel quel. */
export const fromQuotedPrintable = (text, { header = false } = {}) => {
  const src = header ? String(text).replace(/_/g, ' ') : String(text).replace(/=\r?\n/g, '');
  const bytes = [];
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (c === '=' && /^[0-9A-Fa-f]{2}$/.test(src.slice(i + 1, i + 3))) {
      bytes.push(parseInt(src.slice(i + 1, i + 3), 16));
      i += 2;
    } else {
      const code = src.charCodeAt(i);
      if (code < 0x80) bytes.push(code);
      else bytes.push(...Buffer.from(c, 'utf8'));
    }
  }
  return Buffer.from(bytes);
};

// windows-1252, plage 0x80-0x9F (le reste est latin1). Les cinq positions non definies restent telles quelles.
const CP1252 = '\u20ac\u0081\u201a\u0192\u201e\u2026\u2020\u2021\u02c6\u2030\u0160\u2039\u0152\u008d\u017d\u008f\u0090\u2018\u2019\u201c\u201d\u2022\u2013\u2014\u02dc\u2122\u0161\u203a\u0153\u009d\u017e\u0178';
const cp1252 = (buf) => {
  let out = '';
  for (const b of buf) out += b >= 0x80 && b <= 0x9f ? CP1252[b - 0x80] : String.fromCharCode(b);
  return out;
};

/** `r%C3%A9sum%C3%A9` -> octets (RFC 2231) ; un `%` non suivi de deux chiffres hexadecimaux reste tel quel. */
const percentBytes = (s) => {
  const bytes = [];
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '%' && /^[0-9A-Fa-f]{2}$/.test(s.slice(i + 1, i + 3))) {
      bytes.push(parseInt(s.slice(i + 1, i + 3), 16));
      i += 2;
    } else bytes.push(...Buffer.from(s[i], 'utf8'));
  }
  return Buffer.from(bytes);
};

const isUtf8 = (bytes) => {
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return true;
  } catch {
    return false;
  }
};

/**
 * Octets -> texte, selon le charset declare. Charset inconnu de TextDecoder : utf-8, sinon windows-1252 (repli
 * permissif, jamais d'exception). Un charset latin declare sur des octets UTF-8 valides et non ASCII : utf-8 (un mail
 * re-encode par un intermediaire ; l'inverse, du latin valide en UTF-8, est quasi impossible avec des accents).
 */
export const decodeText = (bytes, charset = 'utf-8') => {
  const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes ?? []);
  let cs = String(charset || 'utf-8').trim().toLowerCase().replace(/^"|"$/g, '');
  if (LATIN.has(cs) && buf.some((b) => b >= 0x80) && isUtf8(buf)) cs = 'utf-8';
  // ISO-8859-1 tel que les mails l'emploient : windows-1252 (WHATWG fait de meme), qui couvre les guillemets
  // typographiques. Decode ici : le TextDecoder de Node traite windows-1252 comme latin1 (0x80-0x9F non traduits).
  if (cs === 'iso-8859-1' || cs === 'latin1' || cs === 'iso_8859-1' || cs === 'us-ascii' || cs === 'ascii' || cs === 'cp1252' || cs === 'windows-1252') return cp1252(buf);
  try {
    return new TextDecoder(cs).decode(buf);
  } catch {
    return isUtf8(buf) ? new TextDecoder('utf-8').decode(buf) : cp1252(buf);
  }
};

/** En-tete RFC 2047 (`=?utf-8?B?…?=`, `=?iso-8859-1?Q?…?=`) -> texte. Les espaces entre deux mots encodes disparaissent. */
export const decodeWords = (value) =>
  String(value ?? '')
    .replace(/(=\?[^?]+\?[BbQq]\?[^?]*\?=)\s+(?==\?)/g, '$1')
    .replace(/=\?([^?]+)\?([BbQq])\?([^?]*)\?=/g, (whole, charset, enc, data) => {
      try {
        const bytes = enc.toUpperCase() === 'B' ? fromBase64(data) : fromQuotedPrintable(data, { header: true });
        return decodeText(bytes, charset.replace(/\*.*$/, ''));
      } catch {
        return whole;
      }
    });

/** La valeur d'un en-tete (insensible a la casse), decodee RFC 2047 ; '' si absent. */
export const header = (headers, name) => decodeWords((headers ?? []).find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ?? '').trim();

/** `type/sous-type; a=b; c="d"` -> { value, params }. Parametres RFC 2231 simples (`name*=utf-8''…`) compris. */
export const parseParams = (value) => {
  const [head, ...rest] = String(value ?? '').split(';');
  const params = {};
  for (const p of rest) {
    const m = p.match(/^\s*([^=\s]+)\s*=\s*(.*?)\s*$/);
    if (!m) continue;
    let [, key, val] = m;
    key = key.toLowerCase();
    val = val.replace(/^"(.*)"$/, '$1');
    if (key.endsWith('*')) {
      const ext = val.match(/^([^']*)'[^']*'(.*)$/);
      key = key.replace(/\*(\d+\*?)?$/, '');
      val = ext ? decodeText(percentBytes(ext[2]), ext[1] || 'utf-8') : val;
      params[key] = (params[key] ?? '') + val;
    } else params[key] = decodeWords(val);
  }
  return { value: head.trim().toLowerCase(), params };
};

/** En-tetes bruts (avec lignes repliees) -> [{ name, value }]. */
const parseHeaders = (text) =>
  text
    .replace(/\r?\n[ \t]+/g, ' ')
    .split(/\r?\n/)
    .map((l) => l.match(/^([^:\s]+):\s*(.*)$/))
    .filter(Boolean)
    .map((m) => ({ name: m[1], value: m[2] }));

/**
 * Tolerance pour l'API Gmail (format=full) : `body.data` est du base64url (doc : « The body data of a MIME message
 * part as a base64url encoded string »), mais la documentation ne dit pas si l'encodage de TRANSFERT de la partie
 * (Content-Transfer-Encoding) a deja ete retire. On ne decode donc une seconde fois que si les octets portent encore,
 * sans ambiguite, la marque de cet encodage :
 *   - quoted-printable : octets tous ASCII, et au moins une sequence `=XX` ou une coupure douce `=` en fin de ligne
 *     (un texte deja decode qui contient un accent a des octets >= 0x80 : il n'est pas touche) ;
 *   - base64 : uniquement l'alphabet base64 et des retours de ligne (aucune espace : un texte decode en a presque
 *     toujours), longueur utile multiple de 4 et >= 8.
 * Un `7bit`, `8bit`, `binary` ou absent : rien a faire. Rend les octets, decodes ou tels quels.
 */
export const undoTransferIfStill = (bytes, cte) => {
  const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes ?? []);
  const enc = String(cte ?? '').trim().toLowerCase();
  if (!buf.length) return buf;
  const ascii = !buf.some((b) => b >= 0x80);
  const text = ascii ? buf.toString('latin1') : '';
  if (enc === 'quoted-printable' && ascii && /=[0-9A-Fa-f]{2}|=\r?\n/.test(text)) return fromQuotedPrintable(text);
  if (enc === 'base64' && ascii && /^[A-Za-z0-9+/=\r\n]+$/.test(text)) {
    const compact = text.replace(/\r?\n/g, '');
    if (compact.length >= 8 && compact.length % 4 === 0 && /^[A-Za-z0-9+/]+={0,2}$/.test(compact)) return fromBase64(compact);
  }
  return buf;
};

const decodeTransfer = (raw, cte) => {
  const enc = String(cte ?? '').trim().toLowerCase();
  if (enc === 'base64') return fromBase64(raw.toString('latin1'));
  if (enc === 'quoted-printable') return fromQuotedPrintable(raw.toString('latin1'));
  return raw;
};

/**
 * Un message brut (Buffer ou texte) -> arbre. Multiparts imbriques a toute profondeur (bornee : 20 niveaux, contre un
 * message construit pour epuiser la pile), transfert decode. Un multipart sans frontiere est lu comme une feuille.
 */
export const parseRaw = (input, depth = 0) => {
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(String(input), 'latin1');
  const text = buf.toString('latin1');
  const split = text.search(/\r?\n\r?\n/);
  const headText = split < 0 ? text : text.slice(0, split);
  const bodyStart = split < 0 ? text.length : split + (text.slice(split).startsWith('\r\n\r\n') ? 4 : 2);
  const headers = parseHeaders(headText);
  const ct = parseParams(header(headers, 'content-type') || 'text/plain; charset=us-ascii');
  const disposition = parseParams(header(headers, 'content-disposition'));
  const filename = disposition.params.filename ?? ct.params.name ?? '';
  const node = { mimeType: ct.value, headers, filename, body: { data: null, size: 0 }, parts: [] };
  const rawBody = Buffer.from(text.slice(bodyStart), 'latin1');
  const boundary = ct.params.boundary;
  if (ct.value.startsWith('multipart/') && boundary && depth < 20) {
    const delim = `--${boundary}`;
    const chunks = text.slice(bodyStart).split(new RegExp(`\\r?\\n?${delim.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(--)?[ \\t]*`));
    // split rend [preambule, partie, '--'|undefined, partie, …] : on garde les parties entre la premiere frontiere et la finale.
    const parts = [];
    for (let i = 1; i < chunks.length; i += 2) {
      const closing = chunks[i] === '--';
      const chunk = chunks[i + 1];
      if (closing) break;
      if (chunk !== undefined) parts.push(chunk.replace(/^\r?\n/, ''));
    }
    node.parts = parts.map((p) => parseRaw(Buffer.from(p, 'latin1'), depth + 1));
    return node;
  }
  const data = decodeTransfer(rawBody, header(headers, 'content-transfer-encoding'));
  node.body = { data, size: data.length };
  if (ct.value === 'message/rfc822' && depth < 20) node.parts = [parseRaw(data, depth + 1)];
  return node;
};

// --- HTML -> texte, maison : assez pour un mail, pas un moteur de rendu. ---

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', eacute: 'é', egrave: 'è', ecirc: 'ê', agrave: 'à', acirc: 'â', ccedil: 'ç', ocirc: 'ô', ugrave: 'ù', ucirc: 'û', icirc: 'î', iuml: 'ï', euml: 'ë', laquo: '«', raquo: '»', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“', hellip: '…', ndash: '–', mdash: '—', euro: '€', copy: '©' };
export const decodeEntities = (s) =>
  s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, e) => {
    if (e[0] === '#') {
      const code = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
    }
    return ENTITIES[e.toLowerCase()] ?? whole;
  });

/** Retire les elements `tag` (avec leur contenu), imbrications comprises, sans regex recursive. */
const dropElement = (html, tag, attrTest = () => true) => {
  const open = new RegExp(`<${tag}\\b([^>]*)>`, 'gi');
  let out = html;
  for (let guard = 0; guard < 1000; guard++) {
    open.lastIndex = 0;
    let m;
    let start = -1;
    while ((m = open.exec(out))) {
      if (attrTest(m[1])) {
        start = m.index;
        break;
      }
    }
    if (start < 0) return out;
    const re = new RegExp(`<(/?)${tag}\\b[^>]*>`, 'gi');
    re.lastIndex = start;
    let depth = 0;
    let end = out.length;
    let t;
    while ((t = re.exec(out))) {
      depth += t[1] ? -1 : 1;
      if (depth === 0) {
        end = t.index + t[0].length;
        break;
      }
    }
    out = out.slice(0, start) + out.slice(end);
  }
  return out;
};

/** HTML d'un mail -> texte. Les citations Gmail (`gmail_quote`) et les `<blockquote>` sont retirees : la cascade. */
export const htmlToText = (html) => {
  let s = String(html ?? '');
  s = s.replace(/<!--[\s\S]*?-->/g, '');
  for (const tag of ['head', 'style', 'script', 'title']) s = dropElement(s, tag);
  s = dropElement(s, 'blockquote');
  s = dropElement(s, 'div', (attrs) => /gmail_quote|moz-cite-prefix|divRplyFwdMsg/i.test(attrs));
  s = s
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<li\b[^>]*>/gi, '\n- ')
    .replace(/<\/li>/gi, '')
    .replace(/<\/(p|div|tr|h[1-6]|ul|ol|table)>/gi, '\n')
    .replace(/<(p|h[1-6]|tr)\b[^>]*>/gi, '\n')
    .replace(/<\/t[dh]>/gi, '\t')
    .replace(/<[^>]+>/g, '');
  s = decodeEntities(s);
  return s
    .split('\n')
    .map((l) => l.replace(/[ \t ]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
};

/**
 * Un arbre -> { headers: { from, to, cc, date, subject, messageId }, text, attachments }.
 * Texte : le premier text/plain hors piece jointe ; a defaut, le premier text/html converti. Dans un
 * multipart/alternative, text/plain gagne. Pieces jointes : toute feuille portant un nom de fichier, ou une
 * disposition attachment, hors parties texte du corps.
 */
export const messageFromTree = (tree) => {
  const plain = [];
  const html = [];
  const attachments = [];
  const walk = (node) => {
    const disp = parseParams(header(node.headers, 'content-disposition')).value;
    const isAttachment = Boolean(node.filename) || disp === 'attachment';
    if (node.parts?.length && node.mimeType !== 'message/rfc822') return node.parts.forEach(walk);
    if (isAttachment || node.mimeType === 'message/rfc822') {
      attachments.push({
        filename: node.filename || (node.mimeType === 'message/rfc822' ? 'message.eml' : 'sans-nom'),
        mimeType: node.mimeType,
        size: node.body?.size ?? node.body?.data?.length ?? 0,
        attachmentId: node.body?.attachmentId ?? null,
        transferEncoding: header(node.headers, 'content-transfer-encoding').toLowerCase(),
        data: node.body?.data ?? null,
      });
      return;
    }
    const charset = parseParams(header(node.headers, 'content-type')).params.charset ?? 'utf-8';
    if (node.mimeType === 'text/plain' && node.body?.data) plain.push(decodeText(node.body.data, charset));
    else if (node.mimeType === 'text/html' && node.body?.data) html.push(decodeText(node.body.data, charset));
  };
  walk(tree);
  const h = (n) => header(tree.headers, n);
  const text = plain.length ? plain.join('\n\n') : html.length ? htmlToText(html.join('\n')) : '';
  return {
    headers: { from: h('from'), to: h('to'), cc: h('cc'), date: h('date'), subject: h('subject'), messageId: h('message-id') },
    text: text.replace(/\r\n/g, '\n'),
    attachments,
  };
};
