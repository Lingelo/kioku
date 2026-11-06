/**
 * L'organisation d'une source, proposee par le tri et montree avant l'ingestion (CLAUDE.md §5.5, plan pro-org-structure R16).
 *
 * Le tri connait les domaines par la configuration du coffre (kioku.config.json) et l'employeur et les clients par le
 * registre que declare l'extension org d'un domaine, jamais par des noms ecrits ici. Pour chaque source rangee dans ce
 * domaine, il ecrit une ligne `ORG <chemin relatif a raw/<domaine>/> : a,b`. run.mjs les lit, les affiche a la
 * confirmation et les passe a l'ingestion, qui garde le dernier mot. Rien n'est conserve entre deux lancements : une
 * reprise --skip-fetch n'a pas de proposition et l'ingestion decide seule.
 *
 * Un seul domaine porte la proposition d'organisation : le premier a extension org (`pro` aujourd'hui). Un second
 * domaine a extension org garde son attribut a la gate, mais le tri ne lui propose rien.
 */

import { loadOrgs } from '../../hooks/orgs.mjs';
import { skill } from '../names.mjs';
import { loadConfig } from '../vault-config.mjs';

/** Le domaine dont le tri propose l'organisation, et son registre ; null si aucun domaine n'a l'extension. */
export const orgTarget = (vault) => {
  const cfg = loadConfig(vault);
  const domain = cfg.domains.find((d) => cfg.orgRegistry(d));
  return domain ? { domain, registry: cfg.orgRegistry(domain) } : null;
};

/** La liste des organisations, telle que le prompt du tri la cite. */
export const describeOrgs = (reg) => {
  const employer = reg.orgs.find((o) => o.id === reg.employer);
  const clients = reg.clients.map((o) => `${o.name} [${o.id}]${o.status === 'past' ? ' (mission passee)' : ''}`);
  return `employeur ${employer.name} [${employer.id}]` + (clients.length ? ` ; clients ${clients.join(', ')}` : '');
};

/** Le choix offert au tri : chaque domaine, avec sa description de la configuration quand elle existe. */
const describeDomains = (domains) => domains.map((d) => (d.description ? `${d.id} (${d.description.replace(/[;"]/g, ',')})` : d.id)).join(', ');

/**
 * Le prompt du tri : une seule ligne (cmd.exe), sans guillemets. La session est non interactive : une question
 * poserait dans le vide. Sans decision explicite, au moindre doute elle parque la source et dit pourquoi.
 *
 * @param {object|null} reg - registre du domaine a extension org (null : aucun domaine ne l'a)
 * @param {string[]} paths - sources de l'entrant
 * @param {{file: string, domain: string}[]} decisions - decisions explicites de l'utilisateur
 * @param {{domains: {id: string, description?: string}[], orgDomain: string|null}} scope - domaines de la configuration
 */
export const triagePrompt = (reg, paths, decisions, scope) => {
  const { domains, orgDomain } = scope;
  const ids = domains.map((d) => d.id);
  return (
    `${skill('triage')} ${paths.join(' ')} ; session non interactive, personne ne repondra : decide seul le domaine sur le contenu, ` +
    `parmi ${describeDomains(domains)}` +
    (reg && orgDomain
      ? ` (${orgDomain} = le travail chez l'employeur ou un client du registre des organisations : ${describeOrgs(reg)} ; ` +
        `une mission de l'employeur chez un autre client, connue par l'employeur, est aussi du ${orgDomain} et releve de l'employeur)`
      : '') +
    `. Au moindre doute (organisation sans lien avec les domaines, source mixte, donnee sensible) ne range pas : deplace le fichier vers inbox/a-trancher/ avec mv ` +
    `et ecris une ligne ABSTENTION <fichier> : <raison en une phrase, sans recopier de contenu sensible>. ` +
    `Une note SANS CONTENU EXPLOITABLE (test de connexion, fragment d'une phrase, silence, rien qui puisse entrer dans un wiki) : ` +
    `deplace-la de meme vers inbox/a-trancher/ et ecris une ligne VIDE <fichier> : <raison en une phrase> au lieu d'ABSTENTION ; ` +
    `une note courte qui porte une decision, une date ou une action n'est pas vide. Ne supprime jamais rien : l'utilisateur decide de l'ecart. ` +
    (reg && orgDomain
      ? `Pour chaque source rangee en ${orgDomain}, ecris une ligne ORG <chemin relatif a raw/${orgDomain}/> : <identifiants du registre separes par des virgules>. `
      : '') +
    `Ne range que dans raw/<${ids.join('|')}>/. Ne pose aucune question.` +
    (decisions?.length
      ? ` Decisions explicites de l'utilisateur, a appliquer sans t'abstenir et sans renommer le fichier : ` +
        `${decisions.map((d) => `${d.file} -> ${d.domain}${d.orgIds?.length ? ` (organisation ${d.orgIds.join(',')}, a reprendre telle quelle dans sa ligne ORG)` : ''}`).join(' ; ')}.`
      : '')
  );
};

/**
 * Les lignes ORG de la sortie du tri -> Map(chemin -> [ids tries]). Un identifiant hors registre fait ignorer la
 * ligne entiere (avertissement) : une proposition partielle laisserait croire que l'organisation est connue.
 */
export const parseOrgLines = (out, reg, warn = (m) => console.warn(m), orgDomain) => {
  if (!orgDomain) throw new Error('parseOrgLines : domaine a extension org requis');
  const proposals = new Map();
  const rawPrefix = new RegExp(`^raw/${orgDomain}/`);
  for (const m of String(out ?? '').matchAll(/^ORG\s+(\S+)\s*:\s*(.+)$/gm)) {
    const ids = [...new Set(m[2].split(',').map((s) => s.trim()).filter(Boolean))].sort();
    const unknown = ids.filter((id) => !reg.ids.has(id));
    if (!ids.length || unknown.length) {
      warn(`  (proposition d'organisation ignoree pour ${m[1]} : ${unknown.length ? `hors registre ${unknown.join(', ')}` : 'vide'})`);
      continue;
    }
    // La file d'ingestion connait la source par son chemin relatif a raw/<domaine>/, en POSIX : la session a pu ecrire
    // le chemin de son `mv` (raw/<domaine>/…, ./…) ou un antislash (Windows).
    const rel = m[1].replace(/\\/g, '/').replace(/^\.\//, '').replace(rawPrefix, '');
    proposals.set(rel, ids);
  }
  return proposals;
};

/** Ce que l'ecran de confirmation affiche pour une source du domaine a extension org. */
export const orgLabel = (ids) => (ids?.length ? `org: ${ids.join(', ')}` : "org: a decider a l'ingestion");

export { loadOrgs };
