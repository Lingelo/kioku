# 3d-force-graph (vendorisé)

- **Paquet** : `3d-force-graph@1.80.0`
- **Auteur** : Vasco Asturiano
- **Licence** : MIT
- **Fichier** : `3d-force-graph.min.js` (build UMD officiel issu du tarball npm `dist/3d-force-graph.min.js`)
- **Poids** : 1 313 897 octets (~1,25 Mo)
- **Empreinte SHA-256** : `d96e738edcca580edd524730c1c6b05ed2efce028c23ca95db1bf43033a72e42`
- **Composants inclus** : Three.js r183, d3-force-3d (inlinés dans le bundle UMD).

## Rôle et justification (R5, KTD6)

Cette bibliothèque permet de rendre le graphe de connaissances en 3D (nœuds, arêtes, manipulation par glisser-déposer avec réchauffement et stabilisation de la simulation à ressorts).

La vendorisation répond aux contraintes suivantes :
1. **Zéro réseau (R5)** : le coffre ne dépend d'aucun CDN externe ni d'aucun service tiers.
2. **Protocole `file://`** : les navigateurs bloquent les modules ES (`<script type="module">`) ouverts directement depuis le disque avec une origine `null` pour violation de CORS. Le build UMD classique permet un chargement direct via `<script src="vendor/3d-force-graph.min.js">` sans serveur local.

## Audit réseau du bundle (U4)

Recherche de motifs d'appels sortants dans le code minifié :
- `XMLHttpRequest` : 0 occurrence
- `sendBeacon` : 0 occurrence
- `import(` : 0 occurrence
- `WebSocket` : 0 occurrence
- `fetch(` : 1 occurrence, située exclusivement dans le gestionnaire de propriété `jsonUrl` (`ps:{jsonUrl:{onChange:...}}`). Comme le dashboard alimente directement la méthode `graphData({ nodes, links })` en mémoire sans jamais renseigner `jsonUrl`, `fetch` n'est jamais exécuté.

Le chargement de la page et la manipulation du graphe s'exécutent avec un onglet réseau strictement vide.
