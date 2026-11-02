---
name: query
description: Répondre à une question sur le travail (projets, personnes, réunions, décisions, processus) depuis l'or du coffre — le wiki du domaine de la session — jamais depuis le brut. À utiliser dès qu'une question porte sur le contenu du wiki.
argument-hint: <question>
---

Réponds à : $ARGUMENTS — en déroulant **CLAUDE.md §5.2**.

## Périmètre : l'or uniquement

- Tu lis `wiki/<domaine>/`, le domaine de la session (`VAULT_DOMAIN`, ou le `default_session` de `kioku.config.json`). Rien d'autre, sauf `domains/<domaine>/rules.md`, les règles propres à ce domaine : lis-les d'abord (sections `Périmètre` et `Requête`).
- `raw/` (bronze), `silver/` (argent), `inbox/`, `quarantine/` et les autres domaines sont **fermés par la garde** : une lecture refusée n'est pas une panne à contourner, c'est la règle.
- Si le wiki ne suffit pas : réponds « **pas trouvé dans le wiki, à investiguer** ». C'est une lacune à combler par une ingestion, jamais par une recherche dans le brut.

## Avant de chercher : de quel domaine parle la question ?

Lis l'intention de l'utilisateur **avant tout `Grep`** et compare-la au domaine de la session.

- **Les domaines du coffre** sont déclarés dans `kioku.config.json`, chacun avec sa `description` ; les **signaux du domaine de la session** sont dans ses règles (section `Requête`). Une question dont les signaux ne sont pas ceux de la session, et que la description d'un autre domaine couvre, relève de cet autre domaine.
- **Le domaine visé n'est pas celui de la session** : ne cherche pas, ne réponds pas, même en partie, et **ne dis rien du contenu de l'autre domaine** (pas même s'il existe une page). Réponds en deux lignes : « Cette question relève du domaine `<autre>` ; cette session est ouverte sur `<domaine>`. Relance : `npm run <autre>` (ou `node tools/vault.mjs --domain <autre>`), puis repose la question. »
- **Ambigu** (un prénom seul, un sujet à cheval sur deux domaines) : cherche **dans le domaine de la session uniquement**. Si rien n'y est trouvé, dis « pas trouvé dans le wiki `<domaine>` » et **demande de préciser** de quel domaine la question relève, en citant les domaines déclarés. Sans lire un autre domaine. Si la question est vraiment à cheval, demande d'abord en une ligne quel domaine viser, avant de chercher.
- **Je ne bascule pas de domaine en cours de session** : le domaine est fixé au lancement, la garde le lit dans l'environnement. Je n'essaie pas de le changer ni de lancer un autre processus avec un autre domaine ; c'est le sens même du silo.
- **Jamais deux domaines dans une même réponse** : pas de croisement, pas de lien de l'un vers l'autre. Une session ne sert qu'un seul domaine.

## Domaine à extension `org` : de quelle organisation parle la question ?

Seulement après avoir fixé le domaine, et seulement si celui de la session a l'extension `org` (`kioku.config.json`). Suis les règles du domaine (section `Requête`) : elles disent comment repérer l'organisation visée et chercher les pages qui la portent (`org:` dans le frontmatter).

## Procédure

1. Repère les pages utiles : cherche dans `wiki/<domaine>/index.md` avec `Grep` (le fichier est très long : ne le lis pas en entier), puis lis les 2 à 5 pages d'entité qui comptent (people, organizations, projects, concepts, decisions, syntheses) et suis les `[[wikilinks]]`. Pour `Grep`/`Glob`, donne toujours un `path` précis (`wiki/<domaine>/<dossier>`), jamais la racine du coffre. Une question sur l'**historique des opérations** d'un mois passé (« qu'a-t-on ingéré en juillet ? ») se lit dans son archive `wiki/<domaine>/log/<AAAA-MM>.md` (`Grep "^## \["` d'abord : une archive peut dépasser le plafond de lecture) ; `log.md` ne garde que le mois courant.
2. Si le sujet est ambigu (plusieurs pages portent le même prénom, plusieurs projets), **ne choisis pas à la place de l'utilisateur** : présente les candidats en une ligne chacun, dis lequel tu retiens et pourquoi, et réponds pour celui-là.
3. Rédige la réponse selon le format ci-dessous.
4. Ajoute l'entrée de log dans `wiki/<domaine>/log.md` en **3 lignes au plus** (CLAUDE.md §6) : `## [date heure] query | "…"`, pages lues, réponse filée oui/non. Pas de résumé de la réponse : il est dans la conversation, ou dans la synthèse si elle est filée.

## Format de la réponse : agréable à lire

Le lecteur est pressé et lit dans un terminal. **La réponse d'abord, le détail ensuite.**

1. **En une phrase ou deux, la réponse** (en gras si c'est un fait clé). Pas de préambule, pas de « d'après le wiki ».
2. **Le détail, en blocs courts** : un titre `###` par thème (2 à 4 au plus), des puces de une ligne, les noms propres, dates et chiffres en **gras**. Une table seulement pour comparer plusieurs éléments selon les mêmes critères. Dates au format `JJ/MM/AAAA` (ou `MM/AAAA`), la plus récente d'abord quand l'ordre compte.
3. **Ce qui manque ou reste incertain**, seulement s'il y en a : une puce « ⚠️ » par point, en distinguant ce que le wiki établit de ce qui est une hypothèse.
4. **Sources** : une dernière ligne compacte, `Sources : [[a]] · [[b]] · [[c]]`. Pas de wikilink dans chaque phrase, sauf pour une affirmation précise ou contestable.
5. **Longueur** : vise une vingtaine de lignes ; au-delà, coupe et propose d'approfondir (« Je peux détailler X ou Y »). Pas de citation longue, pas de recopie de page.

**Sur une personne** : rôle, organisation, projets et sujets partagés, décisions auxquelles elle a pris part, dates clés. **Des faits et des retours de travail attribués, jamais de portrait** : la même frontière que pour la gate (CLAUDE.md §9). Ne conclus pas « X est difficile / brillant / lent » ; rapporte ce qui s'est passé et ce que des personnes en ont dit, **avec l'auteur, la date et la source** (« selon Alice, le 10/09, … »), sous forme de liste datée sans phrase de synthèse. Pour un point individuel (1to1), regroupe les retours par sujet (livraison, collaboration, initiative, technique), les plus récents d'abord, en distinguant attentes exprimées et observations.

Si la réponse a une valeur durable, termine par une seule ligne : « Cette synthèse vaut-elle d'être filée avec `/save` ? ». Sinon, rien.
