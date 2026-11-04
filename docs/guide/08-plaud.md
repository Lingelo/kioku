# 8. Plaud

[← Sommaire](README.md)

Module optionnel (`modules.plaud` dans `kioku.config.json`, posé par `kioku init --plaud`). Il fait entrer les notes d'un enregistreur Plaud dans le coffre, en une commande.

## Une fois par machine

```bash
npx -y @plaud-ai/mcp@latest      # OAuth dans le navigateur ; le jeton reste dans ~/.plaud/
```

Le circuit ne lit aucun jeton lui-même : l'authentification est déléguée au MCP officiel.

## Le circuit

```
 npm run plaud:sync
   1. dépôt      notes Plaud des 7 derniers jours → inbox/   (déjà vues ou exclues : ignorées)
   2. tri        session triage : rangé dans raw/<D>/  ou  parqué dans inbox/a-trancher/ (raison écrite)
   3. confirmation   liste de ce qui va entrer dans l'or, PAR DOMAINE → « oui » attendu (Entrée = non)
   4. ingestion  une session ingest par source (ou par journée avec --group-by-day), gate comprise
   5. rapport    ingérées / pas entrées (à reprendre) / à trancher / à décider (quarantaine)
```

**La confirmation de l'étape 3 est le dernier moment** où une erreur de domaine se corrige sans effort : après, la source est dans le wiki du mauvais domaine.

Lancé **par vous, jamais planifié**, depuis le checkout principal du coffre (`inbox/` n'est pas versionné ; refus dans un worktree sauf `--allow-worktree`).

## Commandes

| Commande | Effet |
|---|---|
| `npm run plaud:sync` | circuit complet, 7 derniers jours |
| `npm run plaud:sync -- --since 2026-03-01` | depuis une date |
| `npm run plaud:dry-run` | montre ce qui serait déposé ; aucune session |
| `npm run plaud:pending` | tri + ingestion de ce qui est déjà dans l'entrant ou la file (`--skip-fetch`) |
| `npm run plaud:sync -- --group-by-day` | une session par journée et par domaine : les séances d'un même jour se recoupent |
| `npm run plaud:sync -- --skip <id>` | écarte un enregistrement pour de bon |
| `npm run plaud:sync -- --yes` | ingère sans demander (requis sans terminal) |

## Les sources parquées (`inbox/a-trancher/`)

Le tri s'abstient au moindre doute. Lisez `inbox/a-trancher/_raisons.md` et les fichiers **dans votre éditeur**, hors session (aucune session `query` ne lit l'entrant). Puis :

| Issue | Commande |
|---|---|
| ranger dans un domaine | `kioku plaud --skip-fetch --decide <fichier>=<D>` |
| écarter pour de bon | `npm run plaud:drop -- <fichier>` |
| laisser pour plus tard | rien |

## Exclure un enregistrement à la source

Ajoutez son identifiant `of_…` à `tools/plaud-sync/exclusions.txt`, avec un commentaire : il ne sera jamais déposé.

## Codes de sortie

`0` tout est rangé et ingéré ; `2` il reste des sources à reprendre ou à trancher ; `1` erreur.
