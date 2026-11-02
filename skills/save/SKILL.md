---
name: save
description: Filer la dernière réponse substantielle en page de synthèse du wiki, par la gate. À utiliser quand une analyse a une valeur durable.
argument-hint: [slug-optionnel]
---

Déroule **CLAUDE.md §5.4** sur la dernière réponse substantielle. Slug : $ARGUMENTS (si vide, dérive un kebab-case ASCII concis).

1. Écris `.candidats/wiki/<domaine>/syntheses/<slug>.md` : `type: synthesis`, `created`, `updated`, `question`, `derived_from`, section `## Références`. Ne cite que des pages **or** déjà lues ; n'ajoute aucun fait qui n'y figure pas.
2. `kioku check <fichier>` → agent **`reviewer`** (socle commun, puis `domains/<domaine>/rules.md`) → `kioku promote <fichier>`. Une synthèse est le cas où un jugement naît de l'assemblage de faits anodins : elle passe la gate comme le reste.
3. MAJ `wiki/<domaine>/index.md` et `wiki/<domaine>/log.md` (type `file-back`, 10 lignes au plus : CLAUDE.md §6).
