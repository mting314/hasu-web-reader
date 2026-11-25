# hasu-web-reader

Bilingual 3D story player for the *Link! Like! Love Live!* activity records — the official
Japanese script alongside fan translations, played back on a Three.js stage with the game's
characters, motions, voice, BGM and sound effects. Layout modelled on
[pjsk.cleista.cc](https://pjsk.cleista.cc/).

## Setup

```sh
npm install
npm run cache-assets -- 10300101 10300102   # download each episode's assets into public/assets/
npm run dev                                  # http://localhost:5173/?script=10300101&line=1
```

`public/assets/` is not in git. `cache-assets` fetches the models, motions, backgrounds,
voice and sound effects from the `llll-card` GCS bucket (BGM is copied from `../hasu-dub/bgm`
when available). The per-costume toon material files
(`public/assets/3d/costume/*/*_materials.json`) are generated from a raw game export with
`scripts/export_toon_materials.py`.

## Regenerating scenario data

```sh
npm run build-scenarios
```

`scripts/build_scenarios.py` compiles the raw scripts (`../hasu-dub/story_main_txt/`) into
`public/data/scenarios/<scriptId>.json`: seekable stage snapshots, aligned translations, and
the Japanese word segmentation used for hover lookup (`scripts/jp_lexer.py`). On first run it
downloads JMdict into `data_cache/jmdict/` (~165 MB, git-ignored).

## Not in git

| Path | What | How to get it back |
| --- | --- | --- |
| `public/assets/` | cached game assets | `npm run cache-assets -- <scriptId>` |
| `data_cache/jmdict/` | dictionary download | `npm run build-scenarios` |
| `data-inspect/`, `.inspect-tmp/` | raw game asset dumps, scratch space | local only |

## Credits

Translations, dictionary data and asset sources are credited in the app's Credits panel
(`src/credits.ts`). Unofficial fan project, not affiliated with or endorsed by the rights
holders. ©プロジェクトラブライブ！蓮ノ空女学院スクールアイドルクラブ
