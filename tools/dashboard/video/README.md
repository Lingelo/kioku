# Vidéo de présentation Kioku

Source de `../vendor/media/kioku-explainer.mp4`, lue dans le Mode d'emploi du dashboard.
Rendue avec le plugin **motion-studio** (Three.js + CSS3DRenderer, horloge virtuelle, Playwright + ffmpeg)
et la voix Piper `fr_FR-siwis-medium`.

| Fichier | Rôle |
|---|---|
| `narration.json` | Texte de la voix off, `gap` (pause par défaut) et `pause` par phrase. **C'est ici qu'on règle le temps de lecture.** |
| `voice/` | Voix générée : `narration.wav`, `voice.json` (début et fin de chaque phrase), sous-titres. |
| `build-timeline.mjs` | Injecte les débuts de phrase de `voice/voice.json` dans la composition (marqueurs `/*LINES*/`, `/*END_T*/`, `data-duration`). |
| `kioku-explainer.html` | La composition : jardin zen 3D, slides, beats (`data-at`, `data-anim`, `data-snd`). |

## Régénérer

```sh
MS=<chemin du plugin>/plugins/motion-studio/scripts   # chemin réel, pas un lien symbolique (/tmp vers /private/tmp sur macOS)
HOME_MS=~/.claude/plugins/data/motion-studio-<marketplace>

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
