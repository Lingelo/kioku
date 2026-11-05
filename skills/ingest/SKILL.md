---
name: ingest
description: Ingérer une source déjà classée dans le coffre (bronze → argent → or, par la gate). Session lancée avec VAULT_MODE=ingest. À lancer explicitement par l'utilisateur.
argument-hint: <un ou plusieurs chemins relatifs à raw/<domaine>/ — ex. meetings/2026-09-20-….md>
disable-model-invocation: true
---

Tu es en **session d'ingestion** du domaine `VAULT_DOMAIN`. Déroule **CLAUDE.md §5.1** sur : $ARGUMENTS

**Avant tout, lis `domains/<domaine>/rules.md`** (sections `Périmètre` et `Ingestion`) : ce sont les règles propres à ce domaine, qui complètent ce qui suit. `kioku.config.json` dit si le domaine a l'extension `org` (attribut `org:` et registre des organisations).

## Sans argument

Le lanceur (`npm run ingest:<domaine>`) démarre la session sur `/ingest` seul. Alors, **ne commence rien** : liste les sources de `raw/<domaine>/` **qui ne sont pas encore dans l'or**, de la plus ancienne à la plus récente, avec pour chacune son chemin et une ligne de contexte tirée de son titre. Puis **demande** lesquelles ingérer (toutes, une sélection, aucune) et attends la réponse. Rien à ingérer : dis-le et arrête-toi.

Une source est **déjà dans l'or** si l'un de ces critères tient, essayés dans cet ordre :

1. une fiche `silver/<domaine>/<slug>.md` existe (même slug que le fichier brut) ;
2. une page de `wiki/<domaine>/sources/` porte `raw:` vers ce fichier, ou son slug dans `aliases:` ;
3. le brut contient un lien Granola (`notes.granola.ai/t/<id>`) et une page de `wiki/<domaine>/sources/` ou `meetings/` porte le même `<id>` (`source_url:`) ;
4. sinon (source Plaud, sans lien) : une page `sources/` **de la même date** a un titre qui recouvre clairement celui du brut. Ce rapprochement est un jugement : dans la liste, marque-le « rapproché par titre : [[sources/…]] » au lieu de taire la source.

Une source **sortie du wiki sur décision** (journal : `correction` ou `gate` qui la nomme, copie dans `quarantine/<domaine>/sortis/`) n'est pas à ingérer : signale-la à part, sans la proposer.

*Motif : une ingestion écrit dans l'or après la gate ; lancée par habitude, elle ferait entrer une source que l'utilisateur ne voulait pas encore traiter. Le seul critère « pas de fiche argent » ne suffit pas : l'or hérité et les ingestions d'avant le médaillon n'ont ni fiche argent, ni `raw:`, ni le slug du brut ; il ferait passer pour nouvelles des sources déjà traitées, au risque de doubler des pages ou de réintroduire une source sortie du wiki sur décision.*

## Si on te donne plusieurs sources

Traite-les **une par une, dans l'ordre chronologique**, les trois étages au complet pour chacune — une fiche argent et une page source par source, jamais de fiche qui en mélangerait deux. Mais **garde-les en tête les unes après les autres** :

- **Recoupe.** Une séance de l'après-midi confirme, précise ou **contredit** celle du matin ; la troisième peut rouvrir une question que les deux premières laissaient ouverte. Dis-le dans la page, pas seulement dans ton rapport.
- **Ne relis pas ce que tu as déjà lu.** L'index, les pages liées, la source précédente sont déjà dans ton contexte.
- **Un seul passage d'index et de journal par journée** : complète la ligne et l'entrée au lieu d'en ouvrir une par source.

*Motif : trois séances d'une même journée ingérées par trois sessions séparées ne se recoupent jamais — même quand la deuxième contredit la première, ou que la troisième rouvre une question déjà posée deux fois. Aucune des trois ne peut le voir.*

## Trois étages, dans l'ordre

1. **Bronze → argent.** Lis la source dans `raw/<domaine>/`, puis écris sa fiche `silver/<domaine>/<slug>.md` : frontmatter (`raw:`, `domain:`, `org:` si le domaine a l'extension `org`, `flags: []`, `status: ready`), résumé structuré, points clés, entités, lacunes.
   - **`org:`** (domaine à extension `org` seulement, CLAUDE.md §6) : choisis-le comme le disent les règles du domaine. Une organisation **proposée par le tri** (prompt du circuit Plaud) est un point de départ : confirme-la ou corrige-la. Une seule ligne, identifiants triés. Pas d'`org:` dans un domaine sans l'extension.
   - La fiche est **nettoyée** : locuteurs résolus (hypothèse signalée, jamais actée), aucune injure ni portrait recopiés. Les **retours de travail attribués et datés** se gardent (« selon Alice, le 10/09, … » : observation sur des situations, attente exprimée, reconnaissance) : ils servent aux points individuels (CLAUDE.md §9).
   - **Propos insultants, trait attribué à une personne nommée (« X est incompétent »), retour non attribué, ou donnée que les règles du domaine disent sensible** : ne les recopie nulle part. Consigne-les par pointeur — `kioku quarantine <domaine> <slug> <code> <raw> [note sans citation]` — pose le drapeau dans `flags:`, et ne garde dans la fiche que les faits et les retours attribués.
   - Donnée sensible (mot de passe, token, RH nominative) : alerte l'utilisateur **avant** d'écrire.
   - Source qui n'est manifestement pas du domaine : stop, dis-le (elle repart au tri, `/triage`).
2. **Argent → or.** **Nomme les fichiers sans donnée sensible** : jamais le nom d'un candidat, d'une personne évaluée ou d'un dossier RH dans un slug (le slug est lu par chaque lien qui le cite ; CLAUDE.md §6). Le contexte déjà connu se lit dans l'**or** (`wiki/<domaine>/`, par l'index) : `silver/<domaine>/heritage/` est un instantané fermé, ne le lis pas. À partir de la **fiche argent** (pas du brut), rédige les candidates sous `.candidats/wiki/<domaine>/<dossier>/<slug>.md` : la page `sources/` (avec `raw:`), la page `meetings/` si c'est une réunion (la page source doit la lier), les entités touchées (**fiches `person` : uniquement selon la règle de CLAUDE.md §5.1** — personne centrale ou nommée dans au moins deux sources, identité donnée par la source, jamais déduite ; les règles du domaine peuvent restreindre davantage (fiches de particuliers sur demande explicite, par exemple) : sinon lien orphelin ; **pages `concept` : même logique**, `stub` seulement si le concept est central à la source ou cité dans au moins deux sources, sourcé, sans terme générique ni doublon — CLAUDE.md §5.1 ; quand un lien orphelin atteint la deuxième source, crée le stub à ce moment-là). Pour modifier une page existante : `kioku stage <domaine> <dossier/slug>` la copie sous `.candidats/` (sans `gate:`), puis modifie-la là avec Edit ; ne la recopie jamais à la main avec Write, ni par `cp`, que la garde refuse. Tu ne réécris pas les pages **héritées** au passage : ce que tu touches repasse la gate, alors ne touche que ce que la source modifie.
   - **`org:` sur les pages or** (domaine à extension `org`) : selon les règles du domaine.
3. **Gate.** `kioku check <fichiers>` — **en un seul appel, il en prend plusieurs** — jusqu'à « conforme ». Puis lance l'agent **`reviewer`** (un appel distinct de toi ; il lit le socle commun puis `domains/<domaine>/rules.md`) sur chaque candidate : **un relecteur par page, tous dans le même message**, donc en parallèle. Chacun lit sa page seule et ignore les autres — c'est le principe de §9, le parallélisme ne l'affaiblit pas, il évite seulement d'attendre les verdicts en file. Puis `kioku promote <fichiers>`, là aussi groupé. Une page **retenue** part en quarantaine : rapporte son code, ne la réécris pas jusqu'à ce que l'utilisateur tranche. Si un relecteur ne répond pas, **sa page n'entre pas** — les autres, oui.
   - **Ne t'arrête jamais après avoir écrit les candidates.** Une ingestion n'est finie que lorsque les pages sont dans l'or (ou en quarantaine) **et** que l'index et le journal sont à jour. Des candidates laissées sous `.candidats/` ne sont vues par personne : ni par le rapport du circuit Plaud, ni par `vault.mjs undecided`, ni au lint.

## Clôture

Mets à jour en place `wiki/<domaine>/index.md` et `wiki/<domaine>/log.md` (types canoniques, CLAUDE.md §4.4). Puis lance `kioku commit <domaine>` : le code commite le brut, l'argent, l'or, la quarantaine et les verdicts du domaine, sans push. Ne tape jamais `git add` ni `git commit` toi-même (la garde refuse les chemins des zones fermées, et une liste écrite à la main en oublie). S'il refuse (candidate en attente, page sans `gate:`), finis la gate ou rapporte la raison, sans contourner. Rapporte : pages admises, retenues (code), contradictions, lacunes, et le commit (ou son refus).

**L'index est un catalogue, le journal un carnet de bord, les pages portent le récit.** Une ligne d'index tient en **une phrase de repérage** — de quoi décider si la page mérite d'être ouverte, pas de quoi s'en passer (CLAUDE.md §6 : ≤ 120 caractères hors wikilink). Le détail — découvertes, contradictions, identités, réserves — va **dans les pages** (`Points clés`, `Lacunes à investiguer`, callout `> [!warning]` sur l'entité contredite). L'entrée de journal tient en **10 lignes au plus** (CLAUDE.md §6) : ce qui a été fait, les pages touchées, ce qui reste ouvert, avec des liens vers les pages pour le reste. Le commentaire d'en-tête de l'index renvoie à l'entrée du journal au lieu de la reformuler. *Motif : l'index est relu en entier à chaque session et la fin du journal aussi (une session d'ingestion par source dans le circuit Plaud) ; ce qu'on écrit dans l'un ou l'autre, on le repaie à chaque fois. Une page n'est lue que si elle sert.*
