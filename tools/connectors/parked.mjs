/**
 * Les sources parquees d'un circuit de capture : `inbox/a-trancher/`, et leurs raisons dans `_raisons.md`.
 *
 * Le tri s'abstient au moindre doute : la source ne va dans aucun domaine, elle attend l'utilisateur ici (local, jamais
 * versionne, comme inbox/). Ce dossier est commun a tous les connecteurs : une source parquee ne dit pas d'ou elle vient,
 * c'est son identifiant en frontmatter (`plaud_id:`, …) qui le dit, et c'est le connecteur qui sait le lire.
 *
 * Ecarter pour de bon (`dropParkedWith`) : supprimer le fichier ne suffit pas, la deduplication du connecteur ne
 * reconnait une source que par son registre ou par un fichier present. Sans trace, le fetch suivant la redepose. On
 * consigne donc son identifiant comme « ecarte » dans le registre du connecteur, puis on supprime le fichier et sa
 * ligne de _raisons.md.
 *
 * Ordre : registre d'abord, fichier ensuite. Un arret entre les deux laisse un fichier deja consigne, qu'une relance
 * supprime ; l'ordre inverse laisserait une source supprimee mais non consignee, donc redeposee.
 * Sans identifiant (depot anterieur au registre), on refuse et on ne touche a rien : la source reviendrait.
 * Ce module lit un identifiant, jamais un contenu a afficher.
 */

import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export const inboxDir = (vault) => path.join(vault, 'inbox');
export const parkedDir = (vault) => path.join(inboxDir(vault), 'a-trancher');
export const reasonsPath = (vault) => path.join(parkedDir(vault), '_raisons.md');

/** Les sources .md d'un dossier (pas les fichiers `_…` comme _raisons.md) ; dossier absent : aucune. */
export const mdIn = (dir) => (existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.md') && !f.startsWith('_')) : []);

/** Consigne la raison d'un parcage : `- <fichier> (<date>) : <raison>`. */
export const logReason = (vault, file, reason, today = new Date().toISOString().slice(0, 10)) => {
  mkdirSync(parkedDir(vault), { recursive: true });
  appendFileSync(reasonsPath(vault), `- ${file} (${today}) : ${reason}\n`);
};

/**
 * Le fichier compagnon d'une fiche : `x.pdf.md` -> `x.pdf` (la source reelle, a cote de sa fiche). Une fiche dont le
 * nom n'a pas d'extension interne (`x.md`, toute note Plaud) n'en a pas : null.
 */
export const companionOf = (file) => {
  const base = file.endsWith('.md') ? file.slice(0, -3) : null;
  return base && /\.[A-Za-z0-9]{1,8}$/.test(base) ? base : null;
};

/** Parque une source de l'entrant (parquer ne classe rien) et consigne pourquoi. Son compagnon la suit. */
export const park = (vault, file, reason) => {
  mkdirSync(parkedDir(vault), { recursive: true });
  renameSync(path.join(inboxDir(vault), file), path.join(parkedDir(vault), file));
  const companion = companionOf(file);
  if (companion && existsSync(path.join(inboxDir(vault), companion))) renameSync(path.join(inboxDir(vault), companion), path.join(parkedDir(vault), companion));
  logReason(vault, file, reason);
};

/**
 * Les lignes `VIDE <fichier> : <raison>` de la sortie du tri -> Map(fichier -> raison), dans l'ordre de la sortie.
 * Seuls les fichiers de `parkedFiles` (noms de inbox/a-trancher/, deja filtres par l'appelant) sont retenus : un nom
 * invente par la session, un fichier range dans un domaine ou reste dans l'entrant n'est jamais propose a l'ecart.
 * La session peut ecrire le chemin de son `mv` (a-trancher/x.md, inbox/a-trancher/x.md) : seul le nom compte.
 * (Venu de main, PR 11, pour le circuit Plaud ; commun aux connecteurs.)
 */
export const parseEmptyLines = (out, parkedFiles) => {
  const parked = new Set(parkedFiles);
  const empties = new Map();
  for (const m of String(out ?? '').matchAll(/^VIDE\s+(\S+)\s*:\s*(.+)$/gm)) {
    const file = path.basename(m[1].replace(/\\/g, '/'));
    if (parked.has(file) && !empties.has(file)) empties.set(file, m[2].trim());
  }
  return empties;
};

/**
 * Apres le tri : un compagnon reste dans l'entrant alors que sa fiche en est sortie -> il la rejoint. `placed` : les
 * chemins (relatifs au coffre) des fiches rangees par ce tri ; une fiche parquee est cherchee dans inbox/a-trancher/.
 * Un fichier dont la fiche est introuvable reste ou il est, sans bruit (un depot manuel). Rend les lignes a afficher.
 */
export const followStubs = (vault, placed = []) => {
  const lines = [];
  // L'entrant, puis inbox/a-trancher/ : une fiche parquee tranchee par --decide quitte a-trancher/ par le tri, et
  // son PDF doit la suivre aussi (revue m4).
  for (const [from, parked] of [[inboxDir(vault), false], [parkedDir(vault), true]]) {
    if (!existsSync(from)) continue;
    for (const f of readdirSync(from, { withFileTypes: true })) {
      if (!f.isFile() || f.name.endsWith('.md') || f.name.startsWith('.')) continue;
      const stub = `${f.name}.md`;
      if (existsSync(path.join(from, stub))) continue; // fiche encore la : elle sera parquee (ou tranchee) avec lui
      const target = placed.find((p) => path.basename(p) === stub);
      const dir = target ? path.dirname(path.join(vault, target)) : !parked && existsSync(path.join(parkedDir(vault), stub)) ? parkedDir(vault) : null;
      // Sans fiche connue : un fichier depose a la main (un PDF a trier par /triage), pas un compagnon. On n'y touche pas.
      if (!dir) continue;
      if (existsSync(path.join(dir, f.name))) continue;
      renameSync(path.join(from, f.name), path.join(dir, f.name));
      lines.push(`  compagnon ${f.name} -> ${path.relative(vault, dir).split(path.sep).join('/')}/`);
    }
  }
  return lines;
};

/**
 * Retire de _raisons.md les lignes `- <fichier> (date) : …` dont le fichier n'est plus parque (tranche par --decide,
 * ou deplace a la main). Les autres lignes restent. Rend le nombre de lignes retirees.
 */
export const pruneReasons = (vault) => {
  const reasons = reasonsPath(vault);
  if (!existsSync(reasons)) return 0;
  const lines = readFileSync(reasons, 'utf8').split('\n');
  const kept = lines.filter((l) => {
    const file = l.match(/^- (\S+\.md) \(/)?.[1];
    return !file || existsSync(path.join(parkedDir(vault), file));
  });
  if (kept.length !== lines.length) writeFileSync(reasons, kept.join('\n'));
  return lines.length - kept.length;
};

/**
 * Ecarte une source parquee. Le connecteur fournit :
 *   idOf(text)      -> son identifiant lu dans le frontmatter, ou null
 *   register(id)    -> le consigne « ecarte » dans son registre ; rend true si le registre a change
 *   noId            -> la raison du refus quand l'identifiant manque (elle nomme le champ attendu)
 * Rend { ok: true, id, registered } ou { ok: false, reason }.
 */
export const dropParkedWith = (vault, file, { idOf, register, noId }) => {
  // Un nom de fichier, pas un chemin : rien ne sort de inbox/a-trancher/.
  if (!file || file !== path.basename(file) || !file.endsWith('.md') || file.startsWith('_')) {
    return { ok: false, reason: `nom invalide (attendu : un fichier .md de inbox/a-trancher/, sans chemin)` };
  }
  const abs = path.join(parkedDir(vault), file);
  if (!existsSync(abs)) return { ok: false, reason: 'absent de inbox/a-trancher/' };
  const id = idOf(readFileSync(abs, 'utf8'));
  if (!id) return { ok: false, reason: noId };

  const registered = register(id);
  rmSync(abs);
  const companion = companionOf(file);
  if (companion) rmSync(path.join(parkedDir(vault), companion), { force: true });
  const reasons = reasonsPath(vault);
  if (existsSync(reasons)) {
    const lines = readFileSync(reasons, 'utf8').split('\n');
    const kept = lines.filter((l) => !l.startsWith(`- ${file} (`));
    if (kept.length !== lines.length) writeFileSync(reasons, kept.join('\n'));
  }
  return { ok: true, id, registered };
};
