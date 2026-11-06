# connectors

Le socle commun aux **modules de capture** : ce qui ne dépend pas de la source (enregistreur, boîte mail…). Un connecteur dépose des sources dans `inbox/` ; tout le reste — tri, confirmation, ingestion, rapport, verrou — est ici, une seule fois.

```
 connecteur (Plaud, …)            socle (tools/connectors/)
 ┌───────────────────┐   ┌──────────────────────────────────────────────────────────────┐
 │ fetch → inbox/    │──►│ verrou ─► tri (claude -p, triage, peut s'abstenir)           │
 │ drop  → registre  │   │          ├─► raw/<D>/  ─► file (.queue.json)                 │
 │ state : tools/<x> │   │          └─► inbox/a-trancher/ (parqué, raison)              │
 │ commandes citées  │   │       ─► confirmation « oui » par domaine                    │
 └───────────────────┘   │       ─► une session ingest par source (relances, reprise)   │
                         │       ─► rapport calculé sur les fichiers (page or = ingérée)│
                         └──────────────────────────────────────────────────────────────┘
```

## Fichiers

| Fichier | Rôle |
|---|---|
| `circuit.mjs` | `runCircuit(connector)` : la boucle tri → confirmation → ingestion → rapport, options communes (`--skip-fetch`, `--decide`, `--drop`, `--yes`, `--group-by-day`, `--retries`…) |
| `lock.mjs` | verrou du coffre, **un seul pour tous** les circuits de capture et pour `rotate-log`, `tag-org`, `tag-raw`, `upgrade --write`, `add-domain` |
| `pending.mjs` | file d'ingestion (`--state <dossier>` : l'état local du connecteur) |
| `parked.mjs` | `inbox/a-trancher/` : parquer, raisons, écart pour de bon via le registre du connecteur |
| `dedup.mjs` | primitives : empreinte sans frontmatter, identifiant en frontmatter, dossiers parcourus, registre JSON |
| `triage.mjs` | prompt du tri et propositions d'organisation (extension org) |

## Un connecteur

```js
await runCircuit({
  state: 'tools/<nom>',               // état local, relatif au coffre (file d'ingestion)
  fetch: ({ argv, dryRun, node, fail, title }) => { /* dépose dans inbox/, sans domaine */ },
  drop: (vault, file) => ({ ok, id, registered } | { ok: false, reason }),
  commands: { run, pending, drop, registry },   // ce que les messages citent à l'utilisateur
});
```

**À qui appartient une source** (`owners.mjs`) : chaque connecteur marque ses dépôts d'un champ de frontmatter (Plaud : `plaud_id:`). Un circuit ne trie, ne parque et ne met en file que ses propres sources (`id` du connecteur) ; celles d'un autre circuit restent dans l'entrant et sont nommées au rapport. Une source sans marque (déposée à la main) reste à Plaud, comme avant le socle.

Ce que le connecteur décide seul : quel identifiant fait foi pour la déduplication, son registre, ses options propres (Plaud : `--since`, `--skip`). Ce qu'il ne décide jamais : le domaine. Le tri juge sur le contenu ; un indice venu de la configuration reste un indice.

## Verrou : transition

Chemin canonique : `tools/connectors/.lock.json` (ignoré, comme le miroir et l'état de tout connecteur, par le motif `tools/*/` du bloc géré du `.gitignore` ; `kioku upgrade --write` le pose dans un coffre existant). L'ancien `tools/plaud-sync/.lock.json` est **pris aussi**, en miroir, tant que :

- un processus d'une version antérieure du core peut tourner (un `run.mjs` en pleine ingestion pendant la mise à jour du plugin, un checkout de développement) : il ne connaît que l'ancien fichier ;
- le tableau de bord lit l'ancien fichier (`tools/dashboard/local-state.mjs`).

Prise : canonique d'abord, ancien ensuite ; un échec au second rend le premier. Deux essais sans attente : pas d'interblocage possible. Verrou d'un processus mort, tronqué ou sans PID : repris tout seul.

## Tests

```
node --test tools/connectors/*.test.mjs
```

Le déroulé complet passe aussi par `tools/plaud-sync/*.test.mjs`, qui lancent `run.mjs`, donc ce circuit.
