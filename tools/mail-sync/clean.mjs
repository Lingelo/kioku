/**
 * Nettoyage du texte d'un message avant depot : la cascade de citations et les signatures longues.
 *
 * Pourquoi retirer les citations : chaque reponse recopie tout le fil precedent. Garder la cascade multiplierait le
 * meme contenu dans le bronze (et dans le contexte de l'ingestion), et une « suite » recopierait ce qui est deja
 * ingere. Le message cite est deja dans le fil, a sa place : rien n'est perdu.
 *
 * Ce qui est retire :
 *   - les lignes citees (`>` en tete, apres d'eventuels espaces) ;
 *   - a partir d'une ligne d'attribution (« Le … a écrit : », « On … wrote: », y compris repliee sur deux lignes),
 *     tout le reste du message, mais SEULEMENT si rien de non cite ne la suit : une reponse ecrite sous la citation
 *     ou entre ses lignes est gardee (seules les lignes `>` partent) ;
 *   - a partir d'un separateur « -----Original Message----- » ou d'un bloc « De : … Envoyé : … » d'Outlook, tout le
 *     reste : l'ancien message y suit sans marque de citation.
 * Ce qui est garde : un message transfere (« Forwarded message », « Message transféré ») est une information nouvelle
 * pour ce fil, il n'est pas coupe.
 *
 * Signature : apres le delimiteur standard `-- `, au-dela de SIGNATURE_KEEP lignes, le reste est remplace par une
 * mention du nombre de lignes retirees. Les premieres lignes (nom, fonction, organisation) restent : c'est ce qui sert
 * au travail ; les mentions legales et les bannieres, non.
 */

export const SIGNATURE_KEEP = 4;

const ATTRIBUTION = [
  /^(le|on)\s.{0,300}\s(a écrit|a ecrit|wrote)\s*:\s*$/i,
  /^-{2,}\s*(original message|message d'origine|messaggio originale|ursprüngliche nachricht)\s*-{2,}\s*$/i,
];
// Attribution repliee : « Le lun. 3 nov. 2026 à 10:00, Alice <alice@example.com> a » puis « écrit : ».
const ATTRIBUTION_HEAD = /^(le|on)\s.{0,300}$/i;
const ATTRIBUTION_TAIL = /^(.{0,120}\s)?(a écrit|a ecrit|écrit|ecrit|wrote)\s*:\s*$/i;
// Bloc d'en-tetes Outlook cite : « De : … » suivi, dans les 4 lignes, de « Envoyé : » / « Sent: ».
const OUTLOOK_FROM = /^(de|from)\s*:\s*\S/i;
const OUTLOOK_SENT = /^(envoyé|envoye|sent|date)\s*:\s*\S/i;
const FORWARD = /forwarded message|message transf[ée]r[ée]|begin forwarded message|^-{2,}\s*transf/i;

/** Retire la cascade de citations. Rend le texte garde, sans lignes vides en fin. */
export const stripQuotes = (text) => {
  const lines = String(text ?? '').replace(/\r\n/g, '\n').split('\n');
  const kept = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const t = line.trim();
    if (ATTRIBUTION[1].test(t)) break; // separateur « Original Message » : tout ce qui suit est l'ancien message
    // « Le … a écrit : » / « On … wrote: », sur une ligne ou repliee sur deux. On ne coupe que si rien de NON cite ne
    // suit (revue m5) : une reponse ecrite sous la citation, ou entre ses lignes, est du contenu nouveau.
    const folded = ATTRIBUTION_HEAD.test(t) && ATTRIBUTION_TAIL.test((lines[i + 1] ?? '').trim()) && /[<@,]/.test(t);
    if (ATTRIBUTION[0].test(t) || folded) {
      const after = lines.slice(i + (folded ? 2 : 1));
      if (!after.some((l) => l.trim() && !/^\s*>/.test(l))) break;
      // Du texte nouveau suit : la ligne d'attribution part si elle en est vraiment une (une adresse), sinon c'est une
      // phrase du message (« On Monday, the team wrote: ») et elle reste.
      if (/[<@]/.test(t)) {
        if (folded) i++;
        continue;
      }
    }
    // Un bloc De/Date juste sous un marqueur de transfert est l'en-tete du message transfere : il reste.
    const forwarding = kept.slice(-3).some((l) => FORWARD.test(l.trim()));
    if (OUTLOOK_FROM.test(t) && !forwarding && lines.slice(i + 1, i + 5).some((l) => OUTLOOK_SENT.test(l.trim())) && kept.length) break;
    if (/^\s*>/.test(line)) continue;
    kept.push(line);
  }
  while (kept.length && !kept[kept.length - 1].trim()) kept.pop();
  return kept.join('\n');
};

/** Tronque une signature longue (apres `-- `) ; une signature courte reste entiere. */
export const trimSignature = (text, keep = SIGNATURE_KEEP) => {
  const lines = String(text ?? '').split('\n');
  const at = lines.findIndex((l) => l === '-- ' || l === '--');
  if (at < 0) return text;
  const sig = lines.slice(at + 1);
  const nonEmpty = sig.filter((l) => l.trim());
  if (nonEmpty.length <= keep) return text;
  const kept = [];
  let seen = 0;
  for (const l of sig) {
    if (seen >= keep) break;
    kept.push(l);
    if (l.trim()) seen++;
  }
  return [...lines.slice(0, at + 1), ...kept, `[signature tronquee : ${nonEmpty.length - keep} ligne(s) retiree(s)]`].join('\n');
};

/** Le texte d'un message tel qu'il est depose. */
export const cleanBody = (text) => trimSignature(stripQuotes(text)).trim();
