export interface TranslationSource {
  id: string;
  lang: string;
  label: string;
  /** who made the translation (shown as the credit line) */
  attribution: string;
  /** this episode on the translator's site */
  url?: string;
  /** the translator's site / project page */
  homepage?: string;
  /** how the text was used or adapted */
  note?: string;
}

export interface ManifestCharacterAsset {
  name: string;
  nameEn: string;
  costumeId: string;
  glbUrl: string;
  materialsUrl: string;
  /** the character's Tecotec.EmotionData (scripts/export_emotions.py) */
  emotionDataUrl: string;
  eyeHighlightUrl: string | null;
  firstTurnIndex: number;
}

export interface ManifestBackgroundAsset {
  bgId: string | null;
  url: string;
  firstTurnIndex: number;
}

export interface ManifestPropAsset {
  id: string;
  glbUrls: string[];
  textureUrls: string[];
  firstTurnIndex: number;
}

export interface ManifestMotionAsset {
  id: string;
  url: string;
  firstTurnIndex: number;
}

export interface ManifestAudioAsset {
  id: string | null;
  url: string;
  firstTurnIndex: number;
}

export interface AssetManifestCounts {
  characters: number;
  backgrounds: number;
  props: number;
  motions: number;
  bgm: number;
  se: number;
  voices: number;
  total: number;
}

export interface AssetManifest {
  characters: ManifestCharacterAsset[];
  backgrounds: ManifestBackgroundAsset[];
  props: ManifestPropAsset[];
  motions: ManifestMotionAsset[];
  audio: {
    bgm: ManifestAudioAsset[];
    se: ManifestAudioAsset[];
    voices: ManifestAudioAsset[];
  };
  counts: AssetManifestCounts;
}

export interface EpisodeSummary {
  /** human-readable id used in URLs and data file names, e.g. "103-ep1-part1" */
  slug?: string;
  scriptId: string;
  seriesId: string;
  term: string;
  month: string;
  seriesTitleJp: string;
  seriesTitleEn: string;
  partTitleJp: string;
  partTitleEn: string;
  descriptionJp: string;
  descriptionEn: string;
  totalTurns: number;
  totalDurationSec: number;
  translationSources: TranslationSource[];
  assetCounts?: AssetManifestCounts;
  castCharacters?: ManifestCharacterAsset[];
  initialBackgroundUrl?: string | null;
}

export interface CatalogData {
  episodes: EpisodeSummary[];
}

export interface CharacterState {
  name: string;
  nameEn: string;
  characterId: number;
  color: string;
  costumeId: string;
  glbUrl: string;
  eyeHighlightUrl: string | null;
  /** the character's Tecotec.EmotionData (scripts/export_emotions.py) */
  emotionDataUrl: string;
  emotionController: string;
  visible: boolean;
  position: [number, number, number];
  rotation: [number, number, number];
  emotion: string;
  emotionComment?: string | null;
  motionId: string;
  motionUrl: string;
  motionDescription: string;
  /** The script command that started this motion (`<scriptId>:<line>`); same value on its event */
  motionCmd?: string;
  /** Turn whose line the starting command belongs to (commands before the first line: 0) */
  motionStartTurn?: number;
  /** Started with キャラモーション即時再生 (or the default pose of a newly shown character) */
  motionImmediate?: boolean;
  /** The command's playType: the state the motion starts in (0 in, 1 loop, 2 action) */
  motionPlayType?: number;
  /** Weight of the additive breathing layer; null = the game's default (0.2) */
  motionBreathing?: number | null;
  /** 即時再生: normalized time within the start state to jump to */
  motionNormalizedTime?: number | null;
  lookAt: {
    mode: string;
    value: number | [number, number, number] | string;
    duration?: number;
  };
  blush: number;
  /** fade seconds of the [顔紅潮操作] that set `blush` (0 = the 0.1 s minimum) */
  blushFadeSec?: number;
  /** transition seconds of the [キャラ表情変更] that set `emotion` (null = the data's TransitionTime) */
  emotionTransitionSec?: number | null;
  tears: boolean;
  attachedProps: string[];
}

export interface PropState {
  id: string;
  alias: string;
  glbUrl: string;
  extraGlbUrls: string[];
  textureDir: string;
  textureMap: Record<string, Record<string, string>>;
  visible: boolean;
  position: [number, number, number];
  scale: [number, number, number];
  rotation: [number, number, number];
}

export interface BackgroundState {
  bgId: string | null;
  url: string | null;
  comment: string | null;
  position: [number, number, number];
  scale: [number, number];
  rotation: [number, number, number];
}

export interface CameraState {
  position: [number, number, number];
  rotation: [number, number, number];
  fov: number;
  duration: number;
  easing: number;
}

export interface LightingState {
  rotation: [number, number, number];
  color: [number, number, number];
  postEffect: string | null;
  dof: {
    enabled: boolean;
    focalLength: number;
    focusDistance: number;
    aperture: number;
  };
  sepia: boolean;
  monochrome: boolean;
}

export interface FadeState {
  active: boolean;
  color: string;
  duration: number;
}

export interface AmbienceBed {
  id: string;
  url: string;
  volume: number;
}

export interface AudioState {
  bgmId: string | null;
  bgmUrl: string | null;
  bgmTitle: string | null;
  bgmVolume: number;
  /** The track's loop region [start, end] in seconds, from the game's wave (absent: whole file) */
  bgmLoop?: [number, number] | null;
  /** Looping ambience beds active at this point of the script */
  ambience: AmbienceBed[];
}

export interface StageSnapshot {
  background: BackgroundState;
  camera: CameraState;
  lighting: LightingState;
  fade: FadeState;
  audio: AudioState;
  novelMode: boolean;
  characters: Record<string, CharacterState>;
  props: Record<string, PropState>;
}

export interface IntraEvent {
  type: string;
  timestampSec: number;
  [key: string]: any;
}

export interface TranslationEntry {
  speaker: string;
  text: string;
}

/** One dictionary candidate for a token: lexicon entry id, matched dictionary form, inflection chain (outermost first) */
export interface JpTokenMatch {
  e: string;
  f: string;
  r?: string[];
}

/** A segment of the Japanese line; `m` is present when the segment is a dictionary word */
export interface JpToken {
  t: string;
  m?: JpTokenMatch[];
}

export interface LexSense {
  /** parts of speech (JMdict tag codes) */
  p: string[];
  /** English glosses */
  g: string[];
  /** misc tags (uk, col, hon, ...) */
  x?: string[];
  /** field tags */
  fl?: string[];
  /** dialect tags */
  dl?: string[];
  /** free-form notes */
  i?: string[];
  /** sense only applies to these kanji / kana spellings */
  ak?: string[];
  ar?: string[];
}

export interface LexEntry {
  /** kanji spellings */
  k?: string[];
  kt?: Record<string, string[]>;
  /** kana readings */
  r: string[];
  /** reading -> kanji spellings it applies to */
  ra?: Record<string, string[]>;
  rt?: Record<string, string[]>;
  s: LexSense[];
  /** JMdict "common" word */
  c?: 1;
  /** series-specific term (character / place / unit name) */
  n?: 1;
}

export interface DialogueTurn {
  index: number;
  lineNumber: number;
  scriptLineNum: number;
  timestampSec: number;
  durationSec: number;
  type: "dialogue" | "unvoiced_dialogue" | "novel";
  speakerJp: string;
  speakerEn: string;
  characterId: number | null;
  characterColor: string;
  characterLightColor: string;
  iconUrl: string | null;
  voiceId: string | null;
  voiceUrl: string | null;
  voiceStartSec: number;
  voiceEndSec: number | null;
  voicePart: number;
  voiceTotalParts: number;
  textJp: string;
  /** Yomitan-style word segmentation of textJp (build-time, see scripts/jp_lexer.py) */
  tokensJp: JpToken[];
  translations: Record<string, TranslationEntry>;
  preEvents: IntraEvent[];
  intraEvents: IntraEvent[];
  stateBefore: StageSnapshot;
  stateAfter: StageSnapshot;
}

export interface ScenarioData {
  /** human-readable id used in URLs and data file names, e.g. "103-ep1-part1" */
  slug?: string;
  scriptId: string;
  episode: EpisodeSummary;
  totalTurns: number;
  totalDurationSec: number;
  translationSources: TranslationSource[];
  assetManifest?: AssetManifest;
  turns: DialogueTurn[];
  /** Dictionary entries referenced by turns[].tokensJp */
  lexicon: Record<string, LexEntry>;
  /** JMdict tag code -> description, for tags used in `lexicon` */
  lexTags: Record<string, string>;
}

export type StageResolution = "auto" | "low" | "medium" | "high" | "ultra";
export type PrefetchMode = "off" | "next1" | "next5" | "all";

export interface ReaderSettings {
  primaryTranslationId: string;
  showSecondaryLanguage: boolean;
  subtitleLayout: "side-by-side" | "stacked" | "primary-only";
  textSpeed: number; // 1..5 (5 = instant)
  enable3DStage: boolean;
  stageResolution: StageResolution;
  cameraMode: "adv" | "orbit";
  autoPlayDelaySec: number;
  showFurigana: boolean;
  hidePrimaryWhenTranslated: boolean;
  prefetchMode: PrefetchMode;
  pauseWhenHidden: boolean;
  removeRoundedCorners: boolean;
  showDebugInfo: boolean;
}
