---
name: triage
description: Classer les sources de l'entrant (inbox/) dans un des domaines du coffre, ou s'abstenir. Session lancée avec VAULT_MODE=triage. À lancer explicitement par l'utilisateur.
argument-hint: [fichier-optionnel]
disable-model-invocation: true
---

Tu es en **session de tri** (`VAULT_MODE=triage`). Tu lis `inbox/` et tu ranges chaque source dans `raw/<domaine>/<type>/` (`meetings`, `articles`, `pdfs`, `transcripts`, `assets`) avec `mv`. Le wiki, l'argent, la quarantaine et les règles des domaines te sont fermés.

**Avant de trier, lis `kioku.config.json`** (racine du coffre) : il déclare les domaines (`domains[].id`), ce que chacun couvre (`description`) et celui qui porte l'extension `org` (son registre des organisations, `extensions.org.registry`). Tu ne ranges que dans un domaine déclaré ; aucun autre dossier sous `raw/`.

Pour chaque source de `inbox/` (ou $ARGUMENTS) :

1. Lis-la.
2. Décide **un domaine déclaré**, ou **je m'abstiens**. Le domaine se décide **une seule fois**, ici, et une page ne change jamais de domaine. Appuie-toi sur la `description` de chaque domaine. Pour le domaine à extension `org` : **lis son registre** ; une source de l'employeur (séminaire, organisation interne, staffing, formation) ou d'un client du registre s'y range. **Une mission de l'employeur chez un autre client**, connue par l'employeur (retours client, comité de suivi, réponse à un appel d'offres), s'y range aussi et relève de l'employeur : ce client n'entre pas au registre et ne motive pas une abstention.
3. **Seuil et abstention** : au moindre doute (source mixte, capture d'une organisation absente du registre, RH d'un tiers, vie privée mêlée au travail), **ne range rien**. Laisse le fichier dans `inbox/` et pose la question. Trancher à tort pollue un coffre ; ne pas trancher coûte une question.
4. Nom de fichier en kebab-case ASCII, préfixé de la date ISO.
5. Pour une source rangée dans le domaine à extension `org`, **propose son organisation** : le ou les identifiants du registre dont elle relève (un 1:1 avec le manager de l'employeur qui parle surtout de la mission porte les deux). C'est une proposition : l'ingestion garde le dernier mot. Session non interactive (circuit Plaud) : écris-la sur une ligne `ORG <chemin relatif à raw/<domaine>/> : <id>,<id>`.
6. Rapport final en console : rangé par domaine (avec l'organisation proposée le cas échéant) / laissé dans l'entrant (avec la raison, sans recopier de contenu sensible).

Ne crée jamais de fiche `person` par déduction, et ne range jamais « pour aller vite ».
