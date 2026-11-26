# hasu-web-reader — notes for agents

Bilingual 3D story player for the *Link! Like! Love Live!* activity records (see README for
setup). This file records what we've learned about how the game's assets work.

## Ground rules

- **Never pull from or reference hamproductions' `llll-card` GCS bucket.** Our assets live in
  `public/assets/` locally and in `gs://hasu-web-reader-assets`. Missing assets get exported
  from the raw game data (below) and uploaded, not fetched from third parties.
- `public/assets/`, `data-inspect/`, `.inspect-tmp/`, `data_cache/jmdict/` and `docs/media/` are
  git-ignored (game data / tens of GB, renders of game models). Never commit them. Images and
  videos for the docs go to the public docs bucket: `scripts/upload_docs_media.sh` uploads
  `docs/media/` to `gs://hasu-web-reader-docs/docs/media/`, and docs link
  `https://storage.googleapis.com/hasu-web-reader-docs/docs/media/<file>`.
- The user sometimes runs another agent in this repo at the same time. Check `git status`
  before editing shared files; put separate work in a git worktree.
- **Read the game's code before guessing a behavior.** The client's Il2Cpp dump is in
  `data-inspect/client-dump/` (see "The game's code" below). If a question is "how does the game
  do X" (blend times, what a command argument means, packet layouts), grep `dump.cs` for the class
  and disassemble the method. Don't brute-force it from data or tune it by eye.
- **Do not reinvent Unity, glTF, or Three.js from scratch.** Before writing custom solvers,
  binary packers, or renderers, check the game's prefab `MonoBehaviour` data and use canonical
  libraries:
  - **Inspect prefab bundles (`3d_costume_<id>`), not just raw `__*.fbx` bundles.** The `.fbx`
    containers only hold bare imported meshes/transforms/Avatars. The assembled character behavior
    (secondary physics, colliders, twist/helper bone constraints, expression/blink controllers) is
    serialized as `MonoBehaviour` components on the `3d_costume_<id>` prefab bundle and its `.asset`
    / `.controller` dependencies (see "Costume prefabs and MonoBehaviours" below).
  - **glTF / GLB export:** Do not extend `GlbBuilder`'s raw `struct.pack` writer in
    `scripts/unity_assets.py` to hand-pack meshes, skin weights, materials, or morph targets. Use
    `pygltflib` / `trimesh` in Python, or `AssetRipper` / `AssetStudioMod` CLI / headless Unity
    (`2022.3.62f2`, matching the bundle headers) with `glTFast` / `UniGLTF`.
  - **Three.js animation & additive layers:** Use `THREE.AnimationUtils.makeClipAdditive` for
    additive AnimatorController layers (such as Layer 2 `m_breathing@l` at weight 0.5) rather than
    writing custom bone math outside `THREE.AnimationMixer`.
  - **Spring bones, colliders & humanoid retargeting:** Use `@pixiv/three-vrm`
    (`@pixiv/three-vrm-springbone` for `SP_*` bone chains and capsule/sphere colliders driven by
    the exported `MagicaCloth2` parameters; `@pixiv/three-vrm-animation` if moving to full
    normalized humanoid retargeting) instead of writing custom physics or ad-hoc bone solvers.
  - **Visual verification:** Do not build or expand CPU software rasterizers in Python/NumPy
    (like `scripts/render_motion_preview.py`, which does not test the real Three.js shaders,
    mixer, or retargeting). Verify rendering against the real `<StageCanvas />` via headless
    Chromium / Playwright or the user's `--remote-debugging-port` Chrome session.
  - **Binary / protocol inspection (`alst` streams, MonoBehaviours):** Do not hand-roll wire-format
    protobuf parsers or guess schemas from hex dumps. Use `Il2CppDumper` / `AssetRipper` on the
    game binaries/bundles to get exact C# class and protobuf schemas, and use standard `protobuf` /
    `protoc --decode_raw`.

## Where assets come from

| Layer | What it is |
| --- | --- |
| Raw game data (`data-inspect/`) | Dumps of the game's asset server `assets.link-like-lovelive.app`: `llll-assets-ios.7z` (Unity asset bundles), `llll-assets-raw.7z` (audio/text/video), `llll-assets-with_meets.7z`. `data-inspect/README.md` describes the layout. `ios-full/ios/` is fully extracted (49,007 bundles, hashed names like `ios/tq/tq374hp…`). |
| Bundle index (`.inspect-tmp/ios_index.jsonl`) | One JSON line per bundle: `file`, `cabs`, `deps`, `containers` (asset ids such as `mot_00_01060`), `types` (Unity object counts). Grep it to find which bundle holds an asset. |
| Model exports (`data-inspect/model-export/`) | UnityPy exports of costume/face models (`report.json` per model), produced by the scripts in `.inspect-tmp/scripts/`. |
| hamproductions' explorer data | Where the current GLB/audio files originally came from. We only keep their asset **index**, `data_cache/model_viewer_context.json` (asset id → `glbPath`, `textureDir`, `textures`, `textureMap`, `extraGlbs`, `metadata.characterName`), which the build and cache scripts use to map ids to files. |
| Our store | `public/assets/` ⇄ `gs://hasu-web-reader-assets` (same layout). `npm run cache-assets -- <scriptId>` downloads from the bucket; `scripts/upload_assets_gcs.sh <dir>` uploads. |

### Bucket

`gs://hasu-web-reader-assets`, project `future-name-201021` (the user's Love Live project,
which also runs ll-bot/ll-predictions; a dedicated project couldn't be created because the
account hit Google's project quota). **Private since 2026-11-25**: no public reads (the
`allUsers` binding was removed), so plain `storage.googleapis.com` URLs return 403 and
`npm run cache-assets` (`scripts/cache_episode_assets.py`) uses authenticated
`gcloud storage cp`. The deployed site (GitHub Pages, `mting314.github.io/hasu-web-reader`)
is meant to get short-lived signed URLs from a small Cloud Run signing service; that service
isn't built yet, so local dev reads `public/assets/`. CORS GET/HEAD from `*` is still set.
GLB/JSON are stored gzip-encoded; `.webm` is labelled `audio/webm`.
`Cache-Control: public, max-age=3600` while models are still being re-exported; only switch to
long/immutable caching with versioned paths.

`archive/` in the bucket holds the Fes×LIVE / With×MEETS stream archive, copied from the
community dump on MEGA with the game server's layout kept (`archive/hls/<stream>/` byte-range
fMP4 HLS, `archive/alst/<live>/` the live-motion recording). Only the best video and audio
rendition per stream is kept. Docs media lives in the separate public bucket
`gs://hasu-web-reader-docs`.

The app reads assets as `/assets/<path>`. With `VITE_ASSET_BASE_URL` set (see `.env.local`),
`src/remoteAssets.ts` rewrites those URLs to the bucket: scenario data on load, plus Three.js
loads and `fetch()` as a backstop. `VITE_REMOTE_ASSET_PREFIXES` limits which paths go remote
(empty = all).

## Layout and naming (`public/assets/` = bucket)

```
3d/costume/<costumeId>/<costumeId>.glb              character model (body + face)
3d/costume/<costumeId>/<costumeId>_materials.json   toon material values from the game
3d/costume/<costumeId>/SCSch0NN<Chr>_Eye_highlightmain.png
3d/ppadv/<propId>/<propId>.glb (+ extra GLBs, .webp textures)   story props / sets
3d/motions/mot_00_NNNNN.glb                          body animations
3d/emotions/emotion_<name>.json                     the game's EmotionData per character
3d/metadata/motions.json                             motion id -> description
story/backgrounds/story_bg_image_NNN.webp            2D backgrounds (000 = none)
story/voice/vo_adv_<scriptId>_<seq4>_m<charId>_01[@<name>].webm   voice (Opus)
sound/effects/se_adv_<name>_NNNN.webm                sound effects
bgm/bgm_adv_<mood>_NNNN.mp3                          music (script ids like BgmAdvMorning0001)
assets/charaicon/charamini_icon_face_sd_<charId>_01.webp
```

- **Script ids** `TTTEEEPP`: `10300101` = 103rd term, episode 001, part 01. URL/data-file slug
  `103-ep1-part1` (`src/storySlug.ts`, `slug_for_script_id` in `scripts/build_scenarios.py`).
- **Character ids**: 1031 Kaho, 1032 Sayaka, 1033 Rurino, 1021 Kozue, 1022 Tsuzuri, 1023 Megumi,
  1041 Ginko, 1042 Kosuzu, 1043 Hime, 1051 Izumi, 1052 Ceras, 1011 Sachi; NPCs use 9xxx
  (9009 = the dorm mother, 寮母).
- **Costume ids** `3d_costume_1001<charId><variant>`: `3d_costume_1001103101` = Kaho in the
  school uniform used in episode 1. Unity names: `SCSch011Kah` (body), `SCSch011Kah_Face_normal`.

## What's inside

**Costume GLBs** (`scripts/export_costume.py`, from the prefab bundle and its dependency closure).
Body skeleton bones are `<Chr>DeA_*` (e.g. `KahDeA_Hips`). The face is a separate rig
(`<Chr>_Spine_03/Neck/Head`, eye bones) under `3d_face_<id>`, a **sibling** of the body, not its
child: `Inspix.FaceBonesCopier.LateUpdate` (RVA 0x4F4A440) copies the body's UpperChest world
position/rotation onto `<Chr>_Spine_03` and the local rotations of Neck, Head and the eyes onto
the face bones every frame (`src/engine/faceBonesCopier.ts`; the exporter records the pairs as
node extras `faceBonesCopier`). Face/Brow/EyeShadow are skinned to `<Chr>_Head`; the Eye mesh is
one-bone-per-vertex (a blend-index channel and no weights: each iris follows its eye bone).
The GLB keeps the complete Unity material in `material.extras.unity` (shader, keywords, floats,
colours, texture slots), each renderer's root bone (`extras.rootBone`) and the prefab's inactive
objects / disabled renderers (`extras.active` / `rendererEnabled` = false, hidden by the reader).
Older hamproductions-derived costume GLBs (with `*_outline` meshes) still load through the old
material path until every costume is re-exported.

**Costume prefabs and MonoBehaviours (`3d_costume_<id>`).** While `__scsch0NN<chr>dea.fbx` holds
only the bare body FBX (`GameObject`, `Transform`, `SkinnedMeshRenderer`, `Mesh`, `Avatar`), the
assembled costume bundle `3d_costume_<id>` (e.g. `3d_costume_1001103101` for Kaho's uniform: 248
Transforms, 58 `MonoBehaviour`s, 13 `MonoScript`s, 19 dependency bundles) combines the body FBX,
face FBX (`__scsch011kah_face_normal.fbx`), materials, and runtime Unity components:
- **Secondary physics (`MagicaCloth2` assembly `MagicaClothV2`):**
  - **Hair, necktie, and collar (`clothType: 1` = `BoneCloth`):** 6 `MagicaCloth2.MagicaCloth`
    components on `Extension_MagicaCloth_{FrontHair,BackHair,SideHair01,SideHair02,Necktie,Collar}`
    drive the `SP_*` spring-bone chains (`rootBones` lists the root `SP_*` transforms, e.g.
    `KahDeA_SP_HairFront01_01`, `KahDeA_SP_Necktie_01`, `KahDeA_SP_Collar_01`), complete with
    serialized `gravity`, `damping`, `angleRestorationConstraint.stiffness` curves, inertia, and
    `colliderCollisionConstraint.colliderList`.
  - **Skirt (`clothType: 0` = `MeshCloth`):** `Extension_MagicaCloth_Skirt` has `rootBones: []`
    because the skirt is simulated as **vertex cloth** (`MeshCloth`), prebuilt in the dependency
    bundle `__magicaprebuild_<model>.asset` (`MagicaCloth2.PreBuildScriptableObject`), colliding
    against 9 of the 15 `MagicaCapsuleCollider` / `MagicaSphereCollider` nodes attached to
    `Hips` (1 & 2), `LUpLeg`, `RUpLeg`, `LLeg`, `RLeg`, `LFoot`, `RFoot`, `Spine_01`, `Spine_03`,
    `LShoulder`, `RShoulder`, `LArm`, `RArm`, `Neck`, and `Head`.
- **Twist / bend / slide helper bones (`Inspix.SubBoneController` & `SubBoneReference`):**
  The non-humanoid helper bones (`*BendHalf`, `*Roll`, `*RollHalf`, `*Slide`, `*ElbowSub*`,
  `*UpLegSub*`, `*KneeSub*`) are driven procedurally at runtime from the primary limb bones using
  the 42 constraint definitions in dependency bundle `__subbone_gate4_scs_base.asset` (e.g. `LArm`
  drives `LArmBendHalf` at `0.5×`, `LArmRoll` at `-1.0×`, `LArmRollHalf` at `-0.5×`; `LLeg` drives
  `LLegBendHalf` at `0.5×` and `LLegSlide` at `0.02×`).
- **Face rig coupling & expressions (`Inspix.FaceBonesCopier`, `ExpressionSettings`, `BlinkController`, `CryEyeController`):**
  - `FaceBonesCopier` on `3d_face_<id>` links the body's `spine03`, `neck`, `head`, `leftEye`, and
    `rightEye` transforms to the face rig.
  - `ExpressionSettings` points to `__<char>_expression_controller.controller` (a 2-layer
    `AnimatorController` referencing ~56 `__<char>_face_*.anim` and `__<char>_mouth_*.anim`
    blendshape clips) and lists `expressionData` (`label`, `key`, `ableBlink`, `enable`).
  - `CryEyeController` toggles `_UseCryParameters` on the eye highlight/distortion materials.

**Blendshapes and expressions.** Names are `<Mesh>_.<Shape>` (`Face_.Mouth_Smile`,
`Brow_.Eyebrow_Angry`, `EyeShadow_.Eyelids_Close_L`, `Eye_.Eyelids_pupil`). Expressions come from
the game's `Tecotec.EmotionData`, exported by `scripts/export_emotions.py` to
`3d/emotions/emotion_<name>.json` (the name is the 3rd argument of `[キャラ表示]`). Each emotion
sets every key (0–100) of the Face/Brow/EyeShadow/Eye meshes; `src/engine/storyEmotion.ts` ports
`Tecotec.EmotionHandler` (see "Expressions, blinking, lip-sync" below). The old hand-made
`<char>_expressions.json` presets are no longer used.

**Materials.** The game uses `MELPOT/Toon/UberToonShader`. `scripts/msl_to_glsl.py` converts its
compiled programs (Metal source in `__ubertoonshader.shader`: ForwardLit 6/14 and Outline 1/4;
every other variant in the bundle is byte-identical) to GLSL in `src/engine/shaders/uberToonGame.ts`,
and `src/engine/gameToonMaterial.ts` runs them as three.js materials with each material's stored
values and render state (cull, depth, blend, stencil: brows and eyes write 201 and the hair skips
201, so they show through the fringe; the renderer needs `stencil: true`). Unity's object space
for a skinned mesh is its root bone. **The project renders in Gamma space**
(`PlayerSettings.m_ActiveColorSpace = 0` in the APK's data): textures are sampled raw and colours
used as stored, with no output encoding. The story light is the APK scene's directional light
(level9, `StoryScene.directionalLight`): colour (1, 1, 1), intensity 1, rotation (0, 0, 0), i.e.
from the camera side; `[ライト回転]` (`LightRotateCommand`, RVA 0x413A884) and `[ライト光源色変更]`
(`LightColorCommand`, RVA 0x413A5F8, `StoryDefine.ConvertColor`, RVA 0x41506E8) update it per line
(`scripts/build_scenarios.py`, `src/components/StageCanvas.tsx`). Characters
are layer 21, drawn by the story renderer's `CustomRenderObjects` feature after opaques with
`[UniversalForward, Outline, SRPDefaultUnlit]`, so each outline follows its own lit pass; MSAA is
2× (`_AlphaToMaskAvailable` = 1). The eye shader (`Character/ToonShader_CharacterEye`,
`__toonshader_charactereye.shader`) is converted by `scripts/msl_to_glsl.py` into `EYE_VERT` /
`EYE_FRAG` in `src/engine/shaders/uberToonGame.ts` and wired via `createGameEyeMaterial` in
`src/engine/gameToonMaterial.ts`.

**Motions.** A motion GLB has the skeleton plus clips `m_00_NNNNN@i/@a/@l/@o` (in, action,
loop, out; one motion, `mot_00_00040`, names them `@r@i` etc.), `m_breathing@l` and hand grip
clips. In the raw data each motion is an asset bundle with container `mot_00_NNNNN`
(11 `AnimationClip`s + an `AnimatorController`); the index has 2,534 `mot_*` containers.

What the controllers say (all 144 that episode 1 uses, dumped with UnityPy):
- Base layer `in → action → loop`: every transition is 0 s, fires when its clip ends (exit
  time 1), no interruption, speed 1, no mirror, Foot IK off. `loop → out` only on an `out`
  trigger. No AnyState transitions. A second layer plays `m_breathing@l` **additively at weight
  0.5**; two more hold the hand-grip poses at weight 0; one layer has an IK pass at weight 0.
- Every motion is a round trip from a shared neutral pose: `@o` ends exactly where `@i` starts
  (median 0.0°), and `@i` starts from one of a few neutral poses (standing; seated for every
  `着座` motion, hips 32.7 cm lower; running). Held `@l` poses are 22° (median) to 58° away.
- Many `@l` clips are just the held end pose, so **playing only `@l` skips the gesture**.
- How the game switches between motions, fires `out`, and reads the extra command arguments
  isn't in the bundles. It's in the game's code, decoded under "The game's code → Story motions"
  below.

`src/engine/storyMotion.ts` reproduces exactly that subset instead of a general blender: one clip
plays per character, the next starts when it ends with the leftover time carried over, and a new
motion blends in from the pose on screen, frozen at the switch (what a Unity transition does
when it starts mid-animation). It follows the game's code (see "Story motions" below): the
playType picks the start state (scripts almost always pass 2, so motions start at `@a`), the
switch blend is 0.5 s, playType 0 plays the old `@o` first, the 4th argument is the additive
breathing weight (default 0.2), and `即時再生` jumps to a normalized time with no blend.
`updateStoryMotion` replaces `mixer.update` in the render loop. Two three.js traps it handles:
the mixer only writes a property when its animated value changes (a held pose stops being written
after one frame), so anything that edits bones after `mixer.update` must put the mixer's values
back before the next update; and starting/stopping actions inside a mixer `finished` event
makes the mixer skip an action that frame. Earlier attempts that juggled several weighted
actions popped or sagged toward the rest pose whenever a switch interrupted another.
Breathing isn't reproduced yet.

Tracks target a reference character's bones (`KahDeA_*` and `Kah_*`). `retargetMotionClips`
renames them to the costume's prefix, skips spring (`SP_*`) and hair bones when the characters
differ, and scales the hips translation by the ratio of rest hip heights. The game solves each
motion on the character's own Avatar, and root motion scales with body size; without the scaling,
Kozue stood 10.5 cm too low. With it, every character's hands, feet and head land within about
1 cm of a per-character solve (bone rotations carry over by name almost exactly).

All motion GLBs in the store are exported from the raw data by `scripts/export_motions.py`
(see "Converting motions" below). The 127 older hamproductions-derived files are kept only as a
local backup in `.inspect-tmp/hamproductions-motions-backup/`; don't use them as a reference.

**Audio.** Voice and SE are Opus `.webm`, BGM is `.mp3`. Several exported "ambience" SEs are
sub-second fragments (e.g. `se_adv_ambience_classroom_0001` is one 0.48 s tap); looping those
sounds like endless footsteps, so the build only loops SEs ≥ 3 s (durations cached in
`data_cache/se_durations.json`).

## Story scripts (`../hasu-dub/story_main_txt/story_main_<scriptId>.txt`)

One `[command args…]` per line, with `#` comments; scene names come from `#背景` comments.
Coordinates are Unity's: the player flips z (`x, y, -z`) and character yaw becomes `180 - ry`.
Backgrounds are 1920×1080 at 100 px/unit (a 19.2 × 10.8 m quad); the camera FOV is 10.5°.
Commands `scripts/build_scenarios.py` handles:

- **Characters**: `キャラ表示` (name, costume, expression controller, pos, rot), `キャラ非表示`,
  `キャラ描画有効/無効`, `キャラ移動`, `キャラ向き変更`, `キャラ視線変更`, `キャラ表情変更`,
  `キャラモーション再生 / 即時再生` (motion id), `顔紅潮操作`
- **Stage**: `3Dオブジェクト表示/非表示` (props), `背景表示/移動/回転`, `カメラ移動/回転`,
  `被写界深度開始/終了`, `プリセットポストエフェクト開始/終了`, `セピア…`, `モノクロ…`,
  fades `暗転_イン/アウト`, `ブラックアウト_…`, `円_…`
- **Audio**: `BGM再生`, `BGMクロスフェード再生`, `BGM停止`, `SE再生 <id> <volume> <fadeInSec>`,
  `SE停止 <id> <fadeOutSec>`
- **Timing**: `待機 秒数指定 <sec>`
- **Text**: `メッセージ表示 <speaker> <voiceId> <text>`, `ボイス無しメッセージ表示`, `ノベルテキスト追加`

Messages don't block: the `待機` waits are the timeline, and the waits after a line add up to
roughly its on-screen time. One voice file can span several consecutive lines; the build
splits it into sub-clips by those cumulative waits (`voiceStartSec`/`voiceEndSec`).

The compiled `public/data/scenarios/<slug>.json` has, per line, a full `stateBefore` stage
snapshot (so any line can be jumped to), timed `intraEvents`, aligned translations, `tokensJp`
(Japanese word segmentation, see `scripts/jp_lexer.py`), and a per-episode `lexicon`.

## Working with the raw data

**Python tooling is uv.** `pyproject.toml` pins `UnityPy==1.25.4` and numpy (the `data`
group adds `wordfreq` for rebuilding `data_cache/wordfreq_ja.json`). Run scripts with
`uv run scripts/<name>.py …`, and use `uv run python -I` for ad-hoc code that reads the dump
(it's untrusted data). `npm run build-scenarios` / `cache-assets` already go through uv.

**Opening bundles.** The iOS bundles start with a 2-byte prefix (`AB 00`) before the
`UnityFS` signature, so UnityPy can't open the files as they are: strip the prefix and load the bytes
(`BundleIndex.load_env` in `scripts/unity_assets.py`). Find the bundle for an asset id with the
index (`containers`); rebuild the index with
`uv run scripts/build_bundle_index.py .inspect-tmp/ios_index.jsonl data-inspect/ios-full/ios`.
Clips and Avatars are self-contained; meshes and materials reference other bundles through
`deps` (CAB names, `BundleIndex.by_cab`). `read_typetree()` gives plain dicts.

**Converting motions** (`uv run scripts/export_motions.py --scripts 10300101 10300102 --check`,
or explicit `mot_…` ids). The clips are Mecanim *humanoid* clips: curves hold muscle values,
root motion and IK goals, not bone transforms. `scripts/unity_assets.py` does it:
- `decode_clip`: `m_MuscleClip.m_Clip` = streamed (cubic segments), dense and constant curves,
  in that order; bindings with typeID 95 (Animator). Attributes 7–9 RootT, 10–13 RootQ, 14–41
  IK goals (LeftFoot, RightFoot, LeftHand, RightHand: T+Q each), 42–96 the 55 body muscles,
  97–136 the 40 finger muscles.
- `Avatar` + `HumanoidBaker`: Unity's humanoid math on a reference Avatar (Kaho's body rig,
  container `__scsch011kahdea.fbx`). Per bone: `preQ · ZYRoll(tan(½·angle)) · conj(postQ)`, with
  the muscle → angle from its limits. The hips come from RootT/RootQ, which describe the
  centre of mass and a body frame built from the legs and arms.
- The output uses the same Unity → glTF convention as the costume GLBs (`t: (-x, y, z)`,
  `q: (x, -y, -z, w)`).

**Validate against the raw data itself, never against third-party exports.** Each clip stores
IK-goal curves for the hands and feet, so `--check` measures how far the baked wrists land from
the clip's own hand goals. Across episode 1's 580 main clips the median is 0.3 cm, 90% are under
1.9 cm, and the worst is 2.8 cm. That gap isn't a decoding error or drift: the baked hand
*rotations* match the goals' rotations exactly (median 0.00°), and the error doesn't grow over a
clip. It's body proportions: the goals record where the hands were on the body the motion was
made on, and the same clips baked on the 14 character rigs give 0.26 cm (Sachi) to 2.5 cm (Kozue,
Hime). The game shows the same gap, since nothing applies IK (Foot IK off, IK layer at weight 0).
Foot goals sit at the sole, 8.1 cm below the ankle. Check motions in the real reader
(`<StageCanvas />` in Chrome, see "Environment gotchas"), not with `scripts/render_motion_preview.py`:
that CPU renderer predates the ground rule above and doesn't exercise the shaders, mixer or
retargeting; it's kept only for the old proof videos. `3d/metadata/motions.json` has the Japanese
description of each motion, which is useful for checking what you see.

## The game's code (`data-inspect/client-dump/`)

Pulled from the transfer VM (`hasu-archive-mover`, `~/client/dump/` and the APK's
`lib/arm64-v8a/`); git-ignored like the rest of `data-inspect/`.

| File | What it is |
| --- | --- |
| `dump.cs` (66 MB) | Il2CppDumper output: every C# class, field (with offsets), enum, constant and method signature, with each method's `RVA`. No method bodies. |
| `stringliteral.json` | The 27,915 C# string literals (metadata addresses, not VAs in the .so). |
| `libil2cpp.so` (161 MB) | The compiled ARM64 game code. Method bodies live here at the RVA from `dump.cs` (VA = RVA). |

How to read a method: find it in `dump.cs` (`grep -n "class CharaMotionCommand" …`), take its
RVA, and disassemble that range with
`/usr/bin/objdump -d --start-address=0x… --stop-address=0x… data-inspect/client-dump/libil2cpp.so`.
Float literals are `mov w8, #0x…` / `fmov` immediates or loads from `.rodata` (read them with
`struct.unpack('<f')`; the first PT_LOAD maps file offset = VA). Static fields are reached through
`[class + 0xb8]` + the field offset from `dump.cs`. Namespaces: `Tecotec.*` = story (ADV) engine,
`Inspix.*` = live/3D characters, `Alst.Protocol` = live-stream protobuf schema,
`School.*` = another set of story commands.

### Story motions (`Tecotec.CharaMotionCommand`, `Tecotec.MotionHandler`)

`[キャラモーション再生 <char> <mot> <playType> [breathing]]` (`CharaMotionCommand.DoExecute`,
RVA 0x4133244):
- `playType` is `MotionHandler.MotionPlayType`, and picks the state the new motion **starts in**
  (`PlayTypeToStateHash`): `0 Normal` → `in`, `1 LoopToLoop` → `loop`, `2 LoopToAction` →
  `action`. The story scripts almost always pass `2`, so **story motions start at `@a`, not
  `@i`**; the `@i` clip is skipped and the crossfade covers the gap from the current pose.
- It then calls `ModelHandler.Play(controller, stateHash, transitionDuration: 0.5, 0, 0)`. The
  **switch blend is 0.5 s**.
- The optional 4th argument is the weight of the additive breathing layer:
  `ModelHandler.ApplyLayerWeight(PostureLayer.Breathing (= 2), arg)`. **If it's omitted the game
  sets it to 0.2** (float at 0x1aff17c), not the controller's 0.5. Values in the scripts are
  0–0.09, so story breathing is subtle.

`MotionHandler` runs its own `PlayableGraph`: an `AnimationMixerPlayable` with two
`AnimatorControllerPlayable` inputs (current, next) whose weights it crossfades (`DoBlend`,
`TransitionState` `None / PlayingOut / PlayingMix`). `Blend` (RVA 0x497D9E0):
- No motion playing yet: plays the new controller straight away, no blend.
- New state is `in` (playType 0) and the current controller has an `@o` clip: fires `out` on the
  current motion (state `PlayingOut`), plays `@o` until `transitionDuration` before its end
  (`outClip.length − 0.5`), and only then crossfades into the new motion over 0.5 s. **This is
  the only path that ever plays `@o`.**
- Otherwise (playType 1 or 2, i.e. nearly every story line): crossfades from the current
  motion into the new one over 0.5 s right away. `@o` never plays.

`[キャラモーション即時再生 <char> <mot> <playType> <t>]` (`School.CharaMotionImmediatelyCommand`,
RVA 0x43ED9E8): the same `playType` → state mapping, then
`AdvCharaMotionState.CreateNovelState(controller, stateHash, normalizedTime: t)` and
`ModelHandler.SetMotionImmediately`. **The 4th argument (0.3–1) is the normalized time within
that state to jump to**, with no blend. E.g. `2 1` = the end of `@a`.

`ModelConstants` (static ctor RVA 0x497ADEC): `SecondsToEndLipSync = 0.2`,
`LookRatioSpeedMultiplier = 4.0`, `MagicaBoneClothBlendWeight = 0.2`, `LookAtMaxAngle = 90°`.
Animation-event keys use `#` between events, `$` before params and `:` between a param and
its value (keys `PlaySe`, `StopSe`, `OnLoopEnd`, `OnOutEnd`).

### Expressions, blinking, lip-sync in story mode (`Tecotec.EmotionHandler`)

Story mode turns the live `Inspix.CharacterExpression` AnimatorController system off
(`ModelHandler.DisableLiveExpressionSystem`) and drives blendshapes from `Tecotec.EmotionHandler`
with the per-character `emotion_<char>` bundle (`Tecotec.EmotionData`). For Kaho:
`TransitionTime = 0.2` s linear between expressions; blink every `5.0` s
(`CloseTime 0.1`, `CloseStayTime 0.1`, `OpenFadeTime 0.1`, `Eyelids_Close_L/R` at 100);
lip-sync on `Mouth_A…O`, plus an A/B mode (`Mouth_A`, `LipWeights [0, 40, 70]`,
`LipInterval 0.125` s); 46 named emotions, each with `OverrideBlink` (1 = no blinking),
`OverrideLipSync`, `UnuseTransition` and its blendshape keys. Decoded and ported in
`src/engine/storyEmotion.ts` (method names and RVAs in its comments):
- `PlayEmotion` lerps every key linearly from the weights on screen (read back as ints) over
  `TransitionTime`, or the command's 3rd argument (`[キャラ表情変更 c NAME 0.7]`, 0 = instant).
- Blink only for emotions without `OverrideBlink` (for Kaho 3 of 46): the timer runs only while
  no blink or expression transition is active; close linearly over `CloseTime`, hold
  `CloseStayTime`, then the eyelids **snap** back on the first open frame (verified in
  `TransitionBlink`, 0x4979A38). No randomness.
- **Story lip-sync is an A/B flap, not vowels**: while a voice is audible the CRI lip-sync callback
  calls `PlayABLip`, which every `LipInterval` sets `Face_.Mouth_A` to a random entry of
  `LipWeights` (never the same index twice) **on top of** the expression's mouth; 0.2 s after the
  last pulse the vowel keys snap back. `PlayLipSync` (per-vowel) is never called.
  `[キャラ口パク開始 c sec]` runs the same flap for `sec` seconds without a voice.
- `[顔紅潮操作 c lv fade]` (`SchoolTears.FlushingController`, `src/engine/faceFlush.ts`) fades
  `_SecondaryColor.a` on the face material (secondary texture `face_cheek_cry`) over 0.1–10 s.
  The shipped iOS UberToon programs never sample `_SecondaryTex`, so nothing is drawn (Android's
  shader is unchecked).

### Look-at (`Tecotec.CharaLookCommand`, `ModelHandler.OnIKPass`)

Unity's own humanoid look-at, ported in `src/engine/storyLookAt.ts`:
- `SightWeightSettings` lives on the shared `ModelHolder` prefab in `data-inspect/apk/data.unity3d`
  (`resources.assets`, `GameObject` `"ModelHolder"` `path_id=35845`, `MonoBehaviour` `path_id=125774`):
  `weight = 0.5`, `bodyWeight = 0.1`, `headWeight = 0.25`, `eyesWeight = 0.25`, `clampWeight = 0.5`.
- `ModelHandler.OnCostumeLoaded` (RVA 0x497B62C) caches `eye = bodyAnimator.GetBoneTransform(HumanBodyBones.LeftEye)`
  (`<Chr>DeA_LEye`); `DistanceToEye` (RVA 0x497B1F0) is `eye.position.y - transform.position.y`.
- `CalculateLookAtPostionByAngle(degree)` (RVA 0x497BF48) returns
  `transform.position + Quaternion.AngleAxis(degree, Vector3.up) * transform.forward + (0, DistanceToEye, 0)`.
- `CharaLookCommand.DoExecute` (RVA 0x4132B3C):
  - `"キャラ指定"`: targets the named character's `EyeBoneTransform` (`<Chr>DeA_LEye`) over optional `duration`.
  - `"座標指定"`: targets the given world `Vector3` over optional `duration`.
  - `"角度指定"`: calls `SetLookAtAngle(degree, !skip)`.
  - `"向き指定"`: calls `SetLookAtAngle(ratio * LookAtMaxAngle, !skip)` (`LookAtMaxAngle = 90°`).
  - Anything else: resets `SetLookAtTarget(null, !skip, duration)`.
- `ModelHandler.OnIKPass` (RVA 0x497E97C):
  - When `LookAtTarget == null` (angle/direction mode): calls
    `Animator.SetLookAtWeight(0.5, 0, 0, 0.25, 0.5)` (**only the eyes move**) toward `LookAtPositionByAngle`.
  - When `LookAtTarget != null` (character or position mode): calls
    `Animator.SetLookAtWeight(0.5, 0.1, 0.25, 0.25, 0.5)` (**spine, neck/head, and eyes move**) and
    `SetLookAtPosition(Lerp(lastLookAtPosition, setLookAtPosition, lookAtRatioForTarget))`.
- In `StageCanvas.tsx`, `char.lookAt.restore()` runs before `updateStoryMotion(char, dt)`, and
  `char.lookAt.apply(dt)` runs after `updateStoryMotion(char, dt)` and before `char.copyFaceBones?.()`.

### Live-stream motion packets (`alst`, `Inspix.CharacterMotion`)

- The wire schema is in `dump.cs` (`Alst.Protocol.DataPack` / `DataFrame`, ~line 1637280):
  `DataPack.Frames = 16`; `DataFrame` oneof `InstantiateObject = 128` (`ObjectId 8`,
  `OwnerId 9`, `PrefabName 10`, `InitData 11`), `UpdateObject = 129` (`ObjectId 8`,
  `Method 9` = the `[RpcId(n)]` of the `AlstromeriaComponent` field, `Payload 10`),
  `DestroyObject = 130`. Write a `.proto` from it and use `protobuf`; don't extend the
  schema-less parser in the choreo-study worktree.
- `MotionReceiver.MotionData` (RpcId 1) is a 550-byte `MotionPacketAndTime`: a 542-byte
  `MotionPacket` (body position long @0, body rotation long @8, 95 muscles int16 @16,
  16 sub-bone position longs @206, 26 sub-bone rotation longs @334) + `double TimeSec` @542.
- `MotionDataPacking`: muscles `short = value × 1000`. Positions × 1000 (mm), truncated.
  **Rotations are not quaternions**: `Quaternion → eulerAngles` (degrees, `[0, 360)`),
  × 2000, rounded half-to-even. They decode through `Quaternion.Euler` (Unity's ZXY order).
- `PackingLong` packs `acc = (acc << bits[i]) | v[i]` for i = 0…n−1, so **element 0 (x) is in
  the highest bits and the last element (z) in the lowest**. A negative entry in `bits` means
  signed: the stored value is `v + (2^(n−1) − 1)`, and decoding subtracts `2^(n−1) − 1` (not
  `2^(n−1)`). The bit widths themselves (`positionBits`/`rotationBits`) come from the
  metadata blobs and aren't extracted yet. choreo-study's empirical (22, 20, 22) / 3 × 20 match
  the field sizes. **But its `alst_decode.py` reads fields low→high as x, y, z, which this
  layout says is z, y, x, and its position offset is 1 mm off.** Check it against a segment.
- The remote side applies packets with `HumanPoseHandler.SetHumanPose` (`MotionController`),
  i.e. the same muscle space our `HumanoidBaker` solves. Sub-bones are written straight to the
  `SubBoneReference.moveSubBones` / `rotateSubBones` transforms.

## Project Sekai cast swap (`src/engine/castSwap/`)

A reader setting ("Project Sekai cast", `src/components/CastPanel.tsx`, stored in localStorage by
`src/castSwapStore.ts`) puts a PJSK 3D model in place of a Hasu character.

- **Data**: `scripts/pjsk_fetch.py` (uv group `pjsk`) pulls raw bundles from PJSK's **EN official
  CDN** (handshake + app/asset version from Sekai-World's `sekai-master-db-en-diff/versions.json`;
  no account). The CDN's bundle index needs a logged-in session, so bundle names come from the
  storage.sekai.best mirror listing (`ls`, JP bucket) and dependencies from each bundle's
  `AssetBundle`. Bundles are stored de-obfuscated in `data-inspect/pjsk/bundles/` and need
  `UnityPy.config.FALLBACK_UNITY_VERSION = "2022.3.52f1"`. Layout: body
  `live_pv/model/characterv2/body/<cc>/<nnnn>/<figure>` (prefab `body`, figure =
  `gameCharacters.figure` + `breastSize`, e.g. `ladies_m`), head `…/face/<cc>/<nnnn>` (prefab
  `face`), expression presets `virtual_live/performer/facial/<cc>_<name>_NN` (one blendshape clip
  each; bindings are the Mesh channels' `nameHash`).
- **Export**: `scripts/export_pjsk_model.py` (reuses `export_costume.py`'s exporter) merges body and
  head into `pjsk/3d/model/<id>/<id>.glb` and lists it in `pjsk/models.json`. The head rig repeats
  the body's spine with zero offsets, so head meshes are bound to the body's bones by name and
  rebound with the gap between the two Head bones. Models keep PJSK's native size (~0.98 m).
- **PJSK Avatars are Generic** (no humanoid muscle data), so Hasu's muscle clips can't be solved on
  them. Instead, following Cleista's uma.cleista.cc (`js/mv/uma-retarget.js`), the Hasu character
  stays loaded with its meshes hidden and keeps running motion, look-at and expressions; each frame
  `pjskRetarget.ts` copies its bone rotations onto the PJSK rig through a per-bone rest correction,
  and `pjskFace.ts` maps its blendshape weights onto PJSK's `BS_*` shapes. **This hand-rolled
  transfer is allowed for this feature only**; don't reuse it elsewhere (CLAUDE.md's ground rules
  still apply).
- Default size: the replaced character's rest hip height (feet and seats line up; PJSK torsos are
  shorter, so heads sit lower). "Use Project Sekai heights" scales to `gameCharacters.height`.
- Not done yet: PJSK's shaders (`Sekai/Live/Character/Toon-v3`, `Eye-Base`, `Eye-Highlight`; the
  model renders unlit), spring bones (UTJ `SpringManager`), eye look-at (PJSK eyes move by
  `BS_look.*` blendshapes, not bones), helper bones (`*ArmRoll`, `*EllbowSupport`).

## Inspecting the reference reader (Cleista, `pjsk.cleista.cc`)

Cleista (`https://pjsk.cleista.cc`) is the reference web story reader for UI/UX behaviour (stage
loading gates, fullscreen layout, pause-on-hide/scroll, line-list scrolling, controls).

### Local mirror & safe inspection rules

- **Local mirror in `/tmp/cleista/`**:
  - `/tmp/cleista/src/`: ~900 unbundled ES modules mirroring `https://pjsk.cleista.cc/v/<hash>/js/…`.
  - `/tmp/cleista/index.html`: entry HTML with the `#stage*` DOM skeleton and `<link rel="stylesheet">` URLs.
  - `/tmp/cleista/css/`: stylesheets (`reader-layout.css`, `reader-stage-hud.css`, `reader-controls.css`, `base.css`).
- **How to examine Cleista without hanging**:
  1. **Use the local copy in `/tmp/cleista/` first; never crawl or download in a loop.**
  2. **If a missing file must be fetched from `pjsk.cleista.cc`**, run a single `curl` with a
     browser User-Agent and a hard timeout:
     `curl -s --max-time 20 -A "Mozilla/5.0 Chrome/158" <url>`
     (Python's default `urllib` User-Agent gets an HTTP 403 from Cloudflare, and unbounded network
     fetches can hang background agents).
  3. **Grep first, then read targeted line ranges.** `reader/index.js` is ~3,900 lines; find the
     function or event listener with `grep -rn` across `/tmp/cleista/src/reader/` and read only the
     80–150 lines around the match.

### Cleista module map

| Area | Cleista files (`/tmp/cleista/src/` & `css/`) | Key symbols & behaviour |
| --- | --- | --- |
| Stage DOM skeleton | `reader/stage-template.js`, `index.html` | `.reader-stage` (`container-type: size; container-name: reader-stage`), `#stageFullcolor` (initial black cover, 1.0 s opacity fade), `#stageLoader` (centered spinner), `#stageJpLoading` (top-center loading pill), `#stagePrev` / `#stageNext` (`.stage-nav-btn`, fullscreen-only), `#stageSettingsPanel` (on-stage settings popover), `#dialogueOverlay` |
| Initial load & per-line asset gate | `reader/step-assets.js`, `reader/crash-guard.js`, `reader/index.js` | `warmStepAssets()` holds `runBeat()` (voice, typewriter, timed events) until stage assets settle (`FIRST_PAINT_WARM_TIMEOUT_MS = 15000`, `WARM_GATE_TIMEOUT_MS = 5000`). `#stageJpLoading` uses an 80 ms show grace timer and 200 ms hide debounce. While `storyLoading`, transport controls and keyboard/stage advance are blocked (`syncLineChrome()`), and `#dialogueOverlay` is hidden before first paint or while seeking to an unready line. |
| Script list & transport chrome | `reader/line-chrome.js` | `syncLineChrome()` sets `prevBtn.disabled` / `nextBtn.disabled` / `stagePrev.disabled` / `stageNext.disabled` from `storyLoading` + line index bounds, and scrolls `.line-list` minimally so the active `.line-item` stays in view without scrolling `window`. |
| Fullscreen & subtitle scaling | `reader/dialogue-layout.js`, `reader/index.js`, `css/reader-stage-hud.css`, `css/reader-layout.css` | Fullscreens `.reader-stage` via `requestFullscreen()` / `webkitRequestFullscreen()`, falling back to `.is-fake-fullscreen` (`position: fixed; inset: 0; width: 100vw; height: 100dvh; z-index: 1000`). Subtitles stay anchored at the bottom (`inset: auto 0 0 0; padding: 2.5rem 7% 5%`) with no max-width cap (`width: 100%; max-width: none; grid-template-columns: 1fr 1fr; gap: 4.2cqmin`) and scale proportionally via `cqmin` (`font-size: clamp(..., 3cqmin, 42px)`). |
| Pause when hidden / scrolled away | `reader/index.js`, `live2d.js`, `global-audio.js`, `reader/effect-clock.js`, `reader/auto-advance.js`, `reader/auto-resume.js`, `reader/freeze-probe.js` | `visibilitychange` (gated by `pauseWhenHidden`), overlay open state, and an `IntersectionObserver` (`threshold: [0, 0.05, 0.25]`) on the stage container pause audio, stop the 3D/Live2D `requestAnimationFrame` loop, freeze the virtual effect clock, pause CSS/WAAPI fade animations and mid-line timers, and discard the paused delta on wake so animations resume without a `dt` catch-up jump. |
| UI strings | `i18n/catalog/en.js` (and other locales) | `stageLoadingStory` (`"Loading {0}…"`), `stageLoadingLineAsset` (`"Loading line {0}/{1} · {2}…"`), button tooltips and aria labels. |

## Known gaps (episode 1)

The build prints referenced assets that aren't in the store. Currently unavailable or wrong:
- only the four episode-1 costumes are re-exported with `scripts/export_costume.py`; the bucket
  still has the old ones
- the reader starts at the first line, so a motion played during an episode's opening fade-in
  (e.g. line 11 of 10300102) isn't shown
- secondary motion and helper-bone constraints aren't wired up in the reader yet. As documented
  under "Costume prefabs and MonoBehaviours" above, the `3d_costume_<id>` prefab bundle specifies
  exact `MagicaCloth2` parameters: `BoneCloth` (`clothType: 1`) on the `SP_*` bone chains (front/
  back/side hair, necktie, collar), `MeshCloth` (`clothType: 0`, prebuilt in
  `__magicaprebuild_<model>.asset`) on the boneless skirt with 15 `MagicaCapsuleCollider` /
  `MagicaSphereCollider` body colliders (preventing leg-through-skirt clipping on high knee lifts
  like `mot_00_01280`), plus `Inspix.SubBoneController` (`__subbone_gate4_scs_base.asset`) for the
  42 roll/bend/slide helper bones. In Three.js, export the `MagicaCloth2` bone chains and colliders
  to JSON and drive the `SP_*` chains with `@pixiv/three-vrm-springbone` rather than writing a
  custom spring physics solver.
- the dorm mother's 5 voice clips (`vo_adv_10300101_0046…0050_m9009_01`), so those lines play unvoiced
- Sachi's mini icon (`charamini_icon_face_sd_1011_01`)
- prop `ppadv006_pamphlet`, which isn't in the asset index (left off the stage)

## Environment gotchas

- In zsh, don't use `path` as a loop variable; it's tied to `$PATH`.
- Chrome can't be launched from Claude Code on this machine (sandbox). For browser checks, the
  user starts Chrome with `--remote-debugging-port`; attach with `agent-browser --cdp <port>`.
  Chrome reports the tab `hidden` when its window is behind VS Code, which stops
  requestAnimationFrame and smooth scrolling (stale screenshots). The VS Code browser stays
  visible but has no Opus decoder (voices/SEs are silent there).
- The APK's built-in Unity data (`data.unity3d`: story scene, URP assets, PlayerSettings) is in
  `data-inspect/apk/`, pulled from the `hasu-archive-mover` VM (SSH only via
  `--tunnel-through-iap`). Script MonoBehaviours there have no type trees: find them by the raw
  header (GameObject, enabled, Script PPtr, name) and decode fields in `dump.cs` order.
