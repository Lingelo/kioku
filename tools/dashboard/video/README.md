# Vidéo de présentation Kioku

Source de `../vendor/media/kioku-explainer.mp4`, lue dans le Mode d'emploi du dashboard.
Rendue avec le plugin **motion-studio** (Three.js + CSS3DRenderer, horloge virtuelle, Playwright + ffmpeg)
et la voix Piper `fr_FR-siwis-medium`.

| Fichier | Rôle |
|---|---|
| `narration.json` | Texte de la voix off, `gap` (pause par défaut) et `pause` par phrase. **C'est ici qu'on règle le temps de lecture.** |
| `voice/` | Voix générée : `narration.wav`, `voice.json` (début et fin de chaque phrase), sous-titres. |
| `build-timeline.mjs` | Injecte les débuts de phrase de `voice/voice.json` dans la composition (marqueurs `/*LINES*/`, `/*END_T*/`, `data-duration`). |
| `kioku-explainer.html` | La composition : slides, beats (`data-at`, `data-anim`, `data-snd`), caméra, sons. |
| `garden.js` | **Le décor, partagé par les deux langues** : jardin zen 3D, Fuji et vallées, nuages, grues, pétales. Une retouche du décor se fait ici, une fois. |
| `pbr.js`, `fetch-assets.mjs`, `assets/` | Matériaux scannés (voir « Rendu réaliste ») ; `assets/` n'est pas versionné. |
| `narration.en.json`, `voice-en/`, `kioku-explainer.en.html` | **Version anglaise courte** (1 min 44 s, 11 arrêts sur 20, voix Kokoro), pour le guide. Voir plus bas. |

## Rendu réaliste

Les matériaux de `garden.js` sont des scans CC0 de Poly Haven projetés en triplanaire (`pbr.js`, repris de
la vidéo Kaizen du même auteur) : laque vermillon et bois laqué noir du torii, granit moussu des lanternes et
des rochers, tuiles, gravier, écorces de pin et de cerisier. Un HDRI couvert éclaire la scène sans être
montré (le fond reste du washi) ; tone mapping Khronos PBR Neutral (`setupRenderer`). Les murs de la pagode
restent en enduit uni : le scan de plâtre les marbrait. Échelle de la scène : 1 unité ≈ 1 cm, d'où le
`/ 100` de `PB()`. Le pin, les bambous, le Fuji et les ensō restent stylisés.

Les assets ne sont pas versionnés (`assets/`, ≈ 55 Mo) : **`node fetch-assets.mjs` avant tout rendu**, des
deux langues ; il télécharge ce qui manque et vérifie les md5. Sans eux, `createGarden()` échoue et le rendu
s'arrête (`window.__ready` rejetée), il ne produit pas de vidéo sans décor.

## Version anglaise

Montage court de la même scène : titre, problème, wiki, Claude, question, médaillon, gate, quarantaine,
silos, graphe, conclusion. Les slides bronze, argent et or sont fondues dans celle du médaillon ; la
transition, les commandes, Plaud, le tableau de bord et l'onglet Question sont coupés. Les beats sont
recalés sur le minutage **mot à mot** de Kokoro (`voice-en/voice.json`, champ `cues[].words`).

Le décor vient de `garden.js`, comme pour la version française. Restent propres à chaque composition : les
slides, leurs beats, la caméra (même spirale, moins d'arrêts) et les sons ; une retouche de ces parties se
reporte à la main d'un fichier à l'autre.

Le MP4 n'est pas versionné : il est publié en **asset de release** GitHub, et le guide pointe dessus
(vignette `docs/guide/media/kioku-explainer-en.jpg`, sous-titres `.srt` / `.vtt` à côté).

```sh
node fetch-assets.mjs                                             # 0. assets PBR (une fois, md5 vérifiés)
node $MS/voice.mjs narration.en.json -o voice-en                  # 1. voix (Kokoro, anglais)
node build-timeline.mjs voice-en kioku-explainer.en.html          # 2. recalage
node $MS/render.mjs --home $HOME_MS kioku-explainer.en.html \
  --voice voice-en/voice.json --captions off --embed-subs --crf 22 \
  -o kioku-explainer-en.mp4                                       # 3. rendu, puis upload en asset de release
```

## Régénérer

```sh
MS=<chemin du plugin>/plugins/motion-studio/scripts   # chemin réel, pas un lien symbolique (/tmp vers /private/tmp sur macOS)
HOME_MS=~/.claude/plugins/data/motion-studio-<marketplace>

node fetch-assets.mjs                                          # 0. assets du décor (une fois)
node $MS/voice.mjs narration.json -o voice --home $HOME_MS     # 1. voix
node build-timeline.mjs                                        # 2. recale slides, beats et sons
node $MS/render.mjs --home $HOME_MS kioku-explainer.html --stills 18,112 -o stills   # 3. contrôle visuel (optionnel)
node $MS/render.mjs --home $HOME_MS kioku-explainer.html \
  --voice voice/voice.json --captions off --embed-subs --crf 20 --cues cues.json \
  -o ../vendor/media/kioku-explainer.mp4                       # 4. rendu final
```

La légende (`figcaption` dans `../page.mjs`) mentionne la durée : à mettre à jour si elle change.

**Sous-titres : une seule source.** Le MP4 embarque une piste activable (`--embed-subs`) et le lecteur du
dashboard charge le `.vtt` en `<track>`. Garder `--captions off` : avec `--voice`, `render.mjs` incruste
par défaut les sous-titres dans l'image (`bottom`), et cette incrustation se superposerait à la piste.

## Temps de lecture

La caméra quitte une slide `LEAD + TRAVEL` = 1,45 s avant la phrase suivante. Le temps de lecture immobile
après la voix vaut donc `gap` (ou `pause`) − 1,45 s, soit environ 2,2 s avec `gap: 3.65`.

## Prononciation

Piper lit « Kioku » à la française (« kio-ku »). Les phrases qui le citent ont un champ `text` écrit
« Kiokou » (ce que la voix lit) et un champ `caption` écrit « Kioku » (ce qu'affichent les sous-titres).
Une nouvelle phrase qui nomme le projet doit faire de même.
