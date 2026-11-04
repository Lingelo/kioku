# 3. Faire entrer une source

[← Sommaire](README.md)

## Deux chemins

```
 A. vous savez le domaine          B. vous ne le savez pas, ou plusieurs sources
 ─────────────────────────         ──────────────────────────────────────────────
 déposer dans raw/<D>/<type>/      déposer dans inbox/
          │                                  │ npm run triage
          │                                  ▼
          │                        rangé dans raw/<D>/<type>/   ou   laissé dans inbox/ (question posée)
          ▼                                  │
 npm run ingest:<D>  ◄───────────────────────┘
```

Types de dossier sous `raw/<D>/` : `meetings`, `articles`, `pdfs`, `transcripts`, `assets`. Nom de fichier en kebab-case ASCII, préfixé de la date ISO : `2026-03-12-revue-budget.md`.

**Le nom de fichier est lu par chaque lien qui le cite** : jamais le nom d'un candidat, d'une personne évaluée ou d'une donnée sensible dans un slug.

## Le tri

`npm run triage` lit `inbox/`, puis pour chaque source décide **un domaine déclaré** ou **s'abstient**. Il s'appuie sur la `description` de chaque domaine dans `kioku.config.json`. Une source mixte, d'une organisation inconnue, ou mêlant vie privée et travail reste dans l'entrant avec la raison : trancher à tort pollue un coffre, ne pas trancher coûte une question.

## L'ingestion

`npm run ingest:<D>` sans argument **ne commence rien** : il liste les sources de `raw/<D>/` qui ne sont pas encore dans l'or et demande lesquelles ingérer. Une ingestion lancée par habitude écrirait dans l'or.

Pour chaque source, trois étages, au complet :

1. **Bronze → argent.** Lecture du brut, fiche `silver/<D>/<slug>.md`. Les locuteurs sont résolus **en hypothèse signalée**. Injures, portraits, retours non attribués et données sensibles ne sont recopiés nulle part : un **pointeur** est posé en quarantaine (`kioku quarantine`), et la fiche garde les faits.
2. **Argent → or.** Depuis la fiche argent, pas depuis le brut : candidates sous `.candidats/wiki/<D>/` : la page `sources/`, la page `meetings/` si c'est une réunion, les décisions (ADR), les entités touchées.
3. **Gate.** `check` → relecteur → `promote`. Voir [4. La gate](04-gate.md).

Puis index et journal mis à jour, et un rapport : pages admises, retenues, contradictions, lacunes.

### Plusieurs sources d'un coup

Elles sont traitées **une par une, dans l'ordre chronologique**, mais la session les garde en tête : la séance de l'après-midi peut confirmer ou contredire celle du matin, et la page le dit. Un seul passage d'index et de journal par journée.

## Quand une page est créée

| Page | Créée si |
|---|---|
| `sources/`, `meetings/` | toujours, pour la source ingérée |
| `decisions/` | une décision est prise dans la source |
| `people/` | la personne est **centrale** à la source **ou** nommée dans **au moins deux sources** ; identité donnée par la source, jamais déduite d'un prénom ou d'un « Speaker 1 » |
| `concepts/` | la notion est centrale **ou** citée dans au moins deux sources ; pas de terme générique, pas de doublon |

Sinon, le lien reste vers une page inexistante : c'est une **lacune voulue**, pas une anomalie. Les règles du domaine peuvent restreindre davantage.

## Modifier une page déjà dans l'or

Pas de réécriture à la main : `kioku stage <D> <dossier/slug>` (session `ingest` du domaine) copie la page sous `.candidats/`, sans sa ligne `gate:`. On la modifie là, et elle repasse la gate.

## Ce qui n'est jamais fait

- Ranger une source dans un domaine « pour aller vite ».
- Réécrire un brut.
- S'arrêter après avoir écrit les candidates : une ingestion n'est finie que lorsque les pages sont dans l'or (ou en quarantaine) et que l'index et le journal sont à jour.
