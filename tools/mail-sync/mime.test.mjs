/**
 * Tests du decodage MIME et du nettoyage : `node --test tools/mail-sync/mime.test.mjs`
 * Messages inventes, adresses en example.com.
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { cleanBody, stripQuotes, trimSignature } from './clean.mjs';
import { decodeText, decodeWords, fromBase64, fromQuotedPrintable, htmlToText, messageFromTree, parseParams, parseRaw } from './mime.mjs';

describe('transferts', () => {
  test('base64url et base64, espaces toleres', () => {
    assert.equal(fromBase64('w6l0w6k_').toString('utf8'), 'été?');
    assert.equal(fromBase64('w6l0\nw6k/').toString('utf8'), 'été?');
  });
  test('quoted-printable : octets, coupures douces, = isole', () => {
    assert.equal(fromQuotedPrintable('caf=C3=A9 cr=\n=C3=A8me =3D 2 =').toString('utf8'), 'café crème = 2 =');
    assert.equal(decodeText(fromQuotedPrintable('caf=E9'), 'iso-8859-1'), 'café');
  });
});

describe('charsets', () => {
  test('utf-8, iso-8859-1, windows-1252 (guillemets typographiques)', () => {
    assert.equal(decodeText(Buffer.from('déjà', 'utf8'), 'utf-8'), 'déjà');
    assert.equal(decodeText(Buffer.from([0x64, 0xe9, 0x6a, 0xe0]), 'iso-8859-1'), 'déjà');
    assert.equal(decodeText(Buffer.from([0x93, 0x6f, 0x6b, 0x94]), 'windows-1252'), '“ok”');
  });
  test('charset latin declare sur de l UTF-8 valide : UTF-8 ; charset inconnu : repli sans exception', () => {
    assert.equal(decodeText(Buffer.from('été', 'utf8'), 'iso-8859-1'), 'été');
    assert.equal(decodeText(Buffer.from('été', 'utf8'), 'x-inconnu'), 'été');
    assert.equal(decodeText(Buffer.from([0xe9]), 'x-inconnu'), 'é');
  });
  test('RFC 2047 : B et Q, mots adjacents recolles, texte non encode garde', () => {
    assert.equal(decodeWords('=?utf-8?B?UsOpdW5pb24=?= =?utf-8?Q?_d=C3=A9cision?='), 'Réunion décision');
    assert.equal(decodeWords('Re: =?iso-8859-1?Q?caf=E9?= demain'), 'Re: café demain');
    assert.equal(decodeWords('=?utf-8?X?mal?='), '=?utf-8?X?mal?=');
  });
  test('parametres, dont RFC 2231', () => {
    assert.deepEqual(parseParams('text/plain; charset="ISO-8859-1"; format=flowed'), { value: 'text/plain', params: { charset: 'ISO-8859-1', format: 'flowed' } });
    assert.equal(parseParams("attachment; filename*=utf-8''r%C3%A9sum%C3%A9.pdf").params.filename, 'résumé.pdf');
  });
});

describe('parseRaw : multipart imbriques', () => {
  const raw = [
    'From: =?utf-8?Q?Alice_M=C3=A9tayer?= <alice@example.com>',
    'To: bruno@example.com',
    'Subject: =?utf-8?B?QnVkZ2V0IDIwMjc=?=',
    'Content-Type: multipart/mixed; boundary="ext"',
    '',
    'preambule ignore',
    '--ext',
    'Content-Type: multipart/alternative; boundary=alt',
    '',
    '--alt',
    'Content-Type: text/plain; charset=iso-8859-1',
    'Content-Transfer-Encoding: quoted-printable',
    '',
    'Le budget est valid=E9 pour 2027.',
    '--alt',
    'Content-Type: text/html; charset=utf-8',
    '',
    '<p>Le budget est <b>valid&eacute;</b></p>',
    '--alt--',
    '--ext',
    'Content-Type: application/pdf; name="devis.pdf"',
    'Content-Disposition: attachment; filename="devis.pdf"',
    'Content-Transfer-Encoding: base64',
    '',
    Buffer.from('%PDF-1.4 invente').toString('base64'),
    '--ext--',
    'epilogue ignore',
  ].join('\r\n');

  test('en-tetes RFC 2047, text/plain prefere au HTML, transfert et charset decodes, piece jointe', () => {
    const m = messageFromTree(parseRaw(raw));
    assert.equal(m.headers.from, 'Alice Métayer <alice@example.com>');
    assert.equal(m.headers.subject, 'Budget 2027');
    assert.equal(m.text, 'Le budget est validé pour 2027.');
    assert.equal(m.attachments.length, 1);
    assert.equal(m.attachments[0].filename, 'devis.pdf');
    assert.equal(m.attachments[0].data.toString(), '%PDF-1.4 invente');
  });

  test('sans text/plain : le HTML converti', () => {
    const htmlOnly = raw.replace(/--alt\r\nContent-Type: text\/plain[\s\S]*?2027\.\r\n/, '');
    assert.equal(messageFromTree(parseRaw(htmlOnly)).text, 'Le budget est validé');
  });

  test('profondeur bornee : un message construit pour epuiser la pile ne fait pas tomber le processus', () => {
    let nested = 'Content-Type: text/plain\r\n\r\nfond';
    for (let i = 0; i < 60; i++) nested = `Content-Type: multipart/mixed; boundary=b${i}\r\n\r\n--b${i}\r\n${nested}\r\n--b${i}--`;
    assert.doesNotThrow(() => messageFromTree(parseRaw(nested)));
  });
});

describe('HTML -> texte', () => {
  test('balises, entites, listes ; citations Gmail et blockquote retirees', () => {
    const html = '<html><head><style>p{}</style></head><body><p>Bonjour,</p><ul><li>point&nbsp;1</li><li>&#233;t&#xE9;</li></ul>' +
      '<div class="gmail_quote">Le lun., Bruno a écrit :<blockquote><div>ancien <blockquote>tres ancien</blockquote></div></blockquote></div></body></html>';
    assert.equal(htmlToText(html), 'Bonjour,\n\n- point 1\n- été');
  });
});

describe('citations en cascade', () => {
  test('lignes > retirees, attribution FR et EN coupe le reste', () => {
    assert.equal(stripQuotes('Ok pour moi.\n\nLe lun. 3 nov. 2026 à 10:00, Bruno <bruno@example.com> a écrit :\n> ancien\n> texte'), 'Ok pour moi.');
    assert.equal(stripQuotes('Fine.\nOn Mon, Nov 3, 2026 at 10:00 AM Bruno <bruno@example.com> wrote:\n> old'), 'Fine.');
    assert.equal(stripQuotes('Voir ci-dessous.\n> cite\nsuite propre'), 'Voir ci-dessous.\nsuite propre');
  });
  test('attribution repliee sur deux lignes', () => {
    assert.equal(stripQuotes('Merci.\n\nLe lun. 3 nov. 2026 à 10:00, Bruno Petit <bruno@example.com> a\nécrit :\n\n> ancien'), 'Merci.');
  });
  test('Outlook : separateur et bloc De/Envoye', () => {
    assert.equal(stripQuotes('Valide.\n-----Original Message-----\nFrom: x'), 'Valide.');
    assert.equal(stripQuotes('Valide.\n\nDe : Bruno Petit\nEnvoyé : lundi 3 novembre\nObjet : budget\n\nancien'), 'Valide.');
  });
  test('un transfert n est pas coupe', () => {
    const fwd = 'Pour info.\n\n---------- Forwarded message ---------\nFrom: Carla <carla@example.com>\nDate: lun. 3 nov. 2026\nSubject: Devis\n\nLe devis final est joint.';
    assert.equal(stripQuotes(fwd), fwd);
  });
});

describe('signatures', () => {
  test('courte : gardee ; longue : tronquee apres 4 lignes, mention du reste', () => {
    assert.equal(trimSignature('Texte\n-- \nAlice\nCheffe de projet'), 'Texte\n-- \nAlice\nCheffe de projet');
    const long = 'Texte\n-- \nAlice Martin\nCheffe de projet\nAcme\n+33 1 00 00 00 00\nCe message est confidentiel.\nMerci de penser a la planete.';
    assert.equal(trimSignature(long), 'Texte\n-- \nAlice Martin\nCheffe de projet\nAcme\n+33 1 00 00 00 00\n[signature tronquee : 2 ligne(s) retiree(s)]');
  });
  test('cleanBody : citations puis signature', () => {
    assert.equal(cleanBody('Go.\n-- \nA\n\n> vieux'), 'Go.\n-- \nA');
  });
});
