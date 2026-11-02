# Règles du domaine `{{domaine}}`

> Règles propres à ce coffre, lues par les skills communs et par le relecteur quand la session est ouverte sur `{{domaine}}`. Elles restent dans le coffre. Preset `pro` : un domaine de travail chez un employeur et ses clients ; adapte-le à ton contexte.

## Périmètre

Le travail du propriétaire du coffre chez son **employeur** et chez ses **clients**, missions en cours comme passées. Si ce domaine a l'extension `org` (`kioku.config.json`), les organisations sont listées dans son registre. Il sert aussi à préparer des points individuels (1to1, feedback). La vie privée des personnes n'y entre pas.

## Ingestion

- **`org:` sur la fiche argent** (domaine à extension `org`) : où cette connaissance a été acquise. Lis le registre et choisis le ou les identifiants dont la source relève, sur son contenu : un point interne de l'employeur → l'employeur ; une réunion de la mission → le client ; un point qui mêle les deux → les deux. Une seule ligne, identifiants triés : `org: [acme, globex]`.
- **`org:` sur les pages or** : la page `sources/`, la page `meetings/` et l'ADR portent le même `org:` que la fiche argent. Une entité que tu crées ou modifies porte l'**union** de son `org:` actuel et de celui de la source ; tu n'en retires jamais une organisation.
- **Données sensibles à consigner par pointeur** (jamais recopiées) : santé, vie privée, rémunération, évaluation formelle, motif de départ, évaluation d'un candidat.

## Requête

- **Signaux du domaine** : l'employeur ou un client (registre), projets, réunions, collègues, décisions, process, outils de travail.
- **Organisation visée** (domaine à extension `org`) : cherche dans la question le nom, un alias ou l'identifiant d'une organisation du registre. Si une organisation est visée, cherche d'abord les pages qui la portent (`Grep "^org:.*\b<id>\b"` sur `wiki/{{domaine}}/<dossier>`), puis élargis en le disant.

## Lint

- **Organisations** (domaine à extension `org`) : présente `org-absent` et `org-union` avec quelques exemples ; les corrections se font à la prochaine ingestion (une entité repasse la gate).

## Relecture

Le registre des organisations (s'il existe) est la seule autre lecture permise que la candidate et sa fiche argent : lis-le avant de juger le domaine. Une page sur l'employeur ou un client du registre n'est pas hors domaine ; la capture d'une organisation absente du registre, sans lien avec ce travail, l'est (`domaine`).

🛑 **Retenu (`hold`)**

- `sensible`, en plus du socle :
  - **vie privée, famille** ;
  - **santé** : la maladie, le diagnostic, la cause d'un arrêt. Une **absence** dite comme disponibilité passe : « absent du … au … », sans cause ;
  - **congés** : destination, lieu ou motif. La disponibilité passe : « absent du … au … », sans lieu ni raison ;
  - **rémunération, évaluation formelle de performance, sanction** ;
  - **motif d'un départ ou d'un licenciement** ;
  - **évaluation d'un candidat à l'embauche**.
- `domaine` : vie privée ou contenu personnel du propriétaire dans ce domaine, ou lien vers un autre domaine.
