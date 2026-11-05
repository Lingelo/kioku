#!/usr/bin/env node
/**
 * Plaud -> coffre, en une commande (Windows, macOS, Linux : Node seulement) :
 * depot dans l'entrant, tri, ingestion bronze -> argent -> or, rapport.
 *
 * Depuis le coffre, par le CLI : `kioku plaud [options]` (relaie `node <core>/tools/plaud-sync/run.mjs --vault . [options]`).
 * Les messages de ce script citent toujours la forme `kioku plaud` : run.mjs n'existe pas dans le coffre.
 *
 *   kioku plaud                         depuis 7 jours
 *   kioku plaud --since 2026-09-14
 *   kioku plaud --dry-run               montre ce qui serait depose, ne lance aucune session
 *   kioku plaud --skip <id Plaud>       ecarte un enregistrement (repetable) : consigne dans seen.json, jamais redepose
 *   kioku plaud --skip-fetch            tri + ingestion de ce qui est deja dans l'entrant / la file
 *   kioku plaud --group-by-day          une session par JOURNEE et par domaine, au lieu d'une par source :
 *                                       les seances d'un meme jour se recoupent et l'index n'est relu qu'une fois
 *   kioku plaud --allow-worktree        accepte de tourner dans un worktree git
 *   kioku plaud --init-structure        donne a chaque domaine declare le meme squelette : les 8 dossiers
 *                                       (un .gitkeep si vide) et overview.md s'il manque. Aucun contenu de page.
 *   kioku plaud --skip-fetch --decide <fichier-de-l-entrant>=<domaine>[:<org>,<org>]
 *                                       tranche une source que le tri avait laissee (repetable) :
 *                                       la decision de l'utilisateur est transmise a la session de tri,
 *                                       qui range sans s'abstenir. Le script ne deplace rien lui-meme.
 *                                       `:<org>` (domaine a extension org, registre seulement) impose
 *                                       l'organisation montree a la confirmation et passee a l'ingestion.
 *   kioku plaud --drop <fichier-de-a-trancher>
 *                                       ecarte pour de bon une source parquee (repetable) : son plaud_id
 *                                       passe « ecarte » dans seen.json, le fichier et sa raison sont
 *                                       supprimes. Ni fetch, ni session. Refus si pas de plaud_id.
 *   kioku plaud --requeue <domaine> <chemin relatif a raw/<domaine>/>
 *                                       remet en file une source deplacee a la main vers un autre domaine
 *                                       (apres un refus a la confirmation). Ni fetch, ni session.
 *   kioku plaud --yes                   ingere sans demander ; requis sans terminal
 *   kioku plaud --retries <n>           relances d'une ingestion qui echoue (defaut 1, 0 = aucune)
 *   kioku plaud --retry-delay <s>       attente avant chaque relance, en secondes (defaut 30)
 *   node <core>/tools/plaud-sync/run.mjs --vault <dossier>
 *                                       vise un autre coffre (ex. depuis un worktree). Via `kioku plaud`, --vault
 *                                       est deja pose a `.` et gagne : changer de dossier courant a la place.
 *
 * Les notes que le tri dit sans contenu (ligne VIDE : test de connexion, fragment) sont parquees comme les indecis,
 * puis proposees a l'ecart (Entree = non). Ni --yes ni l'absence de terminal n'ecartent rien : l'ecart est irreversible.
 *
 * Le circuit lui-meme (tri, confirmation, ingestion avec relances, rapport, verrou) est commun aux connecteurs :
 * tools/connectors/circuit.mjs, dont l'en-tete dit le detail. Ce fichier n'apporte que ce qui est propre a Plaud :
 * le depot dans inbox/ (fetch-notes.mjs, MCP officiel), --since / --skip, l'ecart par seen.json, et son dossier
 * d'etat tools/plaud-sync/ (modules.plaud.state des coffres existants : il ne bouge pas).
 * Code de sortie : 0 tout est range et ingere ; 2 il reste des sources a reprendre ou a trancher ; 1 erreur.
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runCircuit } from '../connectors/circuit.mjs';
import { dropParked } from './drop.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FETCH = path.join(HERE, 'fetch-notes.mjs');

/** Le connecteur Plaud, tel que le circuit commun le consomme. */
const plaudConnector = {
  state: 'tools/plaud-sync',
  // Depot dans l'entrant (sans domaine : rien n'est classe ici). L'authentification est celle du MCP, jamais lue ici.
  fetch: ({ argv, dryRun, node, fail, title }) => {
    const i = argv.indexOf('--since');
    const since = (i >= 0 ? argv[i + 1] : undefined) ?? new Date(Date.now() - 7 * 86_400_000).toISOString().slice(0, 10);
    title(`Plaud -> inbox (depuis ${since})`);
    const skips = argv.flatMap((a, j) => (a === '--skip' ? ['--skip', argv[j + 1] ?? ''] : []));
    const r = node(FETCH, ['--since', since, ...skips, ...(dryRun ? ['--dry-run'] : [])]);
    if (r.status !== 0) fail('fetch-notes a echoue (voir ci-dessus). Premiere connexion : npx -y @plaud-ai/mcp@latest');
  },
  drop: dropParked,
  commands: {
    run: 'kioku plaud',
    drop: 'kioku plaud --drop <fichier> [<fichier>...]',
    registry: 'seen.json',
  },
};

await runCircuit(plaudConnector);
