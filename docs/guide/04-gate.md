# 4. La gate

[← Sommaire](README.md)

Toute page entre dans l'or par le même chemin, que la session l'écrive en ingestion, en synthèse ou en correction.

```
 .candidats/wiki/<D>/<dossier>/<slug>.md
          │
          │ kioku check <fichiers>          déterministe, sans modèle : format, frontmatter, provenance (raw:
          ▼                                 existant, fiche argent), pas de lien Markdown, pas de secret,
   conforme ?  ── non ──► refusée           pas de lien vers un autre domaine
          │ oui                (on corrige)
          ▼
   agent reviewer                           un appel distinct du rédacteur ; lit la page seule, le socle
   verdict ok | hold <code>                 commun et domains/<D>/rules.md ; verdict lié au sha256 exact
          │                                 et au domaine
          ▼
 kioku promote <fichiers>
    ├── ok   ──► wiki/<D>/…  avec  gate: passe <date> juge=relecteur
    ├── hold ──► quarantine/<D>/  (retenue : vous décidez)
    └── aucun verdict pour CETTE version ──► rien n'entre
```

## Les codes de retenue

| Code | Sens |
|---|---|
| `insulte` | propos insultant |
| `jugement-personne` | trait ou portrait d'une personne, retour non attribué présenté comme un fait |
| `diffamation` | accusation présentée comme un fait |
| `domaine` | contenu d'un autre domaine |
| `sensible` | donnée que les règles du domaine disent sensible |

## La frontière : retour de travail contre portrait

**Passe** : un fait daté ; une attente exprimée ; un **retour de travail attribué**, s'il remplit quatre conditions :

1. il porte sur la conduite professionnelle ou les résultats ;
2. il est attribué et daté, avec sa source ;
3. c'est une observation sur une situation, pas un trait permanent ;
4. il n'est pas assemblé en portrait.

> « Selon Alice, le 10/03, la livraison du module a glissé d'une semaine faute de recette. » — passe.
> « Bruno est lent. » — retenu (trait).
> Une liste de faits anodins qui, mise bout à bout, dessine un profil — retenu (portrait par assemblage).

**Dans le doute, on retient** : vous tranchez au lint, et votre décision peut devenir une règle du domaine.

## Bon à savoir

- **Toute modification annule le verdict.** Le verdict est lié au contenu exact ; une page modifiée après relecture doit être relue.
- **Le verdict appartient à un domaine.** Un verdict rendu pour `perso` ne permet pas de promouvoir une page `travail`.
- **Si le relecteur ne répond pas, rien n'entre.** On le dit, on ne boucle pas.
- **La ligne `gate:` est posée par `promote`**, jamais à la main.
- `overview.md` est hors gate (écrit en session `ingest`) et relu au lint.

## Ce que la gate ne fait pas

Elle vérifie la **provenance**, pas la **vérité** : une source fausse donne une page fausse, bien sourcée. Le lint garde ce rôle (contradictions, claims périmées). Le relecteur est un autre appel de modèle dans la même session : indépendance de contexte, pas de processus.
