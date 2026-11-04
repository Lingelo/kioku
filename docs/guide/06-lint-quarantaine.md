# 6. Relire et décider

[← Sommaire](README.md)

## Le lint

`npm run lint:<D>` ouvre une session `query` sur `/kioku:lint <D>`. Rien ne change sans votre accord explicite.

1. **Audit déterministe** (`kioku audit <D>`, gratuit) : pages sans frontmatter, type ≠ dossier, liens cassés, orphelines, liens vers un autre domaine, pages hors index, entrées d'index fantômes ; `org-absent`, `org-union` pour un domaine à extension `org`.
2. **Journal** : si des mois révolus traînent dans `log.md`, la session **propose** la rotation (`kioku rotate-log <D>`), vous validez.
3. **Audit de lecture** : contradictions, claims périmées, concepts sans page, lacunes, prochaines sources. **Ancien fonds** : pages sans `gate:` sondées pour injures, portraits, données sensibles ; un cas trouvé est **signalé** (`kioku flag`), la page ne bouge pas.
4. **À décider** : la quarantaine, un élément à la fois.
5. **Rapport** et entrée de journal.

### Lien cassé ou lacune ?

Un lien vers une page inexistante, cité par **une seule source** et **non central**, est une **lacune voulue**. Il devient une anomalie quand la cible est citée par au moins deux sources, qu'elle est centrale, ou que le lien vise une page existante sous un autre nom.

## La quarantaine

```bash
kioku undecided travail      # ou npm run undecided (tous les domaines)
```

```
travail/sources-2026-03-12-revue  nature=retenue   code=sensible  date=…  wiki/travail/sources/….md  [keep|correct|drop]
travail/concepts-ancien-sujet     nature=signalee  code=insulte   date=…  wiki/travail/concepts/….md [keep|correct|drop]
travail/source-2026-03-14-atelier nature=pointeur  code=jugement-personne  date=…  raw/travail/…  [drop]
```

**Lisez la nature avant de choisir.** Les trois n'ont pas le même sens :

| Nature | D'où elle vient | Ce qu'elle est |
|---|---|---|
| **retenue** | `promote`, verdict `hold` | une page candidate qui **n'est pas** dans l'or |
| **signalée** | `kioku flag`, au lint | une page **déjà** dans l'or, marquée pour décision ; elle reste en place |
| **pointeur** | `kioku quarantine`, à l'ingestion | un passage d'une source **écarté** de la fiche argent ; **aucune page** : le reste de la source est en général déjà dans l'or |

## Décider

```bash
kioku decide <D> <nom> keep|correct|drop [note]
```

| | retenue | signalée | pointeur |
|---|---|---|---|
| `keep` | entre dans l'or telle quelle, `juge=utilisateur` | drapeau levé, page inchangée | refusé |
| `correct` | retourne sous `.candidats/`, à réécrire puis gate | copiée sous `.candidats/`, à corriger puis gate | refusé |
| `drop` | **supprimée** | **sortie du wiki** (copie dans `quarantine/<D>/sortis/`) | classé sans suite ; aucune page touchée |

- Une page `correct` se réécrit dans une session `ingest` du domaine, puis `check` → relecteur → `promote`.
- Chaque décision est journalisée dans `quarantine/<D>/decisions.jsonl`, avec votre note.
- Une décision qui vaut pour une famille de cas devient une **règle** : section `Relecture` de `domains/<D>/rules.md`. Vous l'écrivez vous-même, hors session.
- Après un `drop` de page signalée, relancez `kioku audit <D>` : les liens entrants sont à nettoyer.

## Le contenu d'une page en quarantaine

Aucune session ne lit `quarantine/` (garde). Pour juger sur pièce, ouvrez le fichier `.md` dans votre éditeur, hors Claude Code.
