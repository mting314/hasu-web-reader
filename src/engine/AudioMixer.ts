import type { AmbienceBed } from "../types/scenario";

export type Vowel = "A" | "I" | "U" | "E" | "O";

export interface VoicePlayOptions {
  startSec?: number;
  endSec?: number | null;
  /** Keep playing past endSec (auto mode: the next line continues the same recording). */
  autoContinue?: boolean;
  /** The line's voice (or its sub-clip) finished. */
  onEnded?: () => void;
  /** Playback could not start (missing file, autoplay policy). */
  onError?: () => void;
}

export interface LipSyncFrame {
  /** 0..1 mouth opening derived from the voice loudness */
  level: number;
  /** rough vowel estimate from the voice spectrum, for picking the mouth shape */
  vowel: Vowel;
}

interface Fade {
  from: number;
  to: number;
  start: number;
  dur: number;
  onDone?: () => void;
}

/** One HTMLAudioElement playing a sound effect: a looping ambience bed or a one-shot. */
interface SeTrack {
  el: HTMLAudioElement;
  id: string;
  kind: "bed" | "oneshot";
  scriptVol: number;
  /** fade multiplier 0..1 */
  gain: number;
  fade: Fade | null;
}

const FADE_TICK_MS = 30; // setInterval, not rAF: fades must keep running in background tabs
const SEGMENT_TICK_MS = 25;

const clamp01 = (v: number) => Math.max(0, Math.min(1, v));

export class AudioMixer {
  public masterVolume = 0.85;
  public bgmVolume = 0.45;
  public seVolume = 0.65;
  public voiceVolume = 1.0;
  public muted = false;

  // --- voice ---
  private voiceAudio: HTMLAudioElement;
  private ctx: AudioContext | null = null;
  private voiceGain: GainNode | null = null;
  private analyser: AnalyserNode | null = null;
  private timeData: Float32Array | null = null;
  private freqData: Uint8Array | null = null;
  private currentVoiceUrl: string | null = null;
  private currentStartSec = 0;
  private currentEndSec: number | null = null;
  private currentAutoContinue = false;
  /** bumped on every play/stop so callbacks from a previous line never fire late */
  private voiceToken = 0;
  private onVoiceEnded: (() => void) | null = null;
  private segmentTimer: number | null = null;
  private vowel: Vowel = "A";
  private vowelCandidate: Vowel = "A";
  private vowelCandidateSince = 0;

  // --- music & sound effects ---
  private bgmAudio: HTMLAudioElement;
  private currentBgmUrl: string | null = null;
  private scriptBgmVol = 1.0;
  /** every live SE element, including ones that are fading out */
  private tracks = new Set<SeTrack>();
  /** active ambience beds by id */
  private ambience = new Map<string, SeTrack>();
  private fadeTimer: number | null = null;

  private readonly unlock = () => {
    this.ensureContext();
    for (const t of this.ambience.values()) {
      if (t.el.paused) t.el.play().catch(() => {});
    }
  };

  constructor() {
    this.voiceAudio = new Audio();
    this.voiceAudio.crossOrigin = "anonymous";
    this.voiceAudio.preload = "auto";
    this.bgmAudio = new Audio();
    this.bgmAudio.crossOrigin = "anonymous";
    this.bgmAudio.loop = true;

    this.voiceAudio.addEventListener("ended", () => {
      this.clearSegmentMonitor();
      this.fireVoiceEnded();
    });

    // Browsers only start audio after a user gesture; resume everything on the first one.
    window.addEventListener("pointerdown", this.unlock, { capture: true });
    window.addEventListener("keydown", this.unlock, { capture: true });
  }

  // -------------------------------------------------------------------------
  // Volume
  // -------------------------------------------------------------------------

  private get effMaster() {
    return this.muted ? 0 : this.masterVolume;
  }

  public applyVolumes() {
    const master = this.effMaster;
    if (this.voiceGain) {
      // Routed through Web Audio: keep the element at full level so lip-sync analysis
      // sees the real signal regardless of the user's voice volume.
      this.voiceAudio.volume = 1;
      this.voiceGain.gain.value = master * this.voiceVolume;
    } else {
      this.voiceAudio.volume = clamp01(master * this.voiceVolume);
    }
    this.bgmAudio.volume = clamp01(master * this.bgmVolume * this.scriptBgmVol);
    for (const t of this.tracks) this.applySeVolume(t);
  }

  private applySeVolume(t: SeTrack) {
    t.el.volume = clamp01(this.effMaster * this.seVolume * t.scriptVol * t.gain);
  }

  private ensureContext() {
    if (!this.ctx) {
      const Ctx =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!Ctx) return;
      try {
        const ctx = new Ctx();
        const source = ctx.createMediaElementSource(this.voiceAudio);
        const analyser = ctx.createAnalyser();
        analyser.fftSize = 1024;
        analyser.smoothingTimeConstant = 0.45;
        const gain = ctx.createGain();
        source.connect(analyser);
        analyser.connect(gain);
        gain.connect(ctx.destination);
        this.ctx = ctx;
        this.analyser = analyser;
        this.voiceGain = gain;
        this.timeData = new Float32Array(analyser.fftSize);
        this.freqData = new Uint8Array(analyser.frequencyBinCount);
        this.applyVolumes();
      } catch {
        this.ctx = null;
        this.analyser = null;
        this.voiceGain = null;
      }
    }
    if (this.ctx && this.ctx.state === "suspended") {
      this.ctx.resume().catch(() => {});
    }
  }

  // -------------------------------------------------------------------------
  // Voice
  // -------------------------------------------------------------------------

  public playVoice(url: string | null, opts: VoicePlayOptions = {}) {
    const token = ++this.voiceToken;
    const startSec = opts.startSec ?? 0;
    const endSec = opts.endSec ?? null;
    this.currentStartSec = startSec;
    this.currentEndSec = endSec;
    this.currentAutoContinue = Boolean(opts.autoContinue);
    this.onVoiceEnded = opts.onEnded ?? null;

    if (!url) {
      this.clearSegmentMonitor();
      this.voiceAudio.pause();
      this.currentVoiceUrl = null;
      return;
    }

    this.ensureContext();
    this.applyVolumes();

    // Seamlessly continuing into the next sub-clip of the same multi-line recording
    const sameUrl = this.currentVoiceUrl === url;
    if (
      sameUrl &&
      !this.voiceAudio.paused &&
      startSec > 0 &&
      Math.abs(this.voiceAudio.currentTime - startSec) < 0.45
    ) {
      this.startSegmentMonitor(token);
      return;
    }

    this.clearSegmentMonitor();
    if (!sameUrl) {
      this.currentVoiceUrl = url;
      this.voiceAudio.src = url;
    }

    const fail = () => {
      if (token === this.voiceToken) opts.onError?.();
    };
    const seekAndPlay = () => {
      if (token !== this.voiceToken) return;
      try {
        this.voiceAudio.currentTime = startSec;
      } catch {
        // not seekable yet; plays from 0
      }
      this.voiceAudio
        .play()
        .then(() => {
          if (token === this.voiceToken) this.startSegmentMonitor(token);
        })
        .catch((err: unknown) => {
          // AbortError = superseded by a newer play/pause (user moved on); not a failure
          if ((err as { name?: string })?.name !== "AbortError") fail();
        });
    };

    if (this.voiceAudio.readyState >= 1) {
      seekAndPlay();
    } else {
      const cleanup = () => {
        this.voiceAudio.removeEventListener("loadedmetadata", onMeta);
        this.voiceAudio.removeEventListener("error", onErr);
      };
      const onMeta = () => {
        cleanup();
        seekAndPlay();
      };
      const onErr = () => {
        cleanup();
        fail();
      };
      this.voiceAudio.addEventListener("loadedmetadata", onMeta);
      this.voiceAudio.addEventListener("error", onErr);
      this.voiceAudio.load();
    }
  }

  /** Update whether the voice should run on past the current sub-clip (auto mode toggled). */
  public setAutoContinue(autoContinue: boolean) {
    this.currentAutoContinue = autoContinue;
    if (
      !autoContinue &&
      this.currentEndSec !== null &&
      !this.voiceAudio.paused &&
      this.voiceAudio.currentTime > this.currentEndSec
    ) {
      this.voiceAudio.pause();
    }
  }

  public replayVoice() {
    if (!this.currentVoiceUrl) return;
    this.playVoice(this.currentVoiceUrl, {
      startSec: this.currentStartSec,
      endSec: this.currentEndSec,
      autoContinue: false,
    });
  }

  public stopVoice() {
    this.voiceToken++;
    this.clearSegmentMonitor();
    this.onVoiceEnded = null;
    this.voiceAudio.pause();
  }

  public isVoicePlaying(): boolean {
    return !this.voiceAudio.paused && !this.voiceAudio.ended && this.voiceAudio.currentTime > 0;
  }

  private fireVoiceEnded() {
    const cb = this.onVoiceEnded;
    this.onVoiceEnded = null;
    cb?.();
  }

  private clearSegmentMonitor() {
    if (this.segmentTimer !== null) {
      window.clearInterval(this.segmentTimer);
      this.segmentTimer = null;
    }
  }

  private startSegmentMonitor(token: number) {
    this.clearSegmentMonitor();
    if (this.currentEndSec === null) return; // the element's "ended" event covers full clips
    this.segmentTimer = window.setInterval(() => {
      if (token !== this.voiceToken) {
        this.clearSegmentMonitor();
        return;
      }
      if (this.voiceAudio.paused || this.currentEndSec === null) return;
      if (this.voiceAudio.currentTime >= this.currentEndSec - 0.03) {
        this.clearSegmentMonitor();
        // Manual reading: stop at the boundary so the next line's part doesn't bleed in
        if (!this.currentAutoContinue) this.voiceAudio.pause();
        this.fireVoiceEnded();
      }
    }, SEGMENT_TICK_MS);
  }

  /** Loudness + vowel estimate of the voice for 3D lip-sync (call once per frame). */
  public getLipSync(): LipSyncFrame {
    if (!this.isVoicePlaying()) return { level: 0, vowel: this.vowel };
    const analyser = this.analyser;
    const timeData = this.timeData;
    const freqData = this.freqData;
    if (!analyser || !timeData || !freqData || !this.ctx || this.ctx.state !== "running") {
      // No analysis available: a gentle procedural flap rather than a frozen mouth
      const t = performance.now() / 1000;
      return { level: 0.25 + 0.25 * Math.abs(Math.sin(t * 9.5) * Math.sin(t * 3.7)), vowel: "A" };
    }

    analyser.getFloatTimeDomainData(timeData);
    let sum = 0;
    for (let i = 0; i < timeData.length; i++) sum += timeData[i] * timeData[i];
    const rms = Math.sqrt(sum / timeData.length);
    const db = 20 * Math.log10(rms + 1e-8);
    const level = clamp01((db + 48) / 30); // ~-48 dBFS closed .. ~-18 dBFS fully open

    if (level > 0.08) {
      analyser.getByteFrequencyData(freqData);
      const binHz = this.ctx.sampleRate / analyser.fftSize;
      const band = (lo: number, hi: number) => {
        const a = Math.max(1, Math.floor(lo / binHz));
        const b = Math.min(freqData.length - 1, Math.ceil(hi / binHz));
        let s = 0;
        for (let i = a; i <= b; i++) s += freqData[i];
        return s / Math.max(1, b - a + 1);
      };
      // Very rough formant buckets: open vowels (あ) have a high F1, front vowels (い/え)
      // a high F2, rounded vowels (う/お) most energy low.
      const low = band(250, 750);
      const mid = band(750, 1500);
      const high = band(1500, 3500);
      let v: Vowel;
      if (mid >= low * 0.9 && mid >= high) v = "A";
      else if (high > mid * 1.05) v = high > low * 0.95 ? "I" : "E";
      else v = low > mid * 1.35 ? "U" : "O";

      const now = performance.now();
      if (v !== this.vowelCandidate) {
        this.vowelCandidate = v;
        this.vowelCandidateSince = now;
      } else if (v !== this.vowel && now - this.vowelCandidateSince > 70) {
        this.vowel = v; // hold briefly so the mouth doesn't flicker between shapes
      }
    }
    return { level, vowel: this.vowel };
  }

  // -------------------------------------------------------------------------
  // BGM
  // -------------------------------------------------------------------------

  private bgmUserPaused = false;
  private hiddenPausedState: {
    voice: boolean;
    bgm: boolean;
    seIds: string[];
    oneShotTracks: SeTrack[];
    pausedAt: number;
  } | null = null;

  public syncBgm(url: string | null, scriptVolume = 1.0) {
    this.scriptBgmVol = scriptVolume;
    this.applyVolumes();
    if (!url) {
      this.bgmAudio.pause();
      this.currentBgmUrl = null;
      this.bgmUserPaused = false;
      return;
    }
    if (this.currentBgmUrl === url) {
      if (this.bgmAudio.paused && !this.bgmUserPaused) {
        this.bgmAudio.play().catch(() => {});
      }
      return;
    }
    this.currentBgmUrl = url;
    this.bgmUserPaused = false;
    this.bgmAudio.src = url;
    this.bgmAudio.currentTime = 0;
    this.applyVolumes();
    this.bgmAudio.play().catch(() => {});
  }

  public isBgmPlaying(): boolean {
    return Boolean(this.currentBgmUrl && !this.bgmAudio.paused);
  }

  public toggleBgmPlayPause(): boolean {
    if (!this.currentBgmUrl) return false;
    if (this.bgmAudio.paused) {
      this.bgmUserPaused = false;
      this.bgmAudio.play().catch(() => {});
      return true;
    } else {
      this.bgmUserPaused = true;
      this.bgmAudio.pause();
      return false;
    }
  }

  public getBgmTime(): { currentTime: number; duration: number } {
    const dur = Number.isFinite(this.bgmAudio.duration) ? this.bgmAudio.duration : 0;
    const cur = Number.isFinite(this.bgmAudio.currentTime) ? this.bgmAudio.currentTime : 0;
    return { currentTime: cur, duration: dur };
  }

  public seekBgm(timeSec: number) {
    if (!this.currentBgmUrl || !Number.isFinite(this.bgmAudio.duration)) return;
    try {
      this.bgmAudio.currentTime = Math.max(0, Math.min(this.bgmAudio.duration, timeSec));
    } catch {
      // ignore if metadata not loaded
    }
  }

  public pauseForHiddenTab() {
    const voiceWasPlaying = this.isVoicePlaying();
    const bgmWasPlaying = this.isBgmPlaying();
    const activeSeIds: string[] = [];
    const oneShotTracks: SeTrack[] = [];
    if (voiceWasPlaying) this.voiceAudio.pause();
    if (bgmWasPlaying) this.bgmAudio.pause();
    for (const [id, t] of this.ambience.entries()) {
      if (!t.el.paused) {
        t.el.pause();
        activeSeIds.push(id);
      }
    }
    for (const t of this.tracks) {
      if (t.kind === "oneshot" && !t.el.paused && !t.el.ended) {
        t.el.pause();
        oneShotTracks.push(t);
      }
    }
    this.hiddenPausedState = {
      voice: voiceWasPlaying,
      bgm: bgmWasPlaying,
      seIds: activeSeIds,
      oneShotTracks,
      pausedAt: performance.now(),
    };
  }

  public resumeFromHiddenTab() {
    if (!this.hiddenPausedState) return;
    const st = this.hiddenPausedState;
    this.hiddenPausedState = null;
    const pausedMs = Math.max(0, performance.now() - st.pausedAt);
    for (const t of this.tracks) {
      if (t.fade) {
        t.fade.start += pausedMs;
      }
    }
    if (st.voice && this.currentVoiceUrl) {
      this.voiceAudio.play().catch(() => {});
    }
    if (st.bgm && this.currentBgmUrl && !this.bgmUserPaused) {
      this.bgmAudio.play().catch(() => {});
    }
    for (const id of st.seIds) {
      const t = this.ambience.get(id);
      if (t && t.el.paused) t.el.play().catch(() => {});
    }
    for (const t of st.oneShotTracks) {
      if (this.tracks.has(t) && t.el.paused && !t.el.ended) {
        t.el.play().catch(() => {});
      }
    }
  }

  // -------------------------------------------------------------------------
  // Sound effects
  // -------------------------------------------------------------------------

  private createTrack(id: string, url: string, kind: SeTrack["kind"], scriptVol: number, startGain: number): SeTrack {
    const el = new Audio();
    el.crossOrigin = "anonymous";
    el.src = url;
    el.loop = kind === "bed";
    el.preload = "auto";
    const track: SeTrack = { el, id, kind, scriptVol, gain: startGain, fade: null };
    this.tracks.add(track);
    this.applySeVolume(track);
    if (kind === "oneshot") {
      el.addEventListener("ended", () => this.disposeTrack(track));
    }
    el.play().catch(() => {
      // Autoplay blocked: beds are retried on the next user gesture, one-shots are dropped
      if (kind === "oneshot") this.disposeTrack(track);
    });
    return track;
  }

  private disposeTrack(t: SeTrack) {
    t.fade = null;
    t.el.pause();
    t.el.removeAttribute("src");
    t.el.load();
    this.tracks.delete(t);
    if (this.ambience.get(t.id) === t) this.ambience.delete(t.id);
  }

  private fadeTrack(t: SeTrack, to: number, durSec: number, onDone?: () => void) {
    if (durSec <= 0.01) {
      t.fade = null;
      t.gain = to;
      this.applySeVolume(t);
      onDone?.();
      return;
    }
    t.fade = { from: t.gain, to, start: performance.now(), dur: durSec * 1000, onDone };
    if (this.fadeTimer !== null) return;
    this.fadeTimer = window.setInterval(() => {
      const now = performance.now();
      let active = 0;
      for (const track of Array.from(this.tracks)) {
        const f = track.fade;
        if (!f) continue;
        const k = Math.min(1, (now - f.start) / f.dur);
        track.gain = f.from + (f.to - f.from) * k;
        this.applySeVolume(track);
        if (k >= 1) {
          track.fade = null;
          f.onDone?.();
        } else {
          active++;
        }
      }
      if (!active && this.fadeTimer !== null) {
        window.clearInterval(this.fadeTimer);
        this.fadeTimer = null;
      }
    }, FADE_TICK_MS);
  }

  /** Play a non-looping effect. `id` lets a later SE停止 stop it. */
  public playOneShotSe(id: string, url: string, scriptVol = 1.0, fadeSec = 0) {
    const t = this.createTrack(id, url, "oneshot", scriptVol, fadeSec > 0 ? 0 : 1);
    if (fadeSec > 0) this.fadeTrack(t, 1, fadeSec);
  }

  /** Stop every one-shot effect (used when jumping to another line). */
  public stopOneShotSes(fadeSec = 0.12) {
    for (const t of Array.from(this.tracks)) {
      if (t.kind === "oneshot") this.fadeTrack(t, 0, fadeSec, () => this.disposeTrack(t));
    }
  }

  public startAmbience(bed: AmbienceBed, fadeSec = 0) {
    const existing = this.ambience.get(bed.id);
    if (existing) {
      existing.scriptVol = bed.volume;
      this.fadeTrack(existing, 1, fadeSec);
      if (existing.el.paused) existing.el.play().catch(() => {});
      return;
    }
    const t = this.createTrack(bed.id, bed.url, "bed", bed.volume, fadeSec > 0 ? 0 : 1);
    this.ambience.set(bed.id, t);
    if (fadeSec > 0) this.fadeTrack(t, 1, fadeSec);
  }

  /** SE停止: fade out an ambience bed (and any one-shot with the same id). */
  public stopAmbience(id: string, fadeSec = 0) {
    const bed = this.ambience.get(id);
    if (bed) {
      this.ambience.delete(id); // a restart during the fade-out gets a fresh element
      this.fadeTrack(bed, 0, fadeSec, () => this.disposeTrack(bed));
    }
    for (const t of Array.from(this.tracks)) {
      if (t.kind === "oneshot" && t.id === id) this.fadeTrack(t, 0, fadeSec, () => this.disposeTrack(t));
    }
  }

  /** Make the playing ambience beds match a line's snapshot (seek / new line). */
  public syncAmbience(beds: AmbienceBed[], fadeSec = 0.35) {
    const wanted = new Map(beds.map((b) => [b.id, b]));
    for (const id of Array.from(this.ambience.keys())) {
      if (!wanted.has(id)) this.stopAmbience(id, fadeSec);
    }
    for (const bed of beds) {
      const existing = this.ambience.get(bed.id);
      if (!existing) {
        this.startAmbience(bed, fadeSec);
      } else if (existing.scriptVol !== bed.volume) {
        existing.scriptVol = bed.volume;
        this.applySeVolume(existing);
      }
    }
  }

  public stopAll() {
    this.stopVoice();
    this.bgmAudio.pause();
    this.currentBgmUrl = null;
    for (const t of Array.from(this.tracks)) this.disposeTrack(t);
    this.ambience.clear();
  }

  /** Tear down (Vite HMR replaces the module; don't leave orphaned audio playing). */
  public dispose() {
    this.stopAll();
    if (this.fadeTimer !== null) window.clearInterval(this.fadeTimer);
    this.fadeTimer = null;
    window.removeEventListener("pointerdown", this.unlock, { capture: true });
    window.removeEventListener("keydown", this.unlock, { capture: true });
    this.voiceAudio.removeAttribute("src");
    this.voiceAudio.load();
    this.bgmAudio.removeAttribute("src");
    this.bgmAudio.load();
    this.ctx?.close().catch(() => {});
    this.ctx = null;
  }
}
