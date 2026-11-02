# Règles du domaine `{{domaine}}`

> Règles propres à ce coffre, lues par les skills communs et par le relecteur quand la session est ouverte sur `{{domaine}}`. Elles restent dans le coffre. Preset `perso` : la vie privée du propriétaire et de sa famille proche ; adapte-le à ton contexte.

## Périmètre

La vie privée du propriétaire du coffre et de sa famille proche.

## Ingestion

- **Fiches `person`** : les particuliers (enseignants, soignants, agents d'une administration, proches) ne reçoivent une fiche que **sur demande explicite** du propriétaire, par respect de leur vie privée. Sinon, lien orphelin.

## Requête

- **Signaux du domaine** : santé, médecin, famille, proches, amis, argent personnel, logement, loisirs, vacances, démarches privées, vie privée en général.

## Relecture

✅ **Passe**, si une source l'établit (une note de la main du propriétaire comprise) : l'identité, le lien de parenté, le rôle, la ville, la scolarité, la **santé**, les démarches et les finances du propriétaire et de sa famille proche.

🛑 **Retenu (`hold`)**

- `sensible`, en plus du socle :
  - la **date de naissance complète** d'un enfant (le mois et l'année passent) ;
  - la **vie privée des tiers** (voisins, enseignants, soignants, agents d'une administration) : leur santé, leur famille, leur logement, leurs biens. Leur rôle et ce qu'ils ont dit ou fait dans la situation passent.
- `domaine` : le travail du propriétaire (projets, équipes, décisions internes) dans ce domaine, ou lien vers un autre domaine. Une page qui porte un champ `org:` relève aussi du travail.
