# 7. Dashboard

[← Sommaire](README.md)

Une vue de l'état du coffre : progression du médaillon (bronze relié, argent, gate), file d'actions par criticité, graphe 3D des pages de l'or, mode d'emploi.

## Lancer

| Commande | Effet |
|---|---|
| `npm run dashboard:<D>` | génère un HTML statique (`tools/dashboard/dashboard-<D>.html`) |
| `npm run dashboard:serve:<D>` | serveur local au premier plan, URL affichée ; **Ctrl-C** pour l'arrêter |
| `npm run dashboard:all` | tous les domaines (hors session seulement) |
| `npm run dashboard` · `dashboard:serve` | le premier domaine déclaré |

## Ce que le serveur garantit

- Écoute **uniquement** sur `127.0.0.1`, en-tête `Host` vérifié, aucune lecture inter-origines.
- **Un domaine par processus.** Depuis une session, `all` et les autres domaines sont refusés.
- Le serveur n'écrit rien. Le champ de question lance une session `claude -p` en mode `query`, **sous la garde** : c'est elle qui peut écrire (journal, index, candidates de `/kioku:save`), comme en ligne de commande.

## La file d'actions

Chaque ligne propose une commande à copier.

| Catégorie | Commande proposée |
|---|---|
| Quarantaine, pointeur | `kioku decide <D> <nom> drop` |
| Quarantaine, page retenue ou signalée | `kioku decide <D> <nom>` **sans action** : complétez par `keep`, `correct` ou `drop`. Pas de `drop` par défaut, il supprimerait une page. |
| Candidate en attente | `kioku check …` |
| Bronze sans or | `npm run ingest:<D> -- "/ingest <fichier>"` |
| Anomalies | `npm run audit:<D>` |

## Attention

- **Le HTML généré contient le wiki en clair.** Le motif `tools/dashboard/dashboard-*.html` est dans le bloc géré du `.gitignore` : ne le versionnez pas, ne le partagez pas.
- La vidéo de l'onglet Mode d'emploi n'est pas versionnée ; sans elle, le lecteur est vide.
