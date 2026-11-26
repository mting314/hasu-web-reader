/**
 * Playback clock for the viewer: the live's audio when it can play, otherwise (missing file,
 * unsupported codec, autoplay blocked) a silent wall-clock timer, so Play always works.
 */
export class PlaybackClock {
  private base = 0;
  private startedAt: number | null = null;
  private rateValue = 1;
  /** Set when the audio failed to load or play; the clock then runs silently. */
  silentReason: string | null = null;

  constructor(private audio: HTMLAudioElement) {
    audio.addEventListener("error", () => {
      this.silentReason = audio.error?.message || "audio failed to load";
    });
  }

  private get audible(): boolean {
    return this.silentReason === null && !this.audio.error;
  }

  get time(): number {
    if (this.audible && this.startedAt === null) return this.audio.currentTime;
    if (this.startedAt === null) return this.base;
    return this.base + ((performance.now() - this.startedAt) / 1000) * this.rateValue;
  }

  set time(t: number) {
    this.base = t;
    if (this.startedAt !== null) this.startedAt = performance.now();
    if (this.audible) {
      try {
        this.audio.currentTime = t;
      } catch {
        // not seekable yet
      }
    }
  }

  get paused(): boolean {
    return this.startedAt === null;
  }

  get rate(): number {
    return this.rateValue;
  }

  set rate(r: number) {
    this.base = this.time;
    if (this.startedAt !== null) this.startedAt = performance.now();
    this.rateValue = r;
    this.audio.playbackRate = r;
    this.audio.preservesPitch = true;
  }

  play() {
    if (this.startedAt !== null) return;
    this.base = this.time;
    this.startedAt = performance.now();
    if (this.audible) {
      this.audio.currentTime = this.base;
      this.audio.play().catch((e: unknown) => {
        this.silentReason = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
      });
    }
  }

  pause() {
    if (this.startedAt === null) return;
    this.base = this.time;
    this.startedAt = null;
    this.audio.pause();
  }

  /** Keep the wall clock aligned with the audio while it plays (the audio is the authority). */
  sync() {
    if (this.startedAt !== null && this.audible && !this.audio.paused && this.audio.readyState >= 2) {
      const drift = this.audio.currentTime - this.time;
      if (Math.abs(drift) > 0.05) {
        this.base = this.audio.currentTime;
        this.startedAt = performance.now();
      }
    }
  }
}
