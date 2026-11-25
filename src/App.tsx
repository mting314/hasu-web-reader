import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  BookOpen,
  Camera,
  ChevronLeft,
  ChevronRight,
  Columns,
  ExternalLink,
  ListVideo,
  Maximize2,
  Minimize2,
  Music,
  Pause,
  Play,
  RotateCcw,
  Search,
  Settings,
  Sparkles,
  Volume2,
  VolumeX,
  Info,
} from "lucide-react";
import { StageCanvas } from "./components/StageCanvas";
import { JapaneseLookupText } from "./components/JapaneseLookupText";
import { CreditsPanel } from "./components/CreditsPanel";
import { AudioMixer } from "./AudioMixerSingleton";
import {
  CatalogData,
  DialogueTurn,
  EpisodeSummary,
  ReaderSettings,
  ScenarioData,
} from "./typesProxy";

export default function App() {
  const [catalog, setCatalog] = useState<EpisodeSummary[]>([]);
  const [activeScriptId, setActiveScriptId] = useState<string>(() => {
    const params = new URLSearchParams(window.location.search);
    return params.get("script") || "10300101";
  });
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
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [creditsOpen, setCreditsOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [speakerFilter, setSpeakerFilter] = useState("ALL");
  const [twoColTranscript, setTwoColTranscript] = useState(true);

  // Audio volume UI state
  const [masterVol, setMasterVol] = useState(0.85);
  const [bgmVol, setBgmVol] = useState(0.45);
  const [seVol, setSeVol] = useState(0.65);
  const [voiceVol, setVoiceVol] = useState(1.0);
  const [muted, setMuted] = useState(false);

  const [settings, setSettings] = useState<ReaderSettings>({
    primaryTranslationId: "en_curated",
    showSecondaryLanguage: true,
    subtitleLayout: "side-by-side",
    textSpeed: 4,
    enable3DStage: true,
    cameraMode: "adv",
    autoPlayDelaySec: 0.8,
  });

  // Typewriter text reveal state
  const [revealedChars, setRevealedChars] = useState(9999);
  const stageContainerRef = useRef<HTMLDivElement>(null);
  const activeRowRef = useRef<HTMLDivElement>(null);

  // Playback state: a line is "finished" once its voice (or reading time) is done.
  const [lineFinished, setLineFinished] = useState(false);
  const lineStartRef = useRef(performance.now());
  // How the current line was reached: stepping forward keeps one-shot SEs ringing,
  // jumping (transcript click, Prev, scrubber, new episode) cuts them.
  const navKindRef = useRef<"advance" | "seek">("seek");
  const autoPlayRef = useRef(autoPlay);
  autoPlayRef.current = autoPlay;
  // Auto was switched on while the line had already finished -> go to the next line now
  const autoJustEnabledRef = useRef(false);

  // Load episode catalog
  useEffect(() => {
    fetch("/data/catalog.json")
      .then((r) => r.json())
      .then((d: CatalogData) => {
        setCatalog(d.episodes || []);
      })
      .catch((e) => console.error("Failed to load catalog.json:", e));
  }, []);

  // Load selected scenario JSON
  useEffect(() => {
    AudioMixer.stopAll();
    setAutoPlay(false);
    fetch(`/data/scenarios/${activeScriptId}.json`)
      .then((r) => r.json())
      .then((data: ScenarioData) => {
        setScenario(data);
        // Ensure valid translation source
        const availableIds = data.translationSources.map((s) => s.id);
        setSettings((prev) => ({
          ...prev,
          primaryTranslationId: availableIds.includes(prev.primaryTranslationId)
            ? prev.primaryTranslationId
            : availableIds[0] || "en_hasuko",
        }));
        const params = new URLSearchParams(window.location.search);
        const paramScript = params.get("script");
        const paramLine = parseInt(params.get("line") || "1", 10);
        if (paramScript === data.scriptId && !Number.isNaN(paramLine)) {
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

  // Keep URL query params (`?script=...&line=...`) synced
  useEffect(() => {
    if (!scenario || !currentTurn) return;
    const url = new URL(window.location.href);
    url.searchParams.set("script", scenario.scriptId);
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

  /** Jump to a line (transcript click, scrubber): cuts any one-shot sound effects. */
  const goToTurn = useCallback(
    (index: number) => {
      if (!scenario) return;
      navKindRef.current = "seek";
      setCurrentTurnIndex(Math.min(Math.max(0, index), scenario.turns.length - 1));
    },
    [scenario]
  );

  /** Step to the next line (Next button, Space/→, clicking the stage, auto mode). */
  const handleNext = useCallback(() => {
    if (!scenario) return;
    if (currentTurnIndex < scenario.turns.length - 1) {
      navKindRef.current = "advance";
      setCurrentTurnIndex((i) => Math.min(i + 1, scenario.turns.length - 1));
    } else {
      setAutoPlay(false);
    }
  }, [scenario, currentTurnIndex]);

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

  // Start a line's audio when the line changes (and only then: toggling Auto must not
  // restart the voice). Marks the line finished when its voice / reading time is over.
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
        onError: finishAfterReading, // missing/blocked audio must not stall auto mode
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
    if (!autoPlay || !lineFinished || !scenario || !currentTurn) return;
    if (currentTurn.index >= scenario.turns.length - 1) {
      setAutoPlay(false);
      return;
    }
    let waitMs: number;
    if (autoJustEnabledRef.current) {
      waitMs = 150; // Auto pressed after the line already finished: continue right away
    } else if (sharesVoiceWithNext(currentTurn) && AudioMixer.isVoicePlaying()) {
      waitMs = 0; // next line is the continuation of the same recording
    } else {
      // Let the script's own timeline (motions, SE, camera) play out before moving on
      const scriptRemainingMs = currentTurn.durationSec * 1000 - (performance.now() - lineStartRef.current);
      waitMs = Math.max(settings.autoPlayDelaySec * 1000, scriptRemainingMs);
    }
    autoJustEnabledRef.current = false;
    const timer = window.setTimeout(() => {
      navKindRef.current = "advance";
      setCurrentTurnIndex((i) => Math.min(i + 1, scenario.turns.length - 1));
    }, waitMs);
    return () => window.clearTimeout(timer);
  }, [autoPlay, lineFinished, currentTurn, scenario, settings.autoPlayDelaySec, sharesVoiceWithNext]);

  // Keep a shared multi-line recording running past the split point only in auto mode
  useEffect(() => {
    AudioMixer.setAutoContinue(autoPlay && sharesVoiceWithNext(currentTurn));
  }, [autoPlay, currentTurn, sharesVoiceWithNext]);

  const toggleAutoPlay = () => {
    const next = !autoPlay;
    autoJustEnabledRef.current = next && lineFinished;
    setAutoPlay(next);
  };

  // Typewriter text reveal animation
  useEffect(() => {
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
    }, 24);
    return () => window.clearInterval(interval);
  }, [currentTurn, settings.textSpeed]);

  // Auto-scroll active line in the bottom script
  useEffect(() => {
    if (activeRowRef.current) {
      activeRowRef.current.scrollIntoView({
        behavior: "smooth",
        block: "nearest",
      });
    }
  }, [currentTurnIndex]);

  // Keyboard navigation (Right/Space = Next, Left = Prev)
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
        handleNext();
      } else if (e.key === "ArrowLeft") {
        e.preventDefault();
        handlePrev();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [handleNext, handlePrev]);

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
    const m = Math.floor(sec / 60);
    const s = Math.floor(sec % 60);
    return `${m}:${String(s).padStart(2, "0")}`;
  };

  if (!scenario || !currentTurn) {
    return (
      <div className="min-h-screen bg-[#0b0e14] text-slate-100 flex items-center justify-center">
        <div className="flex items-center gap-3 text-sm text-slate-300">
          <span className="h-3 w-3 rounded-full bg-amber-400 animate-ping" />
          Loading Link! Like! Love Live! Bilingual 3D Scenario Player…
        </div>
      </div>
    );
  }

  const activeTranslation =
    currentTurn.translations[settings.primaryTranslationId] ||
    Object.values(currentTurn.translations)[0] || {
      speaker: currentTurn.speakerEn,
      text: "(Translation unavailable for this line)",
    };

  const activeTlSource = scenario.translationSources.find(
    (s) => s.id === settings.primaryTranslationId
  );

  return (
    <div className="min-h-screen bg-[#0b0e14] text-slate-100 flex flex-col">
      {/* Top App Bar (inspired by pjsk.cleista.cc) */}
      <header className="sticky top-0 z-40 h-14 border-b border-slate-800/80 bg-[#0f131c]/95 backdrop-blur-md px-3 lg:px-5 flex items-center justify-between gap-3">
        <div className="flex items-center gap-3 min-w-0">
          <button
            type="button"
            onClick={() => setSidebarOpen((v) => !v)}
            className="inline-flex items-center gap-2 rounded-lg border border-slate-700/80 bg-slate-800/70 px-2.5 py-1.5 text-xs font-medium text-slate-200 hover:bg-slate-700/70 transition"
          >
            <ListVideo className="w-4 h-4 text-amber-400" />
            <span className="hidden sm:inline">Episodes</span>
          </button>

          <div className="flex items-center gap-2 min-w-0">
            <span className="inline-flex items-center rounded-md bg-amber-500/15 border border-amber-500/30 px-2 py-0.5 text-[11px] font-semibold text-amber-300 shrink-0">
              {scenario.episode.term}
            </span>
            <h1 className="text-sm font-semibold text-white truncate">
              {scenario.episode.seriesTitleEn}{" "}
              <span className="text-slate-400 font-normal">
                ({scenario.episode.seriesTitleJp})
              </span>
            </h1>
            <span className="hidden md:inline text-xs text-amber-300/90 font-medium shrink-0">
              · {scenario.episode.partTitleEn}
            </span>
          </div>
        </div>

        {/* Center/Right Controls: Translation Source, Search, Speaker Filter, Volume Mixer */}
        <div className="flex items-center gap-2">
          {/* Translation Source Selector */}
          <div className="hidden md:flex items-center gap-1.5 rounded-lg border border-slate-700/80 bg-slate-900/90 px-2.5 py-1 text-xs">
            <BookOpen className="w-3.5 h-3.5 text-amber-400 shrink-0" />
            <span className="text-slate-400">TL:</span>
            <select
              aria-label="Translation Source"
              value={settings.primaryTranslationId}
              onChange={(e) =>
                setSettings((s) => ({ ...s, primaryTranslationId: e.target.value }))
              }
              className="bg-transparent text-slate-100 font-medium focus:outline-none cursor-pointer"
            >
              {scenario.translationSources.map((src) => (
                <option key={src.id} value={src.id} className="bg-slate-900 text-slate-100">
                  {src.label}
                </option>
              ))}
            </select>
          </div>

          {/* Search Input */}
          <div className="relative hidden lg:block">
            <Search className="w-3.5 h-3.5 text-slate-400 absolute left-2.5 top-1/2 -translate-y-1/2" />
            <input
              type="text"
              placeholder="Search JP / Translation…"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="w-44 rounded-lg border border-slate-700/80 bg-slate-900/90 pl-8 pr-2.5 py-1 text-xs text-slate-100 placeholder:text-slate-500 focus:border-amber-500/60 focus:outline-none"
            />
          </div>

          {/* Speaker Filter */}
          <select
            aria-label="Speaker Filter"
            value={speakerFilter}
            onChange={(e) => setSpeakerFilter(e.target.value)}
            className="hidden sm:block rounded-lg border border-slate-700/80 bg-slate-900/90 px-2.5 py-1 text-xs text-slate-200 focus:outline-none"
          >
            <option value="ALL">All Speakers</option>
            {uniqueSpeakers.map((sp) => (
              <option key={sp} value={sp}>
                {sp}
              </option>
            ))}
          </select>

          {/* Credits */}
          <button
            type="button"
            onClick={() => setCreditsOpen(true)}
            className="inline-flex items-center gap-1.5 rounded-lg border border-slate-700/80 bg-slate-800/80 px-2.5 py-1.5 text-xs font-medium text-slate-200 hover:bg-slate-700/80 transition"
            title="Translation & data credits"
          >
            <Info className="w-4 h-4 text-amber-400" />
            <span className="hidden sm:inline">Credits</span>
          </button>

          {/* Audio Mixer Popover Button */}
          <div className="relative">
            <button
              type="button"
              onClick={() => {
                setVolumeOpen((v) => !v);
                setSettingsOpen(false);
              }}
              className="inline-flex items-center gap-1.5 rounded-lg border border-slate-700/80 bg-slate-800/80 px-2.5 py-1.5 text-xs font-medium text-slate-200 hover:bg-slate-700/80 transition"
              title="Audio Mixer (Master / BGM / SE / Voice)"
            >
              {muted ? (
                <VolumeX className="w-4 h-4 text-rose-400" />
              ) : (
                <Volume2 className="w-4 h-4 text-amber-400" />
              )}
              <span className="hidden sm:inline">Volume</span>
            </button>

            {volumeOpen && (
              <div className="absolute right-0 mt-2 w-72 rounded-xl border border-slate-700/90 bg-slate-900/95 p-4 shadow-2xl backdrop-blur-xl z-50">
                <div className="flex items-center justify-between mb-3">
                  <span className="text-xs font-semibold uppercase tracking-wider text-slate-300">
                    Multi-Channel Audio Mixer
                  </span>
                  <button
                    type="button"
                    onClick={() => setMuted((m) => !m)}
                    className={`rounded-md px-2 py-0.5 text-xs font-medium ${
                      muted
                        ? "bg-rose-500/20 text-rose-300 border border-rose-500/40"
                        : "bg-slate-800 text-slate-300 hover:bg-slate-700"
                    }`}
                  >
                    {muted ? "Unmute" : "Mute All"}
                  </button>
                </div>

                <div className="space-y-3 text-xs">
                  <div>
                    <div className="flex justify-between text-slate-300 mb-1">
                      <span>Master</span>
                      <span>{Math.round(masterVol * 100)}%</span>
                    </div>
                    <input
                      type="range"
                      min={0}
                      max={1}
                      step={0.01}
                      value={masterVol}
                      onChange={(e) => setMasterVol(parseFloat(e.target.value))}
                      className="w-full accent-amber-400"
                    />
                  </div>
                  <div>
                    <div className="flex justify-between text-slate-300 mb-1">
                      <span>Voice (.webm)</span>
                      <span>{Math.round(voiceVol * 100)}%</span>
                    </div>
                    <input
                      type="range"
                      min={0}
                      max={1}
                      step={0.01}
                      value={voiceVol}
                      onChange={(e) => setVoiceVol(parseFloat(e.target.value))}
                      className="w-full accent-amber-400"
                    />
                  </div>
                  <div>
                    <div className="flex justify-between text-slate-300 mb-1">
                      <span>BGM (.mp3)</span>
                      <span>{Math.round(bgmVol * 100)}%</span>
                    </div>
                    <input
                      type="range"
                      min={0}
                      max={1}
                      step={0.01}
                      value={bgmVol}
                      onChange={(e) => setBgmVol(parseFloat(e.target.value))}
                      className="w-full accent-amber-400"
                    />
                  </div>
                  <div>
                    <div className="flex justify-between text-slate-300 mb-1">
                      <span>Sound Effects / Ambience</span>
                      <span>{Math.round(seVol * 100)}%</span>
                    </div>
                    <input
                      type="range"
                      min={0}
                      max={1}
                      step={0.01}
                      value={seVol}
                      onChange={(e) => setSeVol(parseFloat(e.target.value))}
                      className="w-full accent-amber-400"
                    />
                  </div>
                </div>

                {currentTurn.stateBefore.audio.bgmTitle && (
                  <div className="mt-3 pt-2.5 border-t border-slate-800 flex items-center gap-2 text-[11px] text-amber-300">
                    <Music className="w-3.5 h-3.5 shrink-0" />
                    <span className="truncate">
                      Playing BGM: {currentTurn.stateBefore.audio.bgmTitle}
                    </span>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      </header>

      {/* Collapsible Episode Selection Drawer */}
      {sidebarOpen && (
        <div className="border-b border-slate-800 bg-slate-900/95 px-4 py-3">
          <div className="max-w-6xl mx-auto">
            <div className="flex items-center justify-between mb-2">
              <span className="text-xs font-semibold uppercase tracking-wider text-amber-400">
                Cached Local Story Episodes (Zero-GCS Mode)
              </span>
              <a
                href="https://introtohasu.carrd.co/#watchorder"
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1 text-xs text-sky-400 hover:underline"
              >
                IntroToHasu Watch Order Guide <ExternalLink className="w-3 h-3" />
              </a>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              {catalog.map((ep) => {
                const isSelected = ep.scriptId === activeScriptId;
                return (
                  <button
                    key={ep.scriptId}
                    type="button"
                    onClick={() => {
                      setActiveScriptId(ep.scriptId);
                      setSidebarOpen(false);
                    }}
                    className={`text-left rounded-xl border p-3 transition ${
                      isSelected
                        ? "border-amber-500/80 bg-amber-500/10"
                        : "border-slate-800 bg-slate-950/60 hover:border-slate-700"
                    }`}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-xs font-semibold text-amber-300">
                        {ep.term} · {ep.month} · Script {ep.scriptId}
                      </span>
                      <span className="text-[11px] text-slate-400">
                        {ep.totalTurns} lines · {formatMmSs(ep.totalDurationSec)}
                      </span>
                    </div>
                    <div className="mt-1 font-semibold text-sm text-white">
                      {ep.seriesTitleEn} — {ep.partTitleEn}
                    </div>
                    <div className="text-xs text-slate-400 mt-0.5 line-clamp-2">
                      {ep.descriptionEn}
                    </div>
                  </button>
                );
              })}
            </div>
          </div>
        </div>
      )}

      {/* Main Reader Body */}
      <main className="flex-1 max-w-6xl w-full mx-auto px-2 sm:px-4 py-3 flex flex-col gap-3">
        {/* 1. Interactive 16:9 3D Stage Canvas + Overlaid Bilingual Subtitles */}
        <div
          ref={stageContainerRef}
          className="relative w-full aspect-video max-h-[64vh] mx-auto rounded-2xl overflow-hidden border border-slate-800/90 bg-slate-950 shadow-2xl"
        >
          {/* Three.js 3D WebGL Stage */}
          <StageCanvas
            turn={currentTurn}
            cameraMode={settings.cameraMode}
            enable3D={settings.enable3DStage}
            audioMixer={AudioMixer}
            onAdvance={handleNext}
          />

          {/* Top Stage Overlay Bar (Scene Location, BGM, Active 3D Characters, Camera & Reader Controls) */}
          <div className="absolute top-0 inset-x-0 z-20 flex flex-wrap items-center justify-between gap-2 bg-gradient-to-b from-slate-950/85 via-slate-950/40 to-transparent px-4 py-2.5 pointer-events-none">
            <div className="flex items-center gap-2 flex-wrap pointer-events-auto">
              {currentTurn.stateBefore.background.comment && (
                <span className="inline-flex items-center gap-1 rounded-full bg-slate-900/80 border border-slate-700/70 px-2.5 py-0.5 text-xs text-slate-200 backdrop-blur-md">
                  <Sparkles className="w-3 h-3 text-amber-400" />
                  {currentTurn.stateBefore.background.comment}
                </span>
              )}
              {currentTurn.stateBefore.audio.bgmTitle && (
                <span className="hidden sm:inline-flex items-center gap-1 rounded-full bg-slate-900/80 border border-slate-700/70 px-2.5 py-0.5 text-xs text-amber-200/90 backdrop-blur-md">
                  <Music className="w-3 h-3 text-amber-400" />
                  {currentTurn.stateBefore.audio.bgmTitle}
                </span>
              )}
            </div>

            <div className="flex items-center gap-1.5 pointer-events-auto">
              <button
                type="button"
                onClick={() =>
                  setSettings((s) => ({
                    ...s,
                    cameraMode: s.cameraMode === "adv" ? "orbit" : "adv",
                  }))
                }
                className={`inline-flex items-center gap-1 rounded-lg px-2.5 py-1 text-xs font-medium backdrop-blur-md border transition ${
                  settings.cameraMode === "orbit"
                    ? "bg-amber-500/25 border-amber-400/70 text-amber-200"
                    : "bg-slate-900/75 border-slate-700/70 text-slate-200 hover:bg-slate-800/80"
                }`}
                title="Switch between Scripted ADV Camera and Free 3D Orbit Camera"
              >
                <Camera className="w-3.5 h-3.5" />
                <span>{settings.cameraMode === "adv" ? "ADV Cam" : "Free 3D Orbit"}</span>
              </button>

              <button
                type="button"
                onClick={() => {
                  setSettingsOpen((v) => !v);
                  setVolumeOpen(false);
                }}
                className="inline-flex items-center gap-1 rounded-lg bg-slate-900/75 border border-slate-700/70 px-2.5 py-1 text-xs font-medium text-slate-200 hover:bg-slate-800/80 backdrop-blur-md transition"
              >
                <Settings className="w-3.5 h-3.5" />
                <span className="hidden sm:inline">Reader settings</span>
              </button>

              <button
                type="button"
                onClick={toggleFullscreen}
                className="inline-flex items-center rounded-lg bg-slate-900/75 border border-slate-700/70 p-1.5 text-slate-200 hover:bg-slate-800/80 backdrop-blur-md transition"
                title="Toggle Fullscreen"
              >
                {isFullscreen ? (
                  <Minimize2 className="w-3.5 h-3.5" />
                ) : (
                  <Maximize2 className="w-3.5 h-3.5" />
                )}
              </button>
            </div>
          </div>

          {/* Reader Settings Modal Overlay */}
          {settingsOpen && (
            <div
              onClick={(e) => e.stopPropagation()}
              className="absolute top-12 right-4 z-30 w-80 rounded-xl border border-slate-700 bg-slate-900/95 p-4 text-xs shadow-2xl backdrop-blur-xl space-y-3"
            >
              <div className="flex items-center justify-between">
                <span className="font-semibold uppercase tracking-wider text-slate-200">
                  Reading & 3D Stage Settings
                </span>
                <button
                  type="button"
                  onClick={() => setSettingsOpen(false)}
                  className="text-slate-400 hover:text-white"
                >
                  ✕
                </button>
              </div>

              <div>
                <label className="block text-slate-400 mb-1">Primary Translation Source</label>
                <select
                  value={settings.primaryTranslationId}
                  onChange={(e) =>
                    setSettings((s) => ({ ...s, primaryTranslationId: e.target.value }))
                  }
                  className="w-full rounded-lg border border-slate-700 bg-slate-950 px-2.5 py-1.5 text-slate-100"
                >
                  {scenario.translationSources.map((src) => (
                    <option key={src.id} value={src.id}>
                      {src.label}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label className="block text-slate-400 mb-1">Canvas Subtitle Layout</label>
                <div className="grid grid-cols-3 gap-1.5">
                  {(["side-by-side", "stacked", "primary-only"] as const).map((layout) => (
                    <button
                      key={layout}
                      type="button"
                      onClick={() => setSettings((s) => ({ ...s, subtitleLayout: layout }))}
                      className={`rounded-md py-1 px-2 font-medium capitalize border ${
                        settings.subtitleLayout === layout
                          ? "bg-amber-500/20 border-amber-400 text-amber-200"
                          : "bg-slate-800/70 border-slate-700 text-slate-300"
                      }`}
                    >
                      {layout.replace(/-/g, " ")}
                    </button>
                  ))}
                </div>
              </div>

              <div>
                <div className="flex justify-between text-slate-400 mb-1">
                  <span>Text Speed</span>
                  <span>{settings.textSpeed === 5 ? "Instant" : `${settings.textSpeed}x`}</span>
                </div>
                <input
                  type="range"
                  min={1}
                  max={5}
                  step={1}
                  value={settings.textSpeed}
                  onChange={(e) =>
                    setSettings((s) => ({ ...s, textSpeed: parseInt(e.target.value, 10) }))
                  }
                  className="w-full accent-amber-400"
                />
              </div>

              <div className="flex items-center justify-between pt-1">
                <span className="text-slate-300">Render 3D Characters & Props</span>
                <input
                  type="checkbox"
                  checked={settings.enable3DStage}
                  onChange={(e) =>
                    setSettings((s) => ({ ...s, enable3DStage: e.target.checked }))
                  }
                  className="accent-amber-400 h-4 w-4"
                />
              </div>

              <div>
                <div className="flex justify-between text-slate-400 mb-1">
                  <span>Auto: pause between lines</span>
                  <span>{settings.autoPlayDelaySec.toFixed(1)}s</span>
                </div>
                <input
                  type="range"
                  min={0.2}
                  max={3}
                  step={0.1}
                  value={settings.autoPlayDelaySec}
                  onChange={(e) =>
                    setSettings((s) => ({ ...s, autoPlayDelaySec: parseFloat(e.target.value) }))
                  }
                  className="w-full accent-amber-400"
                />
              </div>
            </div>
          )}

          {/* Side-by-Side Bilingual Subtitle Overlay at Bottom of Stage (pjsk.cleista.cc style) */}
          <div
            onClick={() => handleNext()}
            className="absolute inset-x-0 bottom-0 z-20 bg-gradient-to-t from-slate-950/95 via-slate-950/80 to-transparent pt-8 pb-3.5 px-4 sm:px-6 cursor-pointer"
          >
            <div
              className={`max-w-5xl mx-auto grid gap-4 ${
                settings.subtitleLayout === "side-by-side"
                  ? "grid-cols-1 md:grid-cols-2"
                  : "grid-cols-1"
              }`}
            >
              {/* Primary Language (User/Community Translation) */}
              <div className="rounded-xl bg-slate-900/80 border border-slate-700/70 px-4 py-2.5 backdrop-blur-md shadow-lg">
                <div className="flex items-center justify-between gap-2 mb-1">
                  <div className="flex items-center gap-2">
                    {currentTurn.iconUrl && (
                      <img
                        src={currentTurn.iconUrl}
                        alt={currentTurn.speakerEn}
                        className="w-6 h-6 rounded-full object-cover border border-white/20"
                      />
                    )}
                    <span
                      className="text-xs font-bold tracking-wide px-2 py-0.5 rounded-full"
                      style={{
                        backgroundColor: `${currentTurn.characterColor}28`,
                        color: currentTurn.characterLightColor,
                        border: `1px solid ${currentTurn.characterColor}80`,
                      }}
                    >
                      {activeTranslation.speaker || currentTurn.speakerEn || "Narration"}
                    </span>
                  </div>
                  <span className="text-[10px] uppercase tracking-wider text-slate-400">
                    {activeTlSource?.label || "Translation"}
                  </span>
                </div>
                <p className="text-sm sm:text-[15px] font-medium text-white leading-snug whitespace-pre-wrap">
                  {activeTranslation.text.slice(0, revealedChars)}
                </p>
              </div>

              {/* Official Japanese Subtitle + Interactive Dictionary Lookup */}
              {settings.subtitleLayout !== "primary-only" && (
                <div className="rounded-xl bg-slate-900/80 border border-slate-700/70 px-4 py-2.5 backdrop-blur-md shadow-lg font-jp">
                  <div className="flex items-center justify-between gap-2 mb-1">
                    <span
                      className="text-xs font-bold tracking-wide px-2 py-0.5 rounded-full"
                      style={{
                        backgroundColor: `${currentTurn.characterColor}28`,
                        color: currentTurn.characterLightColor,
                        border: `1px solid ${currentTurn.characterColor}80`,
                      }}
                    >
                      {currentTurn.speakerJp || "ナレーション"}
                    </span>
                    <span className="text-[10px] text-slate-400">日本語 · hover a word to look it up</span>
                  </div>
                  <JapaneseLookupText
                    tokens={currentTurn.tokensJp}
                    text={currentTurn.textJp}
                    lexicon={scenario.lexicon ?? {}}
                    tags={scenario.lexTags ?? {}}
                    className="text-sm sm:text-[15px] font-medium text-slate-100"
                  />
                </div>
              )}
            </div>
          </div>
        </div>

        {/* 2. Middle Transport & Timeline Scrub Bar */}
        <div className="rounded-xl border border-slate-800/90 bg-[#121722] px-3 sm:px-4 py-2.5 flex flex-wrap items-center justify-between gap-3 shadow-md">
          <div className="flex items-center gap-1.5">
            <button
              type="button"
              onClick={handlePrev}
              disabled={currentTurnIndex === 0}
              className="inline-flex items-center gap-1 rounded-lg border border-slate-700/80 bg-slate-800/80 px-2.5 py-1.5 text-xs font-medium text-slate-200 hover:bg-slate-700 disabled:opacity-40 transition"
            >
              <ChevronLeft className="w-4 h-4" /> Prev
            </button>
            <button
              type="button"
              onClick={handleNext}
              disabled={currentTurnIndex >= scenario.turns.length - 1}
              className="inline-flex items-center gap-1 rounded-lg border border-slate-700/80 bg-slate-800/80 px-2.5 py-1.5 text-xs font-medium text-slate-200 hover:bg-slate-700 disabled:opacity-40 transition"
            >
              Next <ChevronRight className="w-4 h-4" />
            </button>
            <button
              type="button"
              onClick={toggleAutoPlay}
              aria-pressed={autoPlay}
              className={`inline-flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs font-semibold transition ${
                autoPlay
                  ? "border-amber-400 bg-amber-500/20 text-amber-200"
                  : "border-slate-700/80 bg-slate-800/80 text-slate-200 hover:bg-slate-700"
              }`}
            >
              {autoPlay ? <Pause className="w-3.5 h-3.5" /> : <Play className="w-3.5 h-3.5" />}
              Auto
            </button>
            {currentTurn.voiceUrl && (
              <button
                type="button"
                onClick={() => AudioMixer.replayVoice()}
                className="inline-flex items-center gap-1 rounded-lg border border-slate-700/80 bg-slate-800/80 px-2.5 py-1.5 text-xs font-medium text-amber-300 hover:bg-slate-700 transition"
                title="Replay current character voice line"
              >
                <RotateCcw className="w-3.5 h-3.5" /> Voice
              </button>
            )}
          </div>

          {/* Progress Scrubber */}
          <div className="flex-1 min-w-[180px] max-w-xl flex items-center gap-3">
            <input
              type="range"
              aria-label="Story Line Scrubber"
              min={0}
              max={scenario.turns.length - 1}
              value={currentTurnIndex}
              onChange={(e) => goToTurn(parseInt(e.target.value, 10))}
              className="flex-1 accent-amber-400 cursor-pointer"
            />
            <span className="text-xs font-mono text-slate-300 shrink-0">
              {currentTurn.lineNumber} / {scenario.totalTurns} ·{" "}
              {formatMmSs(currentTurn.timestampSec)} / {formatMmSs(scenario.totalDurationSec)}
            </span>
          </div>

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setTwoColTranscript((v) => !v)}
              className="inline-flex items-center gap-1.5 rounded-lg border border-slate-700/80 bg-slate-800/80 px-2.5 py-1.5 text-xs font-medium text-slate-300 hover:bg-slate-700 transition"
              title="Toggle 1 / 2 column script layout"
            >
              <Columns className="w-3.5 h-3.5 text-amber-400" />
              <span className="hidden sm:inline">
                {twoColTranscript ? "2-Col Script" : "1-Col Script"}
              </span>
            </button>
          </div>
        </div>

        {/* 3. Lower Interactive Dual-Column Bilingual Script / Transcript */}
        <section
          aria-label="Interactive Bilingual Script"
          className="rounded-2xl border border-slate-800/90 bg-[#0f131c] overflow-hidden shadow-xl flex flex-col"
        >
          <div className="border-b border-slate-800/90 bg-slate-900/70 px-4 py-2.5 flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <h2 className="text-xs font-semibold uppercase tracking-wider text-slate-300">
                Interactive Bilingual Script ({filteredTurns.length} lines)
              </h2>
              {activeTlSource && (
                <span className="text-xs text-slate-400">
                  · Translation:{" "}
                  {activeTlSource.url ? (
                    <a
                      href={activeTlSource.url}
                      target="_blank"
                      rel="noreferrer"
                      className="text-amber-300 hover:underline inline-flex items-center gap-1"
                    >
                      {activeTlSource.attribution} <ExternalLink className="w-3 h-3" />
                    </a>
                  ) : (
                    <span className="text-slate-300">{activeTlSource.attribution}</span>
                  )}
                </span>
              )}
              <button
                type="button"
                onClick={() => setCreditsOpen(true)}
                className="text-xs text-slate-400 underline decoration-dotted underline-offset-2 hover:text-slate-200"
              >
                All credits
              </button>
            </div>
            <span className="text-[11px] text-slate-400">
              Click any line to seek the 3D stage & audio state
            </span>
          </div>

          <div
            role="listbox"
            aria-label="Script"
            className="max-h-[42vh] overflow-y-auto divide-y divide-slate-800/60"
          >
            {filteredTurns.map((t) => {
              const isActive = t.index === currentTurn.index;
              const tl = t.translations[settings.primaryTranslationId] ||
                Object.values(t.translations)[0] || {
                  speaker: t.speakerEn,
                  text: "",
                };
              const prevTurn = t.index > 0 ? scenario.turns[t.index - 1] : null;
              const sceneChanged =
                !prevTurn ||
                prevTurn.stateBefore.background.bgId !== t.stateBefore.background.bgId ||
                prevTurn.stateBefore.background.comment !== t.stateBefore.background.comment;

              return (
                <React.Fragment key={t.index}>
                  {sceneChanged && t.stateBefore.background.comment && (
                    <div className="bg-slate-900/90 px-4 py-1.5 text-xs font-medium text-amber-300/90 flex items-center justify-between">
                      <span>✦ Scene: {t.stateBefore.background.comment}</span>
                      {t.stateBefore.audio.bgmTitle && (
                        <span className="text-[11px] text-slate-400">
                          ♪ {t.stateBefore.audio.bgmTitle}
                        </span>
                      )}
                    </div>
                  )}
                  <div
                    ref={isActive ? activeRowRef : null}
                    role="option"
                    aria-selected={isActive}
                    onClick={() => goToTurn(t.index)}
                    className={`px-4 py-3 cursor-pointer transition flex items-start gap-3 ${
                      isActive
                        ? "bg-amber-500/15 border-l-4 border-l-amber-400"
                        : "hover:bg-slate-800/40"
                    }`}
                  >
                    {/* Line Number & Character Portrait */}
                    <div className="flex items-center gap-2.5 shrink-0 pt-0.5">
                      <span className="w-7 text-right font-mono text-xs text-slate-500">
                        #{t.lineNumber}
                      </span>
                      {t.iconUrl ? (
                        <img
                          src={t.iconUrl}
                          alt={t.speakerEn}
                          className="w-9 h-9 rounded-full object-cover border border-slate-700 bg-slate-800"
                        />
                      ) : (
                        <div className="w-9 h-9 rounded-full bg-slate-800 border border-slate-700 flex items-center justify-center text-xs font-bold text-slate-400">
                          {t.speakerEn?.slice(0, 2) || "—"}
                        </div>
                      )}
                    </div>

                    {/* Dual-Column or Single-Column Dialogue Content */}
                    <div
                      className={`flex-1 min-w-0 grid gap-3 ${
                        twoColTranscript ? "grid-cols-1 md:grid-cols-2" : "grid-cols-1"
                      }`}
                    >
                      {/* Translated Column */}
                      <div>
                        <div className="flex items-center gap-2 mb-1 flex-wrap">
                          <span
                            className="text-xs font-bold"
                            style={{ color: t.characterLightColor }}
                          >
                            {tl.speaker || t.speakerEn || "Narration"}
                          </span>
                        </div>
                        <p className="text-sm text-slate-100 whitespace-pre-wrap leading-relaxed">
                          {tl.text}
                        </p>
                      </div>

                      {/* Official Japanese Column */}
                      <div className="font-jp border-t md:border-t-0 md:border-l border-slate-800/80 pt-2 md:pt-0 md:pl-3">
                        <div className="flex items-center justify-between gap-2 mb-1">
                          <span
                            className="text-xs font-bold"
                            style={{ color: t.characterLightColor }}
                          >
                            {t.speakerJp || "ナレーション"}
                          </span>
                          <span className="text-[11px] font-mono text-slate-500">
                            {formatMmSs(t.timestampSec)}
                          </span>
                        </div>
                        <JapaneseLookupText
                          tokens={t.tokensJp}
                          text={t.textJp}
                          lexicon={scenario.lexicon ?? {}}
                          tags={scenario.lexTags ?? {}}
                          hoverDelayMs={250}
                          clickToPin={false}
                          className="text-sm text-slate-200"
                        />
                      </div>
                    </div>
                  </div>
                </React.Fragment>
              );
            })}
          </div>
        </section>
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
