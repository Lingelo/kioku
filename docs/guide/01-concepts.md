# 1. Concepts

[← Sommaire](README.md)

## Le médaillon : trois étages

```
 inbox/              raw/<D>/              silver/<D>/             wiki/<D>/
 ┌──────────┐ tri   ┌──────────┐ ingest   ┌──────────┐ gate      ┌──────────┐
 │ entrant  │ ────► │  bronze  │ ───────► │  argent  │ ────────► │    or    │ ◄── on requête ici
 │ (local)  │       │ immuable │          │ 1 fiche  │ check +   │  pages   │
 └──────────┘       └──────────┘          │ / source │ relecteur └──────────┘
   sans domaine       tel qu'entré        └──────────┘                │ retenu
                                           nettoyée                   ▼
                                                                ┌──────────────┐
                                                                │ quarantine/  │ l'utilisateur décide
                                                                └──────────────┘
```

| Étage | Dossier | Rôle |
|---|---|---|
| Entrant | `inbox/` | ce qui n'est pas encore classé. **Jamais versionné** (`.gitignore`) : à trier avant de changer de machine. |
| Bronze | `raw/<D>/{meetings,articles,pdfs,transcripts,assets}/` | la source telle qu'elle est entrée. Personne ne la réécrit. |
| Argent | `silver/<D>/<slug>.md` | une fiche par source : résumée, locuteurs résolus (en hypothèse), passages sensibles retirés. |
| Or | `wiki/<D>/{sources,meetings,people,organizations,projects,concepts,decisions,syntheses}/` | les pages du wiki, avec `index.md`, `log.md`, `overview.md`. |
| Quarantaine | `quarantine/<D>/` | ce que la gate a retenu, ce que le lint a signalé, les passages écartés à l'ingestion. |

## Les domaines (silos)

Un coffre a un ou plusieurs domaines, déclarés dans `kioku.config.json`. Chacun a ses quatre étages, ses règles (`domains/<D>/rules.md`) et son wiki. **Une page ne change jamais de domaine**, et aucun lien ne traverse deux domaines.

Le domaine se décide **une seule fois**, au tri. Au moindre doute, le tri s'abstient et pose la question.

## La garde

Un hook `PreToolUse` du plugin. À chaque appel d'outil de Claude Code (lecture, écriture, commande shell), il compare la cible au **mode** et au **domaine** de la session (`VAULT_MODE`, `VAULT_DOMAIN`, posés par le lanceur), et refuse ce qui sort du périmètre.

- Hors d'un coffre, elle ne s'applique pas : le plugin ne gêne pas vos autres projets.
- Elle filtre les outils de Claude, **pas vos propres commandes** dans un terminal.
- Elle juge le texte des commandes shell, pas leurs effets : elle bloque des formes connues, elle ne sandboxe pas.
- Elle ne se modifie depuis aucune session.

## La gate

Le passage obligé vers l'or. Le rédacteur ne juge pas sa propre page : un **relecteur distinct** rend un verdict lié à l'empreinte exacte (sha256) de la page. Une virgule changée, et le verdict ne vaut plus. Détail : [4. La gate](04-gate.md).

## L'or hérité

Des pages présentes sous `wiki/<D>/` **sans ligne `gate:`** sont de l'or hérité (un wiki existant avant Kioku). Elles se lisent comme les autres ; le lint les sonde par échantillon ; une page héritée que l'on modifie repasse la gate.

## Les fichiers du coffre

```
<coffre>/
├── CLAUDE.md                 identité du coffre, décisions ; importe .kioku/schema.md
├── kioku.config.json         domaines, extensions, modules, format (géré : ne pas éditer en session)
├── .kioku/schema.md          le schéma commun, réécrit à chaque montée de version
├── domains/<D>/rules.md      règles du domaine : Périmètre, Ingestion, Requête, Lint, Relecture
├── package.json              scripts npm (ceux qui commencent par « kioku » sont gérés)
├── raw/<D>/ silver/<D>/ wiki/<D>/ quarantine/<D>/
├── .candidats/wiki/<D>/      pages en attente de la gate
├── .verdicts/                verdicts du relecteur
└── inbox/                    entrant (jamais versionné)
```
