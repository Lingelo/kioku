---
name: add-domain
description: Ajouter un domaine (un silo étanche) au coffre, à tout moment, sans toucher aux domaines existants. Session lancée avec VAULT_MODE=setup. À lancer explicitement.
argument-hint: [nom-du-domaine]
disable-model-invocation: true
---

Tu ajoutes un domaine au coffre : $ARGUMENTS (si vide, demande le nom).

Tu es en **session `setup`** (`npm run setup`) : tu lis la configuration (`kioku.config.json`), jamais un contenu de domaine. **Tu n'écris rien toi-même** : le CLI crée le domaine sans rien écraser, n'écrit la configuration qu'en dernier, puis prouve que le nouveau domaine et les anciens sont étanches.

## Déroulé

1. **Lis `kioku.config.json`** : les domaines existants et leur description. Un nom déjà pris est refusé ; dis-le avant de lancer quoi que ce soit.
2. **Pose les questions, une à la fois** :
   - le **nom** : kebab-case ASCII (`asso`, `club-sport`), ni `heritage`, ni le nom d'un domaine existant ;
   - une **description** en une phrase : ce que le domaine couvre. Le tri s'en sert pour ranger les sources entrantes ;
   - le **preset** de règles : `minimal` (le socle seul, à compléter), `pro` (travail chez un employeur et ses clients), `perso` (vie privée et famille proche). Les presets livrés sont dans `presets/`.
3. **Montre ce qui va être créé** et attends un « oui » explicite :
   - `wiki/<nom>/` (les huit dossiers et `overview.md`), `raw/<nom>/`, `silver/<nom>/` ;
   - `domains/<nom>/rules.md`, depuis le preset ;
   - l'ajout du domaine à `kioku.config.json`, en dernier ;
   - et ce qui **ne change pas** : aucun fichier des domaines existants.
4. **Lance** `kioku add-domain <nom> --preset <preset> --description "<description>"`.
5. **Rapporte la sortie telle quelle**, en commençant par la première ligne :
   - **code 0** : le domaine est créé et le cloisonnement est prouvé sur tous les domaines. Donne la suite : adapter `domains/<nom>/rules.md` à la main, hors session (les règles ne s'écrivent depuis aucune session) ; ouvrir le domaine avec `node tools/vault.mjs --domain <nom>` ;
   - **code 3** : le domaine existe, **mais le cloisonnement n'est pas prouvé**. Dis-le en premier, cite les lignes `CLOISONNEMENT`, et dis de **ne pas s'en servir** avant correction ;
   - **code 1** : rien n'a été écrit (nom refusé, preset inconnu, circuit Plaud en cours, dossier orphelin du même nom). Cite la raison.

## Ce que tu ne fais pas

- Retirer ou renommer un domaine : cela touche la data et son historique, et se fait à la main, hors session, puis `kioku doctor`. Si on te le demande, explique cette marche, sans rien lancer.
- Écrire les règles du domaine : tu peux proposer un texte, l'utilisateur le pose lui-même.
- Créer une extension `org` sur le nouveau domaine : `add-domain` ne la pose pas ; elle s'ajoute à la main dans la configuration, avec son registre.
