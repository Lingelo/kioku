# 2. Sessions

[← Sommaire](README.md)

Une session est un `claude` lancé dans le coffre avec un **mode** et un **domaine**. On ne la lance jamais à nu : le lanceur pose les deux variables que la garde lit, puis démarre la session sur la tâche du mode.

## Ouvrir une session

| Commande | Mode / domaine | Démarre sur |
|---|---|---|
| `npm run travail` | query / travail | votre question |
| `npm run ingest:travail` | ingest / travail | `/kioku:ingest` (liste ce qui reste à ingérer) |
| `npm run lint:travail` | query / travail | `/kioku:lint travail` |
| `npm run triage` | triage (sans domaine) | `/kioku:triage` |
| `npm run setup` | setup (sans domaine) | `/kioku:setup` |
| `npm run vault` | query, domaine demandé | votre question |

Ces scripts appellent `kioku session …`. Options utiles, après `--` :

```bash
npm run travail -- "qu'a-t-on décidé sur le budget ?"   # la question part avec la session
npm run ingest:travail -- meetings/2026-03-12-revue.md  # /kioku:ingest sur ce fichier
kioku session travail -- --resume                       # reprendre une session (passé à claude)
```

## Ce que chaque mode voit

| Mode | Lit | Écrit |
|---|---|---|
| **query** | `wiki/<D>/` | `.candidats/wiki/<D>/`, `wiki/<D>/index.md` et `log.md` |
| **ingest** | `raw/<D>/`, `silver/<D>/`, `wiki/<D>/`, `.candidats/wiki/<D>/` | `silver/<D>/`, `.candidats/wiki/<D>/`, `wiki/<D>/{index,log,overview}.md` |
| **triage** | `inbox/` | `mv` vers `raw/<D>/` |
| **setup** | configuration, `domains/` | rien en direct : `kioku init`, `kioku add-domain`, `kioku upgrade` |

Dans **aucun** mode : un autre domaine, `quarantine/`, `.verdicts/`, la configuration, l'historique git (`git show`, `git log -p`, `git diff`… : il contient tous les domaines).

## Changer de domaine

On ne change pas de domaine en cours de session. `/exit`, puis `npm run perso`. Une question posée dans le mauvais domaine reçoit une réponse de deux lignes : le domaine visé et la commande de relance, sans rien de son contenu.

## Pièges

- **Ne jamais exporter `VAULT_MODE` ou `VAULT_DOMAIN` dans votre shell.** La garde se remettrait en marche hors coffre et refuserait tout dans vos autres projets. Laissez le lanceur les poser.
- **Lancer `claude` à nu dans le coffre** ouvre la session par défaut (`default_session` de la configuration, en général `query` sur le premier domaine). Préférez les scripts npm, qui disent ce qu'ils ouvrent.
- **Un refus de la garde n'est pas une panne.** C'est la règle qui s'applique. Si elle bloque à tort, voir [10. Dépannage](10-depannage.md).
