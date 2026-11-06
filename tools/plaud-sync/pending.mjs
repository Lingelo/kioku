#!/usr/bin/env node
/**
 * File d'attente d'ingestion du circuit Plaud : la file commune des connecteurs (tools/connectors/pending.mjs), avec
 * l'etat local de Plaud, `tools/plaud-sync/.snapshot.json` et `.queue.json` dans le coffre vise.
 *
 *   node tools/plaud-sync/pending.mjs snapshot | queue | list | add <domaine> <chemin relatif>
 *
 * Outil interne du circuit : le CLI ne le relaie pas. Cote utilisateur, `add` passe par `kioku plaud --requeue`.
 * L'emplacement de l'etat est celui des coffres existants (modules.plaud.state = tools/plaud-sync). Voir l'en-tete du
 * module commun.
 */

import { runPending } from '../connectors/pending.mjs';

const PLAUD_STATE = 'tools/plaud-sync';

process.exit(runPending(process.argv.slice(2), { state: PLAUD_STATE, connector: 'plaud' }));
