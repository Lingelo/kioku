/**
 * Decodage d'une charge utile au format REEL de l'API Gmail : `node --test tools/mail-sync/gmail-payload.test.mjs`
 *
 * Reference (developers.google.com/gmail/api/reference/rest/v1/users.messages.attachments, ressource MessagePartBody) :
 *   data : « The body data of a MIME message part as a base64url encoded string. »
 *   size : « Number of bytes for the message part data (encoding notwithstanding). »
 * Revue I1 : on ne decode que ce base64url, et on fait confiance a Gmail pour l'encodage de TRANSFERT de la partie.
 * Si un texte ressemble fortement a du quoted-printable residuel, il n'est PAS decode une seconde fois (cela
 * corromprait un texte deja decode) : il est signale (`qp-suspect`, `mail_warnings:` du bronze). Contenus inventes,
 * adresses en example.com.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';

import { writeTestConfig } from '../test-vault.mjs';
import { captureAccount } from './capture.mjs';
import { jsonResponse } from './fixtures.mjs';
import { fromBase64, qpSuspect } from './mime.mjs';
import { createGmail, messageFromApi } from './providers/gmail.mjs';

/** base64url sans remplissage, comme l'API. */
const b64url = (buf) => Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const cp1252 = (s) => Buffer.from(s.replace(/’/g, '\x92'), 'latin1'); // « ’ » = 0x92 en windows-1252
const PDF = Buffer.from('%PDF-1.4\n1 0 obj << /Type /Catalog >> endobj\n%%EOF\n');

const TEXT = 'Réunion déplacée à jeudi — merci.';
const HTML = '<div dir="ltr"><p>Réunion déplacée à jeudi, l’ordre du jour suit.</p></div>';

/**
 * Un `messages.get?format=full` complet. `transfer` : 'removed' (le corps est deja decode du transfert, seul le base64url
 * de l'API reste) ou 'kept' (le corps est encore en quoted-printable / base64 sous le base64url).
 */
const apiMessage = (transfer) => {
  const textBytes = Buffer.from(TEXT, 'utf8');
  const htmlBytes = cp1252(HTML);
  const qp = 'R=C3=A9union d=C3=A9plac=C3=A9e =C3=A0 jeudi =E2=80=94 merci.';
  const htmlB64 = htmlBytes.toString('base64').replace(/(.{20})/g, '$1\r\n');
  return {
    id: '18f2a7c0d1e2f3a4',
    threadId: '18f2a7c0d1e2f300',
    labelIds: ['Label_7', 'INBOX'],
    snippet: 'Réunion déplacée à jeudi',
    historyId: '987654',
    internalDate: String(Date.UTC(2026, 10, 5, 8, 30)),
    sizeEstimate: 12345,
    payload: {
      partId: '',
      mimeType: 'multipart/mixed',
      filename: '',
      headers: [
        { name: 'MIME-Version', value: '1.0' },
        { name: 'Date', value: 'Thu, 5 Nov 2026 09:30:00 +0100' },
        { name: 'Message-ID', value: '<msg-1@mail.example.com>' },
        { name: 'Subject', value: '=?UTF-8?Q?R=C3=A9union_d=C3=A9plac=C3=A9e?=' },
        { name: 'From', value: '=?UTF-8?Q?Alice_M=C3=A9tayer?= <alice@example.com>' },
        { name: 'To', value: 'bruno@example.com' },
        { name: 'Content-Type', value: 'multipart/mixed; boundary="000000000000aaaa"' },
      ],
      body: { size: 0 },
      parts: [
        {
          partId: '0',
          mimeType: 'multipart/alternative',
          filename: '',
          headers: [{ name: 'Content-Type', value: 'multipart/alternative; boundary="000000000000bbbb"' }],
          body: { size: 0 },
          parts: [
            {
              partId: '0.0',
              mimeType: 'text/plain',
              filename: '',
              headers: [
                { name: 'Content-Type', value: 'text/plain; charset="UTF-8"' },
                { name: 'Content-Transfer-Encoding', value: 'quoted-printable' },
              ],
              body: { size: textBytes.length, data: b64url(transfer === 'kept' ? Buffer.from(qp, 'ascii') : textBytes) },
            },
            {
              partId: '0.1',
              mimeType: 'text/html',
              filename: '',
              headers: [
                { name: 'Content-Type', value: 'text/html; charset="windows-1252"' },
                { name: 'Content-Transfer-Encoding', value: 'base64' },
              ],
              body: { size: htmlBytes.length, data: b64url(transfer === 'kept' ? Buffer.from(htmlB64, 'ascii') : htmlBytes) },
            },
          ],
        },
        {
          partId: '1',
          mimeType: 'application/pdf',
          filename: 'compte-rendu.pdf',
          headers: [
            { name: 'Content-Type', value: 'application/pdf; name="compte-rendu.pdf"' },
            { name: 'Content-Disposition', value: 'attachment; filename="compte-rendu.pdf"' },
            { name: 'Content-Transfer-Encoding', value: 'base64' },
            { name: 'X-Attachment-Id', value: 'f_abc123' },
          ],
          body: { attachmentId: 'ANGjdJ8-exemple_id', size: PDF.length },
        },
      ],
    },
  };
};

/** Un `fetch` qui sert labels, threads.list, threads.get et attachments.get au format de l'API. */
const api = (message) => {
  const calls = [];
  const fetch = async (url) => {
    calls.push(String(url));
    const p = new URL(url).pathname.replace('/gmail/v1/users/me', '');
    if (p === '/labels') return jsonResponse(200, { labels: [{ id: 'Label_7', name: 'kb', type: 'user' }] });
    if (p === '/threads') return jsonResponse(200, { threads: [{ id: message.threadId, snippet: message.snippet, historyId: message.historyId }], resultSizeEstimate: 1 });
    if (p === `/threads/${message.threadId}`) return jsonResponse(200, { id: message.threadId, historyId: message.historyId, messages: [message] });
    if (p === `/messages/${message.id}/attachments/ANGjdJ8-exemple_id`) {
      return jsonResponse(200, { size: PDF.length, data: b64url(PDF) });
    }
    return jsonResponse(404, { error: { code: 404, message: 'Not Found', status: 'NOT_FOUND' } });
  };
  return { fetch, calls };
};

describe('base64url de l API', () => {
  test('alphabet - et _, remplissage absent', () => {
    assert.equal(b64url(Buffer.from([0xfb, 0xef, 0xff])), '--__');
    assert.deepEqual(fromBase64('--__'), Buffer.from([0xfb, 0xef, 0xff]));
    assert.equal(fromBase64(b64url(Buffer.from('ab'))).toString(), 'ab'); // 'YWI', sans '='
  });
});

describe('messages.get format=full (corps decode par Gmail)', () => {
  test('en-tetes RFC 2047, text/plain UTF-8 prefere, pieces jointes par attachmentId, aucun avertissement', () => {
    const m = messageFromApi(apiMessage('removed'));
    assert.equal(m.headers.subject, 'Réunion déplacée');
    assert.equal(m.headers.from, 'Alice Métayer <alice@example.com>');
    assert.equal(m.text, TEXT);
    assert.deepEqual(m.attachments.map((a) => [a.filename, a.attachmentId, a.size]), [['compte-rendu.pdf', 'ANGjdJ8-exemple_id', PDF.length]]);
    assert.deepEqual(m.warnings, []);
  });

  test('sans text/plain : le HTML windows-1252 (guillemet 0x92) converti', () => {
    const msg = apiMessage('removed');
    msg.payload.parts[0].parts.shift();
    assert.equal(messageFromApi(msg).text, 'Réunion déplacée à jeudi, l’ordre du jour suit.');
  });

  test('une URL a parametres dans une partie quoted-printable deja decodee : intacte, sans avertissement', () => {
    const msg = apiMessage('removed');
    const url = 'Facture : https://example.com/facture?id=1234&page=2&x=3D (lien)';
    msg.payload.parts[0].parts[0].body = { size: url.length, data: b64url(Buffer.from(url)) };
    const m = messageFromApi(msg);
    assert.equal(m.text, url);
    assert.deepEqual(m.warnings, []);
  });
});

describe('quoted-printable residuel : signale, jamais decode (I1)', () => {
  test('le texte reste tel quel, avec l avertissement qp-suspect', () => {
    const m = messageFromApi(apiMessage('kept'));
    assert.equal(m.text, 'R=C3=A9union d=C3=A9plac=C3=A9e =C3=A0 jeudi =E2=80=94 merci.');
    assert.deepEqual(m.warnings, ['qp-suspect']);
  });
  test('qpSuspect : octets hauts encodes en suite, ou deux coupures douces ; pas une URL ni un = isole', () => {
    assert.equal(qpSuspect('caf=C3=A9'), true);
    assert.equal(qpSuspect('ligne un=\nligne deux=\nfin'), true);
    assert.equal(qpSuspect('?id=1234&page=2&x=3D'), false);
    assert.equal(qpSuspect('Prix = 3 €, a=b'), false);
  });
});

describe('bout en bout : depot d un fil reel', () => {
  let vault;
  beforeEach(() => {
    vault = mkdtempSync(path.join(tmpdir(), 'kioku-mail-api-'));
    writeTestConfig(vault);
  });
  afterEach(() => rmSync(vault, { recursive: true, force: true }));

  test('corps et PDF (attachments.get, base64url) decodes, octet pour octet', async () => {
    const { fetch, calls } = api(apiMessage('removed'));
    const out = await captureAccount({ vault, account: { id: 'travail', provider: 'gmail' }, provider: createGmail({ token: async () => 'tok', fetch }), since: '2026-11-01', log: () => {} });
    assert.equal(out.deposited.length, 1);
    assert.ok(calls.some((u) => u.endsWith('/attachments/ANGjdJ8-exemple_id')), 'le PDF est telecharge par attachmentId');
    const md = readFileSync(path.join(vault, 'inbox', out.deposited[0]), 'utf8');
    assert.ok(md.includes(TEXT));
    assert.match(md, /^subject: "Réunion déplacée"$/m);
    assert.doesNotMatch(md, /^mail_warnings:/m);
    assert.deepEqual(readFileSync(path.join(vault, 'inbox', out.pdfs[0])), PDF);
  });

  test('quoted-printable residuel : bronze avec mail_warnings et texte intact, signale au rapport', async () => {
    const logs = [];
    const out = await captureAccount({ vault, account: { id: 'travail', provider: 'gmail' }, provider: createGmail({ token: async () => 'tok', fetch: api(apiMessage('kept')).fetch }), since: '2026-11-01', log: (l) => logs.push(l) });
    const md = readFileSync(path.join(vault, 'inbox', out.deposited[0]), 'utf8');
    assert.match(md, /^mail_warnings: \["qp-suspect"\]$/m);
    assert.ok(md.includes('R=C3=A9union d=C3=A9plac=C3=A9e'), 'rien n est decode une seconde fois');
    assert.deepEqual(out.warnings, [{ file: out.deposited[0], warnings: ['qp-suspect'] }]);
    assert.ok(logs.some((l) => /\[avertissement\].*qp-suspect/.test(l)));
  });
});
