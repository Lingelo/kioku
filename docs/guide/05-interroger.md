# 5. Interroger le wiki

[← Sommaire](README.md)

## Poser une question

```bash
npm run travail
> qu'a-t-on décidé sur le budget en mars ?
```

Une question libre suffit ; `/kioku:query <question>` force le déroulé. La session :

1. **vérifie que la question relève du domaine de la session.** Sinon, elle répond en deux lignes (domaine visé, commande de relance) sans rien chercher ni rien dire de l'autre domaine ;
2. lit `wiki/<D>/index.md` (par recherche, pas en entier), puis 2 à 5 pages et leurs liens ;
3. répond : **la réponse d'abord**, le détail en blocs courts, les incertitudes (⚠️), puis une ligne `Sources : [[…]] · [[…]]` ;
4. ajoute une entrée de 3 lignes au journal.

Si le wiki ne suffit pas : **« pas trouvé dans le wiki, à investiguer »**. C'est une source à ingérer, jamais une recherche dans le brut.

## Bien poser ses questions

| Plutôt | Que |
|---|---|
| « qu'a-t-on décidé sur X depuis janvier ? » | « dis-moi tout sur X » |
| « quels retours sur la livraison de Y, par date ? » | « que vaut Y ? » (pas de portrait) |
| « qu'a-t-on ingéré en février ? » (lit l'archive `log/2026-02.md`) | « qu'y a-t-il dans le journal ? » |
| un nom complet, ou le projet | un prénom seul (ambigu : la session présente les candidats) |

Sur une personne, la réponse donne rôle, organisation, projets, décisions et **retours attribués et datés**, jamais une conclusion sur la personne. Pour préparer un point individuel, demandez les retours regroupés par sujet.

## Domaine à extension `org`

Si le domaine porte l'extension `org` (registre des organisations), chaque page dit **où la connaissance a été acquise** (`org: [a, b]`). Nommez l'organisation dans la question pour cibler : la session filtre sur `org:` comme le disent les règles du domaine.

## Filer une synthèse

Une réponse qui mérite de rester (comparaison, chronologie, état d'un sujet) : `/kioku:save [slug]`. La session écrit `syntheses/<slug>.md`, qui ne cite que des pages or déjà lues, puis la fait passer la gate comme le reste. Une synthèse est précisément le cas où un jugement peut naître de l'assemblage de faits anodins : le relecteur y veille.

## Depuis le navigateur

Le dashboard servi (`npm run dashboard:serve:<D>`) a un champ de question : il lance la même session `query`, sous la garde. Voir [7. Dashboard](07-dashboard.md).
