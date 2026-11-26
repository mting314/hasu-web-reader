import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  ArrowLeft,
  BookOpen,
  Camera,
  ChevronLeft,
  ChevronRight,
  Columns,
  ExternalLink,
  Info,
  Maximize2,
  Menu,
  Minimize2,
  Music,
  Pause,
  Play,
  RotateCcw,
  Search,
  Settings,
  SlidersHorizontal,
  Sparkles,
  User,
  Volume2,
  VolumeX,
  X,
} from "lucide-react";
import {
  PreloadProgress,
  prewarmEpisodeCast,
  StageCanvas,
  startTieredEpisodePreloader,
} from "./components/StageCanvas";
import { JapaneseLookupText } from "./components/JapaneseLookupText";
import { CreditsPanel } from "./components/CreditsPanel";
import { StorySelector } from "./components/StorySelector";
import { episodePartLabel, scriptIdFromSlug, slugForScriptId } from "./storySlug";
import { rewriteAssetUrls } from "./remoteAssets";

/** Story from the URL: `?story=103-ep1-part1`, or a legacy `?script=10300101` link. */
function scriptIdFromUrl(): string | null {
  const params = new URLSearchParams(window.location.search);
  const story = params.get("story");
  if (story) return scriptIdFromSlug(story);
  return params.get("script");
}
import { AudioMixer } from "./AudioMixerSingleton";
import {
  CatalogData,
  DialogueTurn,
  EpisodeSummary,
  PrefetchMode,
  ReaderSettings,
  ScenarioData,
  StageResolution,
} from "./typesProxy";

const SCENE_LOCATION_EN: Record<string, string> = {
  金沢駅前: "In Front of Kanazawa Station",
  "蓮ノ空女学院（学校）校庭・体育館外観昼": "Hasunosora Schoolyard & Gym Exterior (Day)",
  "学校 屋上": "School Rooftop",
  "市内バス車内（朝）": "Inside City Bus (Morning)",
  "市内バス車内（昼）": "Inside City Bus (Day)",
  "蓮ノ空女学院 正門前": "Hasunosora Main Gate",
  "学校(蓮ノ空女学院)正門前(パン演出用の青空込)": "Hasunosora Main Gate",
  "学生寮 食堂": "Dormitory Dining Hall",
  "学校 教室（朝）": "Classroom (Morning)",
  "学校 教室（昼）": "Classroom (Day)",
  "学校 廊下": "School Corridor",
  "学校 中庭": "School Courtyard",
  "学校 部室（昼）": "School Idol Clubroom (Day)",
  "学校 部室（夕）": "School Idol Clubroom (Evening)",
  "学校 音楽堂": "School Music Hall",
  "学生寮 廊下（夜）": "Dormitory Corridor (Night)",
  "学校 中庭（夜）": "School Courtyard (Night)",
};

function translateSceneComment(commentJp: string | null): string {
  if (!commentJp) return "";
  if (SCENE_LOCATION_EN[commentJp]) return SCENE_LOCATION_EN[commentJp];
  return commentJp
    .replace("蓮ノ空女学院", "Hasunosora")
    .replace("学校", "School")
    .replace("学生寮", "Dormitory")
    .replace("市内バス車内", "Inside City Bus")
    .replace("正門前", "Main Gate")
    .replace("教室", "Classroom")
    .replace("部室", "Clubroom")
    .replace("屋上", "Rooftop")
    .replace("中庭", "Courtyard")
    .replace("廊下", "Corridor")
    .replace("（朝）", " (Morning)")
    .replace("（昼）", " (Day)")
    .replace("（夕）", " (Evening)")
    .replace("（夜）", " (Night)");
}

export default function App() {
  const [catalog, setCatalog] = useState<EpisodeSummary[]>([]);
  const [activeScriptId, setActiveScriptId] = useState<string>(() => scriptIdFromUrl() ?? "10300101");
  const [scenario, setScenario] = useState<ScenarioData | null>(null);
  const [currentTurnIndex, setCurrentTurnIndex] = useState<number>(() => {
    const params = new URLSearchParams(window.location.search);
    const ln = parseInt(params.get("line") || "1", 10);
    return Number.isNaN(ln) ? 0 : Math.max(0, ln - 1);
  });

  const [autoPlay, setAutoPlay] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [volumeOpen, setVolumeOpen] = useState(false);
  const [perChannelOpen, setPerChannelOpen] = useState(false);
  const [langMenuOpen, setLangMenuOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [creditsOpen, setCreditsOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [speakerFilter, setSpeakerFilter] = useState("ALL");
  const [twoColTranscript, setTwoColTranscript] = useState(true);
  const [twoColPageLayout, setTwoColPageLayout] = useState(false);

  // Audio volume & BGM mini-player UI state
  const [masterVol, setMasterVol] = useState(0.85);
  const [bgmVol, setBgmVol] = useState(0.45);
  const [seVol, setSeVol] = useState(0.65);
  const [voiceVol, setVoiceVol] = useState(1.0);
  const [muted, setMuted] = useState(false);
  const [bgmTime, setBgmTime] = useState<{ currentTime: number; duration: number }>({
    currentTime: 0,
    duration: 0,
  });
  const [bgmPlaying, setBgmPlaying] = useState(false);

  const [settings, setSettings] = useState<ReaderSettings>({
    primaryTranslationId: "en_curated",
    showSecondaryLanguage: true,
    subtitleLayout: "side-by-side",
    textSpeed: 3,
    enable3DStage: true,
    stageResolution: "auto",
    cameraMode: "adv",
    autoPlayDelaySec: 0.8,
    showFurigana: true,
    hidePrimaryWhenTranslated: false,
    prefetchMode: "next5",
    pauseWhenHidden: true,
    removeRoundedCorners: false,
    showDebugInfo: false,
  });

  // Typewriter text reveal state
  const [revealedChars, setRevealedChars] = useState(9999);
  const [preloadProgress, setPreloadProgress] = useState<PreloadProgress>({
    loaded: 0,
    total: 0,
    tier: "idle",
  });
  const stageContainerRef = useRef<HTMLDivElement>(null);
  const activeRowRef = useRef<HTMLDivElement>(null);
  const scriptListRef = useRef<HTMLDivElement>(null);

  // Playback state: a line is "finished" once its voice (or reading time) is done.
  const [lineFinished, setLineFinished] = useState(false);
  const lineStartRef = useRef(performance.now());
  const navKindRef = useRef<"advance" | "seek">("seek");
  const autoPlayRef = useRef(autoPlay);
  autoPlayRef.current = autoPlay;
  const autoJustEnabledRef = useRef(false);
  const pausedByHiddenTabRef = useRef(false);

  // Load episode catalog
  useEffect(() => {
    fetch("/data/catalog.json")
      .then((r) => r.json())
      .then((raw: CatalogData) => {
        const d = rewriteAssetUrls(raw);
        setCatalog(d.episodes || []);
      })
      .catch((e) => console.error("Failed to load catalog.json:", e));
  }, []);

  // Load selected scenario JSON
  useEffect(() => {
    AudioMixer.stopAll();
    setAutoPlay(false);
    fetch(`/data/scenarios/${slugForScriptId(activeScriptId)}.json`)
      .then((r) => r.json())
      .then((raw: ScenarioData) => {
        const data = rewriteAssetUrls(raw); // point /assets/* at GCS when configured
        setScenario(data);
        const availableIds = data.translationSources.map((s) => s.id);
        setSettings((prev) => ({
          ...prev,
          primaryTranslationId: availableIds.includes(prev.primaryTranslationId)
            ? prev.primaryTranslationId
            : availableIds[0] || "en_hasuko",
        }));
        const params = new URLSearchParams(window.location.search);
        const paramLine = parseInt(params.get("line") || "1", 10);
        if (scriptIdFromUrl() === data.scriptId && !Number.isNaN(paramLine)) {
          setCurrentTurnIndex(Math.min(data.turns.length - 1, Math.max(0, paramLine - 1)));
        } else {
          setCurrentTurnIndex(0);
        }
      })
      .catch((e) => console.error("Failed to load scenario:", e));
  }, [activeScriptId]);

  const currentTurn: DialogueTurn | null = useMemo(() => {
    if (!scenario || scenario.turns.length === 0) return null;
    const idx = Math.min(Math.max(0, currentTurnIndex), scenario.turns.length - 1);
    return scenario.turns[idx];
  }, [scenario, currentTurnIndex]);

  // Keep URL query params (`?story=103-ep1-part1&line=...`) synced
  useEffect(() => {
    if (!scenario || !currentTurn) return;
    const url = new URL(window.location.href);
    url.searchParams.delete("script"); // legacy numeric id links are rewritten to the slug
    url.searchParams.set("story", scenario.slug ?? slugForScriptId(scenario.scriptId));
    url.searchParams.set("line", String(currentTurn.lineNumber));
    window.history.replaceState({}, "", url.toString());
  }, [scenario, currentTurn]);

  // Sync audio mixer volumes
  useEffect(() => {
    AudioMixer.masterVolume = masterVol;
    AudioMixer.bgmVolume = bgmVol;
    AudioMixer.seVolume = seVol;
    AudioMixer.voiceVolume = voiceVol;
    AudioMixer.muted = muted;
    AudioMixer.applyVolumes();
  }, [masterVol, bgmVol, seVol, voiceVol, muted]);

  // Poll BGM time/play state for the Cleista Volume popover mini-player
  useEffect(() => {
    const id = window.setInterval(() => {
      setBgmTime(AudioMixer.getBgmTime());
      setBgmPlaying(AudioMixer.isBgmPlaying());
    }, 250);
    return () => window.clearInterval(id);
  }, []);

  // Cleista "Pause when tab hidden" behavior
  useEffect(() => {
    if (!settings.pauseWhenHidden) return;
    const onVisChange = () => {
      if (document.hidden) {
        AudioMixer.pauseForHiddenTab();
        if (autoPlayRef.current) {
          pausedByHiddenTabRef.current = true;
          setAutoPlay(false);
        }
      } else {
        AudioMixer.resumeFromHiddenTab();
        if (pausedByHiddenTabRef.current) {
          pausedByHiddenTabRef.current = false;
          setAutoPlay(true);
        }
      }
    };
    document.addEventListener("visibilitychange", onVisChange);
    return () => document.removeEventListener("visibilitychange", onVisChange);
  }, [settings.pauseWhenHidden]);

  // Tiered Priority Preloader driven by compile-time scenario.assetManifest:
  // Tier 1: Episode cast costumes (.glb + toon shaders + expressions), 2D backgrounds (.webp), 3D props (.glb)
  // Tier 2: Immediate sliding lookahead window (N..N+8) for 3D motion clips (mot_*.glb), voices, BGM & SE
  // Tier 3: Low-priority full-episode drain ordered from currentTurnIndex forward
  useEffect(() => {
    if (!scenario) return;
    return startTieredEpisodePreloader(
      scenario,
      currentTurnIndex,
      settings.prefetchMode,
      settings.enable3DStage,
      setPreloadProgress
    );
  }, [scenario, currentTurnIndex, settings.prefetchMode, settings.enable3DStage]);

  const activeTranslation = useMemo(() => {
    if (!currentTurn) return { speaker: "", text: "" };
    return (
      currentTurn.translations[settings.primaryTranslationId] ||
      Object.values(currentTurn.translations)[0] || {
        speaker: currentTurn.speakerEn,
        text: "(Translation unavailable for this line)",
      }
    );
  }, [currentTurn, settings.primaryTranslationId]);

  const targetCharCount = useMemo(() => {
    if (!currentTurn) return 0;
    return Math.max(activeTranslation.text.length, currentTurn.textJp.length);
  }, [currentTurn, activeTranslation]);

  const isTypewriterDone = revealedChars >= targetCharCount;

  /** Jump to a line (transcript click, scrubber): cuts any one-shot sound effects. */
  const goToTurn = useCallback(
    (index: number) => {
      if (!scenario) return;
      navKindRef.current = "seek";
      setCurrentTurnIndex(Math.min(Math.max(0, index), scenario.turns.length - 1));
    },
    [scenario]
  );

  // The current line's stage (background, cast, motions, props) has loaded: until then advancing is
  // blocked, so a first load can't skip ahead through lines whose models haven't appeared yet.
  // (The turn object, not its index: line 0 of a newly picked episode must not count as ready.)
  const [stageReadyTurn, setStageReadyTurn] = useState<DialogueTurn | null>(null);
  const stageReady = !settings.enable3DStage || (currentTurn !== null && stageReadyTurn === currentTurn);

  /** Step to the next line immediately (Next button, auto mode). */
  const handleNext = useCallback(() => {
    if (!scenario || !stageReady) return;
    if (currentTurnIndex < scenario.turns.length - 1) {
      navKindRef.current = "advance";
      setCurrentTurnIndex((i) => Math.min(i + 1, scenario.turns.length - 1));
    } else {
      setAutoPlay(false);
    }
  }, [scenario, currentTurnIndex, stageReady]);

  /**
   * Two-stage advance (clicking the stage canvas or pressing Space/ArrowRight):
   * 1st click while typewriter is still typing -> completes the current line immediately.
   * Click when text is already complete -> advances to the next line.
   */
  const handleStageOrKeyAdvance = useCallback(() => {
    if (!isTypewriterDone) {
      setRevealedChars(9999);
      return;
    }
    handleNext();
  }, [isTypewriterDone, handleNext, stageReady]);

  const handlePrev = useCallback(() => {
    if (currentTurnIndex > 0) {
      navKindRef.current = "seek";
      setCurrentTurnIndex((i) => Math.max(0, i - 1));
    }
  }, [currentTurnIndex]);

  const sharesVoiceWithNext = useCallback(
    (turn: DialogueTurn | null) => {
      if (!scenario || !turn?.voiceId || turn.voiceEndSec === null) return false;
      const next = scenario.turns[turn.index + 1];
      return Boolean(next && next.voiceId === turn.voiceId);
    },
    [scenario]
  );

  // Start a line's audio when the line changes
  useEffect(() => {
    if (!currentTurn) return;
    const kind = navKindRef.current;
    navKindRef.current = "seek";
    setLineFinished(false);
    lineStartRef.current = performance.now();
    if (kind === "seek") {
      AudioMixer.stopOneShotSes();
    }

    const snap = currentTurn.stateBefore;
    AudioMixer.syncBgm(snap.audio.bgmUrl, snap.audio.bgmVolume);
    AudioMixer.syncAmbience(snap.audio.ambience ?? []);

    let fallbackTimer: number | null = null;
    const finish = () => setLineFinished(true);
    const finishAfterReading = () => {
      const jpChars = currentTurn.textJp.replace(/\s/g, "").length;
      const readingMs = Math.min(9000, 1400 + jpChars * 90);
      fallbackTimer = window.setTimeout(finish, readingMs);
    };

    if (currentTurn.voiceUrl) {
      AudioMixer.playVoice(currentTurn.voiceUrl, {
        startSec: currentTurn.voiceStartSec || 0,
        endSec: currentTurn.voiceEndSec ?? null,
        autoContinue: autoPlayRef.current && sharesVoiceWithNext(currentTurn),
        onEnded: finish,
        onError: finishAfterReading,
      });
    } else {
      AudioMixer.stopVoice();
      finishAfterReading();
    }

    return () => {
      if (fallbackTimer !== null) window.clearTimeout(fallbackTimer);
    };
  }, [currentTurn, sharesVoiceWithNext]);

  // Auto mode: advance once the line is finished.
  useEffect(() => {
    if (!autoPlay || !lineFinished || !scenario || !currentTurn || !stageReady) return;
    if (currentTurn.index >= scenario.turns.length - 1) {
      setAutoPlay(false);
      return;
    }
    let waitMs: number;
    if (autoJustEnabledRef.current) {
      waitMs = 150;
    } else if (sharesVoiceWithNext(currentTurn) && AudioMixer.isVoicePlaying()) {
      waitMs = 0;
    } else {
      const scriptRemainingMs =
        currentTurn.durationSec * 1000 - (performance.now() - lineStartRef.current);
      waitMs = Math.max(settings.autoPlayDelaySec * 1000, scriptRemainingMs);
    }
    autoJustEnabledRef.current = false;
    const timer = window.setTimeout(() => {
      navKindRef.current = "advance";
      setCurrentTurnIndex((i) => Math.min(i + 1, scenario.turns.length - 1));
    }, waitMs);
    return () => window.clearTimeout(timer);
  }, [autoPlay, lineFinished, currentTurn, scenario, settings.autoPlayDelaySec, sharesVoiceWithNext, stageReady]);

  // Keep a shared multi-line recording running past the split point only in auto mode
  useEffect(() => {
    AudioMixer.setAutoContinue(autoPlay && sharesVoiceWithNext(currentTurn));
  }, [autoPlay, currentTurn, sharesVoiceWithNext]);

  const toggleAutoPlay = () => {
    const next = !autoPlay;
    autoJustEnabledRef.current = next && lineFinished;
    setAutoPlay(next);
  };

  // Typewriter text reveal animation. A layout effect, so the reset to 0 lands before the new line
  // is painted (otherwise it flashes fully revealed for a frame, with the previous line's count).
  useLayoutEffect(() => {
    if (!currentTurn) return;
    if (settings.textSpeed >= 5) {
      setRevealedChars(9999);
      return;
    }
    setRevealedChars(0);
    const charsPerTick = settings.textSpeed;
    const interval = window.setInterval(() => {
      setRevealedChars((c) => {
        if (c >= 400) {
          window.clearInterval(interval);
          return 9999;
        }
        return c + charsPerTick;
      });
    }, 26);
    return () => window.clearInterval(interval);
  }, [currentTurn, settings.textSpeed]);

  // Keep the active line in view in the script panel, scrolling as little as needed (like Cleista's
  // syncLineChrome): a line below the visible area ends up at the panel's bottom, one above at its
  // top, a visible one doesn't move. Only the panel scrolls: scrollIntoView would also scroll the
  // page and pull the stage out of view.
  useEffect(() => {
    const list = scriptListRef.current;
    const row = activeRowRef.current;
    if (!list || !row || !list.clientHeight) return;
    const r = row.getBoundingClientRect();
    const l = list.getBoundingClientRect();
    let delta = 0;
    if (r.top < l.top) delta = r.top - l.top;
    else if (r.bottom > l.bottom) delta = r.bottom - l.bottom;
    if (delta) list.scrollTo({ top: list.scrollTop + delta, behavior: "smooth" });
  }, [currentTurnIndex]);

  // Keyboard navigation (Right/Space = two-stage advance, Left = Prev)
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (
        document.activeElement?.tagName === "INPUT" ||
        document.activeElement?.tagName === "SELECT"
      ) {
        return;
      }
      if (e.key === "ArrowRight" || e.key === " ") {
        e.preventDefault();
        handleStageOrKeyAdvance();
      } else if (e.key === "ArrowLeft") {
        e.preventDefault();
        handlePrev();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [handleStageOrKeyAdvance, handlePrev]);

  const toggleFullscreen = () => {
    if (!stageContainerRef.current) return;
    if (!document.fullscreenElement) {
      stageContainerRef.current.requestFullscreen().catch(() => {});
      setIsFullscreen(true);
    } else {
      document.exitFullscreen().catch(() => {});
      setIsFullscreen(false);
    }
  };

  const uniqueSpeakers = useMemo(() => {
    if (!scenario) return [];
    const set = new Set<string>();
    for (const t of scenario.turns) {
      if (t.speakerJp) set.add(t.speakerJp);
    }
    return Array.from(set);
  }, [scenario]);

  const filteredTurns = useMemo(() => {
    if (!scenario) return [];
    const q = searchQuery.trim().toLowerCase();
    return scenario.turns.filter((t) => {
      if (speakerFilter !== "ALL" && t.speakerJp !== speakerFilter) return false;
      if (!q) return true;
      const tlText =
        t.translations[settings.primaryTranslationId]?.text?.toLowerCase() || "";
      return (
        t.textJp.toLowerCase().includes(q) ||
        tlText.includes(q) ||
        t.speakerJp.toLowerCase().includes(q) ||
        t.speakerEn.toLowerCase().includes(q)
      );
    });
  }, [scenario, searchQuery, speakerFilter, settings.primaryTranslationId]);

  const formatMmSs = (sec: number) => {
    const clean = Math.max(0, Math.floor(sec || 0));
    const m = Math.floor(clean / 60);
    const s = clean % 60;
    return `${m}:${String(s).padStart(2, "0")}`;
  };

  if (!scenario || !currentTurn) {
    return (
      <div className="min-h-screen bg-[#080d14] text-slate-100 flex items-center justify-center">
        <div className="flex items-center gap-3 text-sm text-slate-300">
          <span className="h-3 w-3 rounded-full bg-[#7c9ff5] animate-ping" />
          Loading Link! Like! Love Live! Bilingual 3D Scenario Player…
        </div>
      </div>
    );
  }

  const activeTlSource = scenario.translationSources.find(
    (s) => s.id === settings.primaryTranslationId
  );

  const remainingSec = Math.max(0, scenario.totalDurationSec - currentTurn.timestampSec);
  const currentEpisodeIdx = catalog.findIndex((e) => e.scriptId === scenario.scriptId);
  const prevEpisode = currentEpisodeIdx > 0 ? catalog[currentEpisodeIdx - 1] : null;
  const nextEpisode =
    currentEpisodeIdx !== -1 && currentEpisodeIdx + 1 < catalog.length
      ? catalog[currentEpisodeIdx + 1]
      : null;

  const activeCast = Object.values(currentTurn.stateBefore.characters).filter((c) => c.visible);
  const showDualCanvasSubtitles =
    settings.showSecondaryLanguage &&
    settings.subtitleLayout !== "primary-only" &&
    !settings.hidePrimaryWhenTranslated;

  return (
    <div className="min-h-screen bg-[#080d14] text-slate-100 flex flex-col">
      {/* Top Header Bar (modeled directly on pjsk.cleista.cc) */}
      <header className="sticky top-0 z-40 h-14 border-b border-slate-800/70 bg-[#0a1019]/95 backdrop-blur-md px-3 lg:px-6 flex items-center justify-center">
        <div className="max-w-5xl w-full flex items-center justify-between gap-2.5">
          <div className="flex items-center gap-2">
            {/* Circular Cleista Volume Button + Audio Visualizer Ring */}
            <div className="relative">
              <button
                type="button"
                aria-label={`Volume (${Math.round(masterVol * 100)}%) — click to adjust`}
                aria-expanded={volumeOpen}
                onClick={() => {
                  setVolumeOpen((v) => !v);
                  setLangMenuOpen(false);
                }}
                className={`relative h-9 w-9 rounded-full border flex items-center justify-center transition ${
                  volumeOpen
                    ? "border-[#7c9ff5] bg-[#162235] text-white shadow-[0_0_16px_rgba(124,159,245,0.45)]"
                    : "border-slate-700/80 bg-[#111927] text-slate-200 hover:bg-[#182336]"
                }`}
                title={`Volume (${Math.round(masterVol * 100)}%) — click to adjust`}
              >
                {bgmPlaying && !muted && (
                  <span
                    aria-hidden="true"
                    className="absolute -inset-0.5 rounded-full border border-cyan-400/50 animate-pulse pointer-events-none"
                  />
                )}
                {muted ? (
                  <VolumeX className="w-4 h-4 text-rose-400" />
                ) : (
                  <Volume2 className="w-4 h-4 text-slate-100" />
                )}
              </button>

              {/* Cleista 2-Row Volume + BGM Seek Mini-Player Dialog */}
              {volumeOpen && (
                <div
                  role="dialog"
                  aria-label="Volume"
                  onClick={(e) => e.stopPropagation()}
                  className="absolute left-0 mt-2 w-80 rounded-2xl border border-slate-700/90 bg-[#121b29]/95 p-3.5 shadow-2xl backdrop-blur-xl z-50 space-y-2.5"
                >
                  {/* Row 1: Per-Channel Toggle + Master Slider + % + Mute */}
                  <div className="flex items-center gap-2.5">
                    <button
                      type="button"
                      aria-label="Per-channel volume"
                      aria-expanded={perChannelOpen}
                      onClick={() => setPerChannelOpen((v) => !v)}
                      className={`h-8 w-8 rounded-full border flex items-center justify-center shrink-0 transition ${
                        perChannelOpen
                          ? "border-[#7c9ff5] bg-[#7c9ff5]/20 text-[#9db8ff]"
                          : "border-slate-700/80 bg-[#182436] text-slate-300 hover:text-white"
                      }`}
                      title="Per-channel volume"
                    >
                      <SlidersHorizontal className="w-3.5 h-3.5" />
                    </button>

                    <input
                      type="range"
                      aria-label="Volume"
                      min={0}
                      max={1}
                      step={0.01}
                      value={masterVol}
                      onChange={(e) => setMasterVol(parseFloat(e.target.value))}
                      className="flex-1 accent-[#58a6ff] cursor-pointer"
                    />

                    <span className="w-9 text-right text-xs font-mono text-slate-300 tabular-nums">
                      {Math.round((muted ? 0 : masterVol) * 100)}%
                    </span>

                    <button
                      type="button"
                      aria-label="Mute"
                      onClick={() => setMuted((m) => !m)}
                      className={`h-8 w-8 rounded-full border flex items-center justify-center shrink-0 transition ${
                        muted
                          ? "border-rose-500/60 bg-rose-500/20 text-rose-300"
                          : "border-slate-700/80 bg-[#182436] text-slate-200 hover:bg-slate-700"
                      }`}
                      title={muted ? "Unmute" : "Mute"}
                    >
                      {muted ? <VolumeX className="w-3.5 h-3.5" /> : <Volume2 className="w-3.5 h-3.5" />}
                    </button>
                  </div>

                  {/* Row 2: Integrated BGM Play/Pause + Seek Slider + Timestamp */}
                  <div className="flex items-center gap-2.5">
                    <button
                      type="button"
                      aria-label={bgmPlaying ? "Pause" : "Play"}
                      onClick={() => {
                        const playing = AudioMixer.toggleBgmPlayPause();
                        setBgmPlaying(playing);
                      }}
                      className="h-8 w-8 rounded-full border border-slate-700/80 bg-[#182436] text-slate-200 hover:bg-slate-700 flex items-center justify-center shrink-0 transition"
                      title={
                        currentTurn.stateBefore.audio.bgmTitle
                          ? `${bgmPlaying ? "Pause" : "Play"} BGM (${currentTurn.stateBefore.audio.bgmTitle})`
                          : "BGM Play/Pause"
                      }
                    >
                      {bgmPlaying ? (
                        <Pause className="w-3.5 h-3.5" />
                      ) : (
                        <Play className="w-3.5 h-3.5 ml-0.5" />
                      )}
                    </button>

                    <input
                      type="range"
                      aria-label="Seek"
                      min={0}
                      max={Math.max(1, bgmTime.duration)}
                      step={0.1}
                      value={bgmTime.currentTime}
                      onChange={(e) => {
                        const t = parseFloat(e.target.value);
                        AudioMixer.seekBgm(t);
                        setBgmTime((prev) => ({ ...prev, currentTime: t }));
                      }}
                      className="flex-1 accent-[#58a6ff] cursor-pointer"
                    />

                    <span className="text-[11px] font-mono text-slate-400 tabular-nums shrink-0">
                      {formatMmSs(bgmTime.currentTime)} / {formatMmSs(bgmTime.duration)}
                    </span>
                  </div>

                  {currentTurn.stateBefore.audio.bgmTitle && (
                    <div className="px-1 flex items-center gap-1.5 text-[11px] text-slate-400">
                      <Music className="w-3 h-3 text-[#7c9ff5] shrink-0" />
                      <span className="truncate">
                        BGM: <span className="text-slate-200">{currentTurn.stateBefore.audio.bgmTitle}</span>
                      </span>
                    </div>
                  )}

                  {/* Expandable Per-Channel Volume Sliders */}
                  {perChannelOpen && (
                    <div className="pt-2.5 border-t border-slate-800/90 space-y-2 text-xs">
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-slate-400 w-16">Voice</span>
                        <input
                          type="range"
                          aria-label="Voice volume"
                          min={0}
                          max={1}
                          step={0.01}
                          value={voiceVol}
                          onChange={(e) => setVoiceVol(parseFloat(e.target.value))}
                          className="flex-1 accent-[#58a6ff]"
                        />
                        <span className="w-9 text-right font-mono text-slate-300">
                          {Math.round(voiceVol * 100)}%
                        </span>
                      </div>
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-slate-400 w-16">BGM</span>
                        <input
                          type="range"
                          aria-label="BGM volume"
                          min={0}
                          max={1}
                          step={0.01}
                          value={bgmVol}
                          onChange={(e) => setBgmVol(parseFloat(e.target.value))}
                          className="flex-1 accent-[#58a6ff]"
                        />
                        <span className="w-9 text-right font-mono text-slate-300">
                          {Math.round(bgmVol * 100)}%
                        </span>
                      </div>
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-slate-400 w-16">SE</span>
                        <input
                          type="range"
                          aria-label="SE volume"
                          min={0}
                          max={1}
                          step={0.01}
                          value={seVol}
                          onChange={(e) => setSeVol(parseFloat(e.target.value))}
                          className="flex-1 accent-[#58a6ff]"
                        />
                        <span className="w-9 text-right font-mono text-slate-300">
                          {Math.round(seVol * 100)}%
                        </span>
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>

            {/* Compact Language / Translation Source Pill Button (EN ▾) */}
            <div className="relative">
              <button
                type="button"
                aria-label={`Translation language: ${(activeTlSource?.lang || "en").toUpperCase()}`}
                aria-expanded={langMenuOpen}
                onClick={() => {
                  setLangMenuOpen((v) => !v);
                  setVolumeOpen(false);
                }}
                className="h-9 rounded-full border border-slate-700/80 bg-[#111927] hover:bg-[#182336] px-3.5 text-xs font-semibold text-slate-100 inline-flex items-center gap-1.5 transition"
              >
                <BookOpen className="w-3.5 h-3.5 text-[#7c9ff5]" />
                <span>{(activeTlSource?.lang || "en").toUpperCase()}</span>
                <span className="text-slate-400 text-[10px]">▾</span>
              </button>

              {langMenuOpen && (
                <div className="absolute left-0 mt-2 w-72 rounded-2xl border border-slate-700/90 bg-[#121b29]/95 p-3.5 shadow-2xl backdrop-blur-xl z-50 space-y-3 text-xs">
                  <div>
                    <label className="block text-[11px] font-medium text-slate-400 mb-1">
                      Translation source
                    </label>
                    <select
                      aria-label="Translation source"
                      value={settings.primaryTranslationId}
                      onChange={(e) =>
                        setSettings((s) => ({ ...s, primaryTranslationId: e.target.value }))
                      }
                      className="w-full rounded-lg border border-slate-700 bg-[#0b1018] px-2.5 py-1.5 text-slate-100"
                    >
                      {scenario.translationSources.map((src) => (
                        <option key={src.id} value={src.id}>
                          {src.label}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label className="block text-[11px] font-medium text-slate-400 mb-1">
                      Second language
                    </label>
                    <select
                      aria-label="Second language"
                      value={settings.showSecondaryLanguage ? "jp" : "off"}
                      onChange={(e) =>
                        setSettings((s) => ({
                          ...s,
                          showSecondaryLanguage: e.target.value === "jp",
                        }))
                      }
                      className="w-full rounded-lg border border-slate-700 bg-[#0b1018] px-2.5 py-1.5 text-slate-100"
                    >
                      <option value="jp">日本語 (Official JP)</option>
                      <option value="off">Off (Primary only)</option>
                    </select>
                  </div>
                </div>
              )}
            </div>
          </div>

          {/* Unified Pill Search + Speaker Filter Bar (Cleista header style) */}
          <div className="flex-1 max-w-lg flex items-center h-9 rounded-full border border-slate-700/80 bg-[#111927] overflow-hidden">
            <div className="flex-1 flex items-center pl-3 pr-2 min-w-0">
              <Search className="w-3.5 h-3.5 text-slate-400 shrink-0 mr-2" />
              <input
                type="search"
                aria-label="Search"
                placeholder="Search"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="w-full bg-transparent text-xs text-slate-100 placeholder:text-slate-400 focus:outline-none"
              />
              {searchQuery && (
                <button
                  type="button"
                  aria-label="Clear search"
                  onClick={() => setSearchQuery("")}
                  className="text-slate-400 hover:text-white p-0.5"
                >
                  <X className="w-3 h-3" />
                </button>
              )}
            </div>
            <div className="h-5 w-px bg-slate-700/80" />
            <div className="flex items-center px-3 shrink-0">
              <User className="w-3.5 h-3.5 text-slate-400 mr-1.5 shrink-0" />
              <select
                aria-label="Speaker…"
                value={speakerFilter}
                onChange={(e) => setSpeakerFilter(e.target.value)}
                className="bg-transparent text-xs text-slate-200 focus:outline-none cursor-pointer max-w-[110px]"
              >
                <option value="ALL" className="bg-slate-900">
                  Speaker…
                </option>
                {uniqueSpeakers.map((sp) => (
                  <option key={sp} value={sp} className="bg-slate-900">
                    {sp}
                  </option>
                ))}
              </select>
            </div>
          </div>

          {/* Right Header Buttons: Credits & Menu Drawer */}
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setCreditsOpen(true)}
              className="hidden sm:inline-flex items-center gap-1.5 h-9 rounded-full border border-slate-700/80 bg-[#111927] hover:bg-[#182336] px-3.5 text-xs font-medium text-slate-200 transition"
              title="Translation & data credits"
            >
              <Info className="w-3.5 h-3.5 text-[#7c9ff5]" />
              <span>Credits</span>
            </button>

            <button
              type="button"
              aria-label="Open menu"
              aria-expanded={sidebarOpen}
              onClick={() => setSidebarOpen((v) => !v)}
              className={`h-9 w-9 rounded-full border flex items-center justify-center transition ${
                sidebarOpen
                  ? "border-[#7c9ff5] bg-[#162235] text-white"
                  : "border-slate-700/80 bg-[#111927] text-slate-200 hover:bg-[#182336]"
              }`}
              title="Episodes & Navigation Menu"
            >
              <Menu className="w-4 h-4" />
            </button>
          </div>
        </div>
      </header>

      {/* Story selector, modelled on the game's 活動記録 screen */}
      <StorySelector
        open={sidebarOpen}
        currentScriptId={activeScriptId}
        catalog={catalog}
        formatDuration={formatMmSs}
        onClose={() => setSidebarOpen(false)}
        onSelect={(scriptId) => {
          setActiveScriptId(scriptId);
          setSidebarOpen(false);
        }}
        onHoverPart={(scriptId) => {
          const ep = catalog.find((e) => e.scriptId === scriptId);
          if (ep && settings.enable3DStage && settings.prefetchMode !== "off") {
            prewarmEpisodeCast(ep.castCharacters, ep.initialBackgroundUrl);
          }
        }}
        headerExtras={
          <>
            <button
              type="button"
              onClick={() => {
                setCreditsOpen(true);
                setSidebarOpen(false);
              }}
              className="text-xs text-slate-300 hover:text-white underline decoration-dotted"
            >
              Contributors & Credits
            </button>
            <a
              href="https://introtohasu.carrd.co/#watchorder"
              target="_blank"
              rel="noreferrer"
              className="hidden sm:inline-flex items-center gap-1 text-xs text-sky-400 hover:underline"
            >
              IntroToHasu Watch Order <ExternalLink className="w-3 h-3" />
            </a>
          </>
        }
      />

      {/* Main Reader Container */}
      <main
        className={`flex-1 w-full mx-auto px-3 sm:px-5 py-3 flex flex-col gap-3 ${
          twoColPageLayout ? "max-w-[1440px]" : "max-w-5xl"
        }`}
      >
        {/* Top Breadcrumb Bar + Toggle 1/2 Column Layout Button (Cleista style) */}
        <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-slate-300 px-0.5">
          <div className="flex items-center gap-1.5 flex-wrap">
            <button
              type="button"
              onClick={() => setSidebarOpen((v) => !v)}
              className="font-semibold text-slate-200 hover:text-white inline-flex items-center gap-1 transition"
            >
              ← Back
            </button>
            <span className="text-slate-600">·</span>
            <span className="font-semibold text-slate-100">
              {scenario.episode.seriesTitleEn}
            </span>
            <span className="text-slate-600">·</span>
            <span className="font-semibold text-slate-200">
              {scenario.episode.partTitleEn}
            </span>
          </div>

          <button
            type="button"
            onClick={() => setTwoColPageLayout((v) => !v)}
            className="inline-flex items-center gap-1.5 rounded-full border border-slate-700/80 bg-[#111927] hover:bg-[#182336] px-3 py-1 text-[11px] font-medium text-slate-200 transition"
          >
            <Columns className="w-3 h-3 text-[#7c9ff5]" />
            <span>Toggle 1/2 column layout</span>
          </button>
        </div>

        {/* Content Grid: 1-column stacked or 2-column side-by-side */}
        <div
          className={
            twoColPageLayout
              ? "grid grid-cols-1 xl:grid-cols-12 gap-5 items-start"
              : "flex flex-col gap-3.5"
          }
        >
          {/* Left / Top Player Column */}
          <div
            className={
              twoColPageLayout
                ? "xl:col-span-7 xl:sticky xl:top-16 flex flex-col gap-3"
                : "flex flex-col gap-3"
            }
          >
            {/* 1. Interactive 16:9 3D Stage Canvas + Overlaid Controls & Bilingual Subtitles */}
            <div
              ref={stageContainerRef}
              className={`relative w-full aspect-video mx-auto overflow-hidden border border-slate-800/90 bg-slate-950 shadow-2xl ${
                settings.removeRoundedCorners || isFullscreen ? "rounded-none" : "rounded-2xl"
              }`}
            >
              {/* Three.js 3D WebGL Stage */}
              <StageCanvas
                turn={currentTurn}
                cameraMode={settings.cameraMode}
                enable3D={settings.enable3DStage}
                resolution={settings.stageResolution}
                audioMixer={AudioMixer}
                onAdvance={handleStageOrKeyAdvance}
                onStageReady={setStageReadyTurn}
              />

              {/* Floating White Pill Controls on Stage Canvas (exact pjsk.cleista.cc layout) */}
              <div className="absolute top-3.5 inset-x-4 z-20 flex items-center justify-between gap-2 pointer-events-none">
                {/* Top-Left White Back Pill */}
                <button
                  type="button"
                  aria-label={`Back to ${scenario.episode.seriesTitleEn}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    setSidebarOpen((v) => !v);
                  }}
                  className="pointer-events-auto h-9 px-5 rounded-full bg-white/95 hover:bg-white text-slate-900 shadow-lg flex items-center justify-center transition"
                  title="Episodes list"
                >
                  <ArrowLeft className="w-4 h-4 stroke-[2.2]" />
                </button>

                {/* Top-Right White Floating Controls: Camera Mode, Autoplay, Reader Settings, Fullscreen */}
                <div className="pointer-events-auto flex items-center gap-2">
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      setSettings((s) => ({
                        ...s,
                        cameraMode: s.cameraMode === "adv" ? "orbit" : "adv",
                      }));
                    }}
                    className={`h-9 px-3 rounded-full text-xs font-semibold shadow-lg flex items-center gap-1.5 transition ${
                      settings.cameraMode === "orbit"
                        ? "bg-amber-400 text-slate-950"
                        : "bg-white/95 hover:bg-white text-slate-900"
                    }`}
                    title="Switch between Scripted ADV Camera and Free 3D Orbit Camera"
                  >
                    <Camera className="w-3.5 h-3.5" />
                    <span className="hidden sm:inline">
                      {settings.cameraMode === "adv" ? "ADV Cam" : "3D Orbit"}
                    </span>
                  </button>

                  <button
                    type="button"
                    aria-label="Autoplay"
                    aria-pressed={autoPlay}
                    onClick={(e) => {
                      e.stopPropagation();
                      toggleAutoPlay();
                    }}
                    className={`h-9 w-9 rounded-full shadow-lg flex items-center justify-center transition ${
                      autoPlay
                        ? "bg-[#7c9ff5] text-slate-950"
                        : "bg-white/95 hover:bg-white text-slate-900"
                    }`}
                    title="Autoplay"
                  >
                    {autoPlay ? (
                      <Pause className="w-4 h-4 fill-current" />
                    ) : (
                      <Play className="w-4 h-4 fill-current ml-0.5" />
                    )}
                  </button>

                  <button
                    type="button"
                    aria-label="Reader settings"
                    aria-expanded={settingsOpen}
                    onClick={(e) => {
                      e.stopPropagation();
                      setSettingsOpen((v) => !v);
                    }}
                    className={`h-9 w-9 rounded-full shadow-lg flex items-center justify-center transition ${
                      settingsOpen
                        ? "bg-[#7c9ff5] text-slate-950"
                        : "bg-white/95 hover:bg-white text-slate-900"
                    }`}
                    title="Reader settings"
                  >
                    <Settings className="w-4 h-4" />
                  </button>

                  <button
                    type="button"
                    aria-label="Toggle fullscreen"
                    onClick={(e) => {
                      e.stopPropagation();
                      toggleFullscreen();
                    }}
                    className="h-9 px-4 rounded-full bg-white/95 hover:bg-white text-slate-900 shadow-lg flex items-center justify-center transition"
                    title="Toggle fullscreen"
                  >
                    {isFullscreen ? (
                      <Minimize2 className="w-4 h-4" />
                    ) : (
                      <Maximize2 className="w-4 h-4" />
                    )}
                  </button>
                </div>
              </div>

              {/* Optional Stage Debug Info Overlay (toggled in Reading Settings) */}
              {settings.showDebugInfo && (
                <div className="absolute top-14 left-4 z-20 rounded-xl bg-slate-950/85 border border-slate-700/80 px-3 py-2 text-[11px] font-mono text-slate-200 backdrop-blur-md pointer-events-none space-y-0.5 max-w-md">
                  <div>
                    Script: <span className="text-amber-300">{scenario.scriptId}</span> · Line{" "}
                    {currentTurn.lineNumber}/{scenario.totalTurns} (script L
                    {currentTurn.scriptLineNum})
                  </div>
                  <div>
                    BG:{" "}
                    <span className="text-sky-300">
                      {currentTurn.stateBefore.background.bgId || "none"}
                    </span>{" "}
                    ({currentTurn.stateBefore.background.comment || "—"})
                  </div>
                  <div>
                    BGM:{" "}
                    <span className="text-emerald-300">
                      {currentTurn.stateBefore.audio.bgmTitle || "none"}
                    </span>{" "}
                    · Cam: [{currentTurn.stateBefore.camera.position.join(", ")}]
                  </div>
                  {currentTurn.voiceId && (
                    <div>
                      Voice: <span className="text-purple-300">{currentTurn.voiceId}</span> (
                      {currentTurn.voiceStartSec.toFixed(2)}s–
                      {currentTurn.voiceEndSec !== null
                        ? `${currentTurn.voiceEndSec.toFixed(2)}s`
                        : "end"}
                      )
                    </div>
                  )}
                  {activeCast.map((c) => (
                    <div key={c.name} className="text-slate-300">
                      {c.nameEn}: {c.costumeId} · {c.emotion} · {c.motionId} ({c.motionDescription})
                    </div>
                  ))}
                </div>
              )}

              {/* Frameless Text-Stroke Bilingual Subtitle Overlay on Stage (pjsk.cleista.cc style) */}
              <div
                onClick={handleStageOrKeyAdvance}
                className="absolute inset-x-0 bottom-0 z-20 bg-gradient-to-t from-slate-950/75 via-slate-950/35 to-transparent pt-10 pb-5 px-6 sm:px-10 cursor-pointer"
              >
                <div
                  className={`max-w-4xl mx-auto grid gap-6 ${
                    showDualCanvasSubtitles && settings.subtitleLayout === "side-by-side"
                      ? "grid-cols-1 md:grid-cols-2"
                      : "grid-cols-1"
                  }`}
                >
                  {/* Left: Primary Language (Translation) with Speaker Underline Accent */}
                  <div>
                    {(activeTranslation.speaker || currentTurn.speakerEn) && (
                      <div className="mb-1.5">
                        <span className="inline-block text-base sm:text-lg font-bold text-white cleista-speaker-stroke">
                          {activeTranslation.speaker || currentTurn.speakerEn}
                        </span>
                        <div
                          className="h-[3px] w-20 rounded-full mt-0.5 shadow-sm"
                          style={{
                            backgroundColor: currentTurn.characterColor || "#94a3b8",
                          }}
                        />
                      </div>
                    )}
                    <p className="text-base sm:text-lg md:text-[21px] font-semibold text-white leading-snug whitespace-pre-wrap cleista-stroke">
                      {activeTranslation.text.slice(0, revealedChars)}
                    </p>
                  </div>

                  {/* Right: Second Language (Japanese) with Ruby Furigana & Interactive Word Lookup */}
                  {showDualCanvasSubtitles && (
                    <div className="font-jp">
                      {currentTurn.speakerJp && (
                        <div className="mb-1.5">
                          <span className="inline-block text-base sm:text-lg font-bold text-white cleista-speaker-stroke">
                            {currentTurn.speakerJp}
                          </span>
                          <div
                            className="h-[3px] w-20 rounded-full mt-0.5 shadow-sm"
                            style={{
                              backgroundColor: currentTurn.characterColor || "#94a3b8",
                            }}
                          />
                        </div>
                      )}
                      <JapaneseLookupText
                        tokens={currentTurn.tokensJp}
                        text={currentTurn.textJp}
                        lexicon={scenario.lexicon ?? {}}
                        tags={scenario.lexTags ?? {}}
                        showFurigana={settings.showFurigana}
                        maxChars={revealedChars}
                        className="text-base sm:text-lg md:text-[21px] font-semibold text-white cleista-stroke"
                      />
                    </div>
                  )}
                </div>
              </div>
            </div>

            {/* 2. Cleista Middle Transport Bar */}
            <div className="px-1 py-1 flex flex-wrap items-center justify-between gap-3">
              <div className="flex items-center gap-2 flex-wrap">
                <button
                  type="button"
                  aria-label="Previous line"
                  onClick={handlePrev}
                  disabled={currentTurnIndex === 0}
                  className="inline-flex items-center gap-1.5 rounded-full border border-slate-700/80 bg-[#0f1724] hover:bg-[#172234] px-5 py-2 text-xs sm:text-sm font-semibold text-slate-200 disabled:opacity-40 transition"
                >
                  <ChevronLeft className="w-4 h-4" /> Prev
                </button>

                <button
                  type="button"
                  aria-label="Next line"
                  onClick={handleNext}
                  disabled={!stageReady || currentTurnIndex >= scenario.turns.length - 1}
                  aria-busy={!stageReady}
                  title={stageReady ? undefined : "Loading this line's stage…"}
                  className="inline-flex items-center gap-1.5 rounded-full bg-[#7c9ff5] hover:bg-[#91b0fa] px-6 py-2 text-xs sm:text-sm font-bold text-slate-950 shadow-[0_0_22px_rgba(124,159,245,0.45)] disabled:opacity-40 transition"
                >
                  <ChevronRight className="w-4 h-4 stroke-[2.5]" /> Next
                </button>

                <button
                  type="button"
                  onClick={toggleAutoPlay}
                  aria-pressed={autoPlay}
                  className={`inline-flex items-center gap-2 rounded-full border px-5 py-2 text-xs sm:text-sm font-semibold transition ${
                    autoPlay
                      ? "border-[#7c9ff5] bg-[#7c9ff5]/20 text-[#b8ccff] shadow-[0_0_16px_rgba(124,159,245,0.3)]"
                      : "border-slate-700/80 bg-[#0f1724] hover:bg-[#172234] text-slate-200"
                  }`}
                >
                  {autoPlay ? (
                    <Pause className="w-3.5 h-3.5 fill-current" />
                  ) : (
                    <Play className="w-3.5 h-3.5 fill-current" />
                  )}
                  Auto
                </button>

                <button
                  type="button"
                  onClick={() => AudioMixer.replayVoice()}
                  disabled={!currentTurn.voiceUrl}
                  className="inline-flex items-center gap-2 rounded-full border border-slate-700/80 bg-[#0f1724] hover:bg-[#172234] px-5 py-2 text-xs sm:text-sm font-semibold text-slate-200 disabled:opacity-40 transition"
                  title="Replay current character voice line"
                >
                  <RotateCcw className="w-3.5 h-3.5" /> Voice
                </button>
              </div>

              {/* Story Progress Slider + Stacked Line Counter & Remaining Time + Reading Settings Toggle */}
              <div className="flex-1 min-w-[200px] flex items-center justify-end gap-3.5">
                <input
                  type="range"
                  aria-label="Story progress (drag to jump to line)"
                  min={0}
                  max={scenario.turns.length - 1}
                  value={currentTurnIndex}
                  onChange={(e) => goToTurn(parseInt(e.target.value, 10))}
                  className="flex-1 max-w-xs accent-[#58a6ff] cursor-pointer"
                />

                <div className="text-right leading-tight shrink-0 tabular-nums">
                  <div className="text-xs sm:text-sm font-bold text-slate-100">
                    {currentTurn.lineNumber} / {scenario.totalTurns}
                  </div>
                  <div className="text-[11px] text-slate-400">
                    {formatMmSs(remainingSec)} left
                  </div>
                </div>

                <button
                  type="button"
                  aria-label="Reading settings"
                  aria-expanded={settingsOpen}
                  onClick={() => setSettingsOpen((v) => !v)}
                  className={`h-10 w-10 rounded-xl border flex items-center justify-center shrink-0 transition ${
                    settingsOpen
                      ? "border-[#7c9ff5] bg-[#162338] text-[#9db8ff] shadow-[0_0_16px_rgba(124,159,245,0.4)]"
                      : "border-slate-700/80 bg-[#0f1724] hover:bg-[#172234] text-slate-300"
                  }`}
                  title="Reading settings"
                >
                  <SlidersHorizontal className="w-4 h-4" />
                </button>
              </div>
            </div>

            {/* 3. Inline Collapsible Reading Settings Panel (exact pjsk.cleista.cc drawer style) */}
            {settingsOpen && (
              <div className="rounded-2xl border border-slate-800/90 bg-[#0c1420] p-4 sm:p-5 text-xs text-slate-300 shadow-xl space-y-4">
                {/* Row 1: Text speed, Second language, Translation source */}
                <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
                  <div
                    className="flex items-center gap-2.5"
                    title="How fast dialogue text types out. 1x matches the game, higher is faster."
                  >
                    <span className="text-slate-400">Text speed:</span>
                    <input
                      type="range"
                      aria-label="Text reveal speed (1x to 5x)"
                      min={1}
                      max={5}
                      step={1}
                      value={settings.textSpeed}
                      onChange={(e) =>
                        setSettings((s) => ({
                          ...s,
                          textSpeed: parseInt(e.target.value, 10),
                        }))
                      }
                      className="w-28 accent-[#58a6ff]"
                    />
                    <span className="font-semibold text-slate-200 w-6">
                      {settings.textSpeed}x
                    </span>
                  </div>

                  <div
                    className="flex items-center gap-2"
                    title="Show a second language alongside the primary text."
                  >
                    <span className="text-slate-400">Second language:</span>
                    <select
                      aria-label="Second language:"
                      value={settings.showSecondaryLanguage ? "jp" : "off"}
                      onChange={(e) =>
                        setSettings((s) => ({
                          ...s,
                          showSecondaryLanguage: e.target.value === "jp",
                        }))
                      }
                      className="rounded-lg border border-slate-700/80 bg-[#111b2a] px-2.5 py-1.5 text-slate-100 font-medium"
                    >
                      <option value="off">Off</option>
                      <option value="jp">日本語 (JP)</option>
                    </select>
                  </div>

                  <div
                    className="flex items-center gap-2"
                    title="Select which community or curated translation source to display."
                  >
                    <span className="text-slate-400">Translation source:</span>
                    <select
                      aria-label="Translation source:"
                      value={settings.primaryTranslationId}
                      onChange={(e) =>
                        setSettings((s) => ({
                          ...s,
                          primaryTranslationId: e.target.value,
                        }))
                      }
                      className="rounded-lg border border-slate-700/80 bg-[#111b2a] px-2.5 py-1.5 text-slate-100 font-medium"
                    >
                      {scenario.translationSources.map((src) => (
                        <option key={src.id} value={src.id}>
                          {src.label}
                        </option>
                      ))}
                    </select>
                  </div>
                </div>

                {/* Row 2: Furigana, Hide Primary Language, Prefetch, 3D Characters & Resolution */}
                <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
                  <label className="inline-flex items-center gap-2 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={settings.showFurigana}
                      onChange={(e) =>
                        setSettings((s) => ({ ...s, showFurigana: e.target.checked }))
                      }
                      className="accent-[#58a6ff] h-4 w-4 rounded"
                    />
                    <span>Show Furigana (Ruby)</span>
                  </label>

                  <label className="inline-flex items-center gap-2 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={settings.hidePrimaryWhenTranslated}
                      onChange={(e) =>
                        setSettings((s) => ({
                          ...s,
                          hidePrimaryWhenTranslated: e.target.checked,
                        }))
                      }
                      className="accent-[#58a6ff] h-4 w-4 rounded"
                    />
                    <span>Hide Second Language on stage</span>
                  </label>

                  <div
                    className="flex items-center gap-2"
                    title="How far ahead the reader warms upcoming 3D models, motions, backgrounds, and voice/BGM/SE assets from the episode manifest."
                  >
                    <span className="text-slate-400">Prefetch:</span>
                    <select
                      aria-label="Prefetch:"
                      value={settings.prefetchMode}
                      onChange={(e) =>
                        setSettings((s) => ({
                          ...s,
                          prefetchMode: e.target.value as PrefetchMode,
                        }))
                      }
                      className="rounded-lg border border-slate-700/80 bg-[#111b2a] px-2.5 py-1.5 text-slate-100 font-medium"
                    >
                      <option value="off">Off</option>
                      <option value="next1">Next 1</option>
                      <option value="next5">Next 5</option>
                      <option value="all">All scenes</option>
                    </select>
                    {preloadProgress.total > 0 && (
                      <span
                        className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-medium tabular-nums ${
                          preloadProgress.tier === "done"
                            ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-300"
                            : "border-sky-500/30 bg-sky-500/10 text-sky-300"
                        }`}
                        title="Background preloader status from episode assetManifest"
                      >
                        {preloadProgress.tier === "done"
                          ? `${preloadProgress.loaded}/${preloadProgress.total} ready`
                          : `Warming ${preloadProgress.loaded}/${preloadProgress.total}`}
                      </span>
                    )}
                  </div>

                  <label className="inline-flex items-center gap-2 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={settings.enable3DStage}
                      onChange={(e) =>
                        setSettings((s) => ({ ...s, enable3DStage: e.target.checked }))
                      }
                      className="accent-[#58a6ff] h-4 w-4 rounded"
                    />
                    <span>3D characters</span>
                  </label>

                  <div className="flex items-center gap-2">
                    <span className="text-slate-400">3D resolution:</span>
                    <select
                      aria-label="3D resolution:"
                      value={settings.stageResolution}
                      onChange={(e) =>
                        setSettings((s) => ({
                          ...s,
                          stageResolution: e.target.value as StageResolution,
                        }))
                      }
                      className="rounded-lg border border-slate-700/80 bg-[#111b2a] px-2.5 py-1.5 text-slate-100 font-medium"
                    >
                      <option value="auto">Auto (match screen)</option>
                      <option value="low">Low</option>
                      <option value="medium">Medium</option>
                      <option value="high">High</option>
                      <option value="ultra">Ultra</option>
                    </select>
                  </div>
                </div>

                {/* Row 3: Pause when tab hidden, Remove rounded corners, Debug info, Auto delay */}
                <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
                  <label
                    className="inline-flex items-center gap-2 cursor-pointer"
                    title="Pause BGM, voice, and auto-advance when this tab is hidden, resume when you come back"
                  >
                    <input
                      type="checkbox"
                      checked={settings.pauseWhenHidden}
                      onChange={(e) =>
                        setSettings((s) => ({ ...s, pauseWhenHidden: e.target.checked }))
                      }
                      className="accent-[#58a6ff] h-4 w-4 rounded"
                    />
                    <span>Pause when tab hidden</span>
                  </label>

                  <label className="inline-flex items-center gap-2 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={settings.removeRoundedCorners}
                      onChange={(e) =>
                        setSettings((s) => ({
                          ...s,
                          removeRoundedCorners: e.target.checked,
                        }))
                      }
                      className="accent-[#58a6ff] h-4 w-4 rounded"
                    />
                    <span>Remove rounded corners</span>
                  </label>

                  <label
                    className="inline-flex items-center gap-2 cursor-pointer"
                    title="Show Scenario/BGM/BG/Cast debug badges on the stage"
                  >
                    <input
                      type="checkbox"
                      checked={settings.showDebugInfo}
                      onChange={(e) =>
                        setSettings((s) => ({ ...s, showDebugInfo: e.target.checked }))
                      }
                      className="accent-[#58a6ff] h-4 w-4 rounded"
                    />
                    <span>Debug info</span>
                  </label>

                  <div className="flex items-center gap-2">
                    <span className="text-slate-400">Auto pause:</span>
                    <input
                      type="range"
                      min={0.2}
                      max={3}
                      step={0.1}
                      value={settings.autoPlayDelaySec}
                      onChange={(e) =>
                        setSettings((s) => ({
                          ...s,
                          autoPlayDelaySec: parseFloat(e.target.value),
                        }))
                      }
                      className="w-20 accent-[#58a6ff]"
                    />
                    <span className="font-mono text-slate-200">
                      {settings.autoPlayDelaySec.toFixed(1)}s
                    </span>
                  </div>
                </div>

                {/* Attribution Footer inside Settings Drawer */}
                <div className="pt-2 border-t border-slate-800/80 text-[11px] italic text-slate-400 flex flex-wrap items-center justify-between gap-2">
                  <span>
                    Japanese dictionary data from the{" "}
                    <a
                      href="https://www.edrdg.org/wiki/index.php/Main_Page"
                      target="_blank"
                      rel="noreferrer"
                      className="underline hover:text-slate-200"
                    >
                      EDRDG
                    </a>{" "}
                    JMdict / JMnedict project, used under{" "}
                    <a
                      href="https://creativecommons.org/licenses/by-sa/4.0/"
                      target="_blank"
                      rel="noreferrer"
                      className="underline hover:text-slate-200"
                    >
                      CC BY-SA 4.0
                    </a>
                    .
                  </span>
                  <button
                    type="button"
                    onClick={() => setCreditsOpen(true)}
                    className="not-italic font-medium text-[#9db8ff] hover:underline"
                  >
                    View all translation & asset credits →
                  </button>
                </div>
              </div>
            )}
          </div>

          {/* Right / Bottom Script Column */}
          <section
            aria-label="Interactive Bilingual Script"
            className={
              twoColPageLayout
                ? "xl:col-span-5 flex flex-col gap-2.5"
                : "flex flex-col gap-2.5 mt-1"
            }
          >
            {/* Cleista Script Header Row */}
            <div className="flex flex-wrap items-center justify-between gap-2 px-1">
              <div className="flex items-center gap-3">
                <h2 className="text-lg font-bold text-white tracking-tight">Script</h2>
                <button
                  type="button"
                  onClick={() => setCreditsOpen(true)}
                  className="rounded-full border border-slate-700/80 bg-[#0f1724] hover:bg-[#172234] px-4 py-1.5 text-xs font-semibold text-slate-200 transition"
                >
                  Credits & Sources
                </button>
                {activeTlSource && (
                  <span className="hidden sm:inline text-xs text-slate-400">
                    TL:{" "}
                    {activeTlSource.url ? (
                      <a
                        href={activeTlSource.url}
                        target="_blank"
                        rel="noreferrer"
                        className="text-[#9db8ff] hover:underline inline-flex items-center gap-1"
                      >
                        {activeTlSource.attribution} <ExternalLink className="w-3 h-3" />
                      </a>
                    ) : (
                      <span className="text-slate-300">{activeTlSource.attribution}</span>
                    )}
                  </span>
                )}
              </div>

              <div className="flex items-center gap-2">
                {(searchQuery || speakerFilter !== "ALL") && (
                  <span className="text-xs text-[#9db8ff]">
                    Showing {filteredTurns.length} of {scenario.totalTurns} lines
                  </span>
                )}
                <button
                  type="button"
                  onClick={() => setTwoColTranscript((v) => !v)}
                  className="inline-flex items-center gap-1.5 rounded-full border border-slate-700/80 bg-[#0f1724] hover:bg-[#172234] px-3 py-1 text-xs font-medium text-slate-300 transition"
                >
                  <Columns className="w-3.5 h-3.5 text-[#7c9ff5]" />
                  <span>{twoColTranscript ? "2-Col Script" : "1-Col Script"}</span>
                </button>
              </div>
            </div>

            {/* Script Listbox Container */}
            <div
              ref={scriptListRef}
              role="listbox"
              aria-label="Script"
              className={`rounded-2xl border border-slate-800/90 bg-[#0c131f] overflow-y-auto divide-y divide-slate-800/50 shadow-xl ${
                twoColPageLayout ? "max-h-[78vh]" : "max-h-[48vh]"
              }`}
            >
              {filteredTurns.map((t) => {
                const isActive = t.index === currentTurn.index;
                const tl =
                  t.translations[settings.primaryTranslationId] ||
                  Object.values(t.translations)[0] || {
                    speaker: t.speakerEn,
                    text: "",
                  };
                const prevTurn = t.index > 0 ? scenario.turns[t.index - 1] : null;
                const sceneChanged =
                  !prevTurn ||
                  prevTurn.stateBefore.background.bgId !==
                    t.stateBefore.background.bgId ||
                  prevTurn.stateBefore.background.comment !==
                    t.stateBefore.background.comment;
                const sceneCommentJp = t.stateBefore.background.comment;
                const sceneCommentEn = translateSceneComment(sceneCommentJp);

                return (
                  <React.Fragment key={t.index}>
                    {/* Bilingual Scene Change Header (✦ Location EN | ✦ Location JP) */}
                    {sceneChanged && sceneCommentJp && (
                      <div
                        role="option"
                        aria-selected={false}
                        onClick={() => goToTurn(t.index)}
                        className={`bg-[#0e1726]/90 px-4 py-2.5 text-xs text-slate-400 cursor-pointer hover:bg-slate-800/40 grid gap-3 ${
                          twoColTranscript ? "grid-cols-1 md:grid-cols-2" : "grid-cols-1"
                        }`}
                      >
                        <div className="flex items-center gap-2 font-medium text-slate-300">
                          <Sparkles className="w-3.5 h-3.5 text-[#7c9ff5] shrink-0" />
                          <span>{sceneCommentEn}</span>
                        </div>
                        {twoColTranscript && (
                          <div className="flex items-center justify-between gap-2 md:pl-3 font-jp text-slate-300">
                            <span className="inline-flex items-center gap-2">
                              <Sparkles className="w-3.5 h-3.5 text-[#7c9ff5] shrink-0" />
                              {sceneCommentJp}
                            </span>
                            {t.stateBefore.audio.bgmTitle && (
                              <span className="text-[11px] text-slate-400">
                                ♪ {t.stateBefore.audio.bgmTitle}
                              </span>
                            )}
                          </div>
                        )}
                      </div>
                    )}

                    {/* Dialogue Row */}
                    <div
                      ref={isActive ? activeRowRef : null}
                      role="option"
                      aria-selected={isActive}
                      onClick={() => goToTurn(t.index)}
                      className={`px-4 py-3.5 cursor-pointer transition flex items-start gap-3.5 ${
                        isActive
                          ? "bg-[#7c9ff5]/15 border-l-4 border-l-[#7c9ff5]"
                          : "hover:bg-slate-800/35"
                      }`}
                    >
                      {/* Character Avatar */}
                      <div className="flex items-center gap-2 shrink-0 pt-0.5">
                        {t.iconUrl ? (
                          <img
                            src={t.iconUrl}
                            alt={t.speakerEn}
                            className="w-10 h-10 rounded-full object-cover border border-slate-700/80 bg-slate-800"
                          />
                        ) : (
                          <div className="w-10 h-10 rounded-full bg-slate-800/80 border border-slate-700 flex items-center justify-center text-xs font-bold text-slate-400">
                            #{t.lineNumber}
                          </div>
                        )}
                      </div>

                      {/* Dual-Column or Single-Column Dialogue Text */}
                      <div
                        className={`flex-1 min-w-0 grid gap-3 ${
                          twoColTranscript ? "grid-cols-1 md:grid-cols-2" : "grid-cols-1"
                        }`}
                      >
                        {/* Left: Translated Column */}
                        <div>
                          <div className="flex items-center gap-2 mb-0.5 flex-wrap">
                            <span
                              className="text-xs font-bold"
                              style={{ color: t.characterColor || "#94a3b8" }}
                            >
                              {tl.speaker || t.speakerEn || "Narration"}
                            </span>
                            {t.voiceTotalParts > 1 && (
                              <span
                                className="rounded-full bg-[#7c9ff5]/15 border border-[#7c9ff5]/30 px-2 py-0.2 text-[10px] text-[#9db8ff] font-mono"
                                title={`Shared voice clip ${t.voiceId} (${t.voiceStartSec.toFixed(
                                  2
                                )}s – ${
                                  t.voiceEndSec !== null
                                    ? `${t.voiceEndSec.toFixed(2)}s`
                                    : "end"
                                })`}
                              >
                                Voice {t.voicePart}/{t.voiceTotalParts}
                              </span>
                            )}
                          </div>
                          <p className="text-sm text-slate-200 whitespace-pre-wrap leading-relaxed">
                            {tl.text}
                          </p>
                        </div>

                        {/* Right: Official Japanese Column */}
                        <div className="font-jp border-t md:border-t-0 md:border-l border-slate-800/70 pt-2 md:pt-0 md:pl-3">
                          <div className="flex items-center justify-between gap-2 mb-0.5">
                            <span
                              className="text-xs font-bold"
                              style={{ color: t.characterColor || "#94a3b8" }}
                            >
                              {t.speakerJp || "ナレーション"}
                            </span>
                            <span className="text-[11px] font-mono text-slate-500 tabular-nums">
                              #{t.lineNumber} · {formatMmSs(t.timestampSec)}
                            </span>
                          </div>
                          <JapaneseLookupText
                            tokens={t.tokensJp}
                            text={t.textJp}
                            lexicon={scenario.lexicon ?? {}}
                            tags={scenario.lexTags ?? {}}
                            showFurigana={settings.showFurigana}
                            hoverDelayMs={220}
                            clickToPin={true}
                            className="text-sm text-slate-200"
                          />
                        </div>
                      </div>
                    </div>
                  </React.Fragment>
                );
              })}

              {/* Episode Navigation Footer inside Script Listbox */}
              {(prevEpisode || nextEpisode) && (
                <div className="bg-[#0e1726] p-4 flex flex-wrap items-center justify-between gap-3">
                  {prevEpisode ? (
                    <button
                      type="button"
                      onClick={() => setActiveScriptId(prevEpisode.scriptId)}
                      className="rounded-xl border border-slate-700/80 bg-[#131f33] hover:bg-[#1a2942] px-4 py-2.5 text-left text-xs transition"
                    >
                      <div className="text-slate-400">← Previous Part</div>
                      <div className="font-semibold text-slate-100 mt-0.5">
                        {prevEpisode.seriesTitleEn} · {prevEpisode.partTitleEn}
                      </div>
                    </button>
                  ) : (
                    <div />
                  )}
                  {nextEpisode && (
                    <button
                      type="button"
                      onClick={() => setActiveScriptId(nextEpisode.scriptId)}
                      className="rounded-xl border border-[#7c9ff5]/50 bg-[#7c9ff5]/15 hover:bg-[#7c9ff5]/25 px-4 py-2.5 text-right text-xs transition ml-auto"
                    >
                      <div className="text-[#9db8ff]">Next Part →</div>
                      <div className="font-semibold text-white mt-0.5">
                        {nextEpisode.seriesTitleEn} · {nextEpisode.partTitleEn}
                      </div>
                    </button>
                  )}
                </div>
              )}
            </div>
          </section>
        </div>
      </main>

      {creditsOpen && (
        <CreditsPanel
          translationSources={scenario.translationSources}
          episodeTitle={`${scenario.episode.seriesTitleEn} · ${scenario.episode.partTitleJp}`}
          onClose={() => setCreditsOpen(false)}
        />
      )}
    </div>
  );
}
