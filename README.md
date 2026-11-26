# hasu-web-reader

Bilingual 3D story player for the *Link! Like! Love Live!* activity records — the official
Japanese script alongside fan translations, played back on a Three.js stage with the game's
characters, motions, voice, BGM and sound effects. Layout modelled on
[pjsk.cleista.cc](https://pjsk.cleista.cc/).

## Setup

```sh
npm install
npm run cache-assets -- 10300101 10300102   # download each episode's assets into public/assets/
npm run dev                                  # http://localhost:5173/?story=103-ep1-part1&line=1
```

`public/assets/` is not in git. `cache-assets` downloads an episode's models (with their
toon material files), motions, backgrounds, voice and sound effects from our asset bucket,
`gs://hasu-web-reader-assets` (BGM is copied from `../hasu-dub/bgm` when available). Assets
that aren't in the bucket yet must be exported from the raw game data and uploaded first;
the material files (`public/assets/3d/costume/*/*_materials.json`) come from
`scripts/export_toon_materials.py`.

## Regenerating scenario data

```sh
npm run build-scenarios
```

`scripts/build_scenarios.py` compiles the raw scripts (`../hasu-dub/story_main_txt/`) into
`public/data/scenarios/<slug>.json` (e.g. `103-ep1-part1.json` for script 10300101): seekable stage snapshots, aligned translations, and
the Japanese word segmentation used for hover lookup (`scripts/jp_lexer.py`). On first run it
downloads JMdict into `data_cache/jmdict/` (~165 MB, git-ignored).

## Not in git

| Path | What | How to get it back |
| --- | --- | --- |
| `public/assets/` | cached game assets | `npm run cache-assets -- <scriptId>` |
| `data_cache/jmdict/` | dictionary download | `npm run build-scenarios` |
| `data-inspect/`, `.inspect-tmp/` | raw game asset dumps, scratch space | local only |

## Hosting assets on GCS

Processed assets are stored in the `gs://hasu-web-reader-assets` bucket (project
`future-name-201021`; private, CORS for GET/HEAD). Browsers will reach it through signed URLs
from a small signing service (not built yet); until then the app reads `public/assets/`.
Upload a cached folder with paths mirrored:

```sh
scripts/upload_assets_gcs.sh 3d          # GLB/JSON stored gzip-encoded
```

Then point the app at the bucket in `.env.local` (git-ignored); only requests under the
listed prefixes go remote:

```sh
VITE_ASSET_BASE_URL=https://storage.googleapis.com/hasu-web-reader-assets
VITE_REMOTE_ASSET_PREFIXES=3d/           # empty = all assets
```

`src/remoteAssets.ts` rewrites Three.js model/texture loads and JSON fetches; audio still
loads from `public/assets/`.

## Credits

Translations, dictionary data and asset sources are credited in the app's Credits panel
(`src/credits.ts`). Unofficial fan project, not affiliated with or endorsed by the rights
holders. ©プロジェクトラブライブ！蓮ノ空女学院スクールアイドルクラブ
