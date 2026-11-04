# Guide d'utilisation de Kioku

Ce guide décrit l'usage **quotidien** d'un coffre Kioku : ouvrir une session, faire entrer une source, interroger le wiki, relire et décider, mettre à jour. L'installation et la création d'un coffre sont dans le [README](../../README.md) ; ce guide part d'un coffre qui existe et dont `kioku doctor` passe.

Les exemples utilisent deux domaines fictifs, `travail` et `perso`. Remplacez-les par ceux de votre `kioku.config.json`.

## Les pages

| Page | Pour |
|---|---|
| [1. Concepts](01-concepts.md) | le médaillon, les domaines, la garde, la gate, en une page |
| [2. Sessions](02-sessions.md) | ouvrir le coffre sur un domaine et un mode ; ce que chaque mode voit |
| [3. Faire entrer une source](03-ingerer.md) | l'entrant, le tri, l'ingestion bronze → argent → or |
| [4. La gate](04-gate.md) | `check`, relecteur, `promote` ; ce qui passe, ce qui est retenu |
| [5. Interroger le wiki](05-interroger.md) | poser une question, filer une synthèse |
| [6. Relire et décider](06-lint-quarantaine.md) | le lint, la quarantaine, les décisions |
| [7. Dashboard](07-dashboard.md) | l'état du coffre dans un navigateur local |
| [8. Plaud](08-plaud.md) | la capture de réunions, de l'enregistreur au wiki |
| [9. Mettre à jour Kioku](09-mise-a-jour.md) | nouvelle version du plugin, `kioku upgrade`, nouvelle machine |
| [10. Dépannage](10-depannage.md) | un refus de la garde, une gate qui bloque, un plugin qui ne démarre pas |
| [Aide-mémoire](aide-memoire.md) | toutes les commandes sur une page |

## La journée type

```
 matin        npm run plaud:sync            réunions de la veille → entrant → tri → confirmation → or
              (ou)  déposer un fichier dans inbox/ → npm run triage → npm run ingest:travail

 au fil       npm run travail               « qu'a-t-on décidé sur X ? »  → réponse sourcée, depuis l'or
 de l'eau                                   /kioku:save si la réponse mérite de rester

 en fin       npm run lint:travail          liens cassés, orphelines, ancien fonds, quarantaine à trancher
 de semaine   npm run dashboard:serve:travail   vue d'ensemble, graphe, questions depuis le navigateur
```

## Trois règles à garder en tête

1. **Une session = un domaine.** Pour passer de `travail` à `perso`, on ferme et on relance. La garde le tient, pas une consigne.
2. **On ne lit que l'or.** Une question à laquelle le wiki ne répond pas est une source à ingérer, pas une recherche dans le brut.
3. **Rien n'entre dans l'or sans la gate.** Ni vous, ni la session ne posez une page directement sous `wiki/`.
