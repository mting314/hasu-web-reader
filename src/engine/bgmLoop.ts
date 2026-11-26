/**
 * Gapless BGM loop on a Web Audio buffer, the way the game's CRI player loops a BGM cue: play
 * from the start, and on reaching the wave's loop end jump back to its loop start, sample
 * accurately. `<audio loop>` can't do this: it restarts the whole file, with a short pause while
 * it seeks, and plays the encoder's leading silence every time (Cleista's `native-loop.js` uses
 * the same AudioBufferSourceNode approach).
 */
export class BgmLoop {
  private readonly output: GainNode;
  private source: AudioBufferSourceNode | null = null;
  /** position in the buffer (s) when playback last started or paused */
  private offset = 0;
  private startedAt = 0;
  private readonly loopStart: number;
  private readonly loopEnd: number;

  constructor(
    private readonly ctx: AudioContext,
    destination: AudioNode,
    private readonly buffer: AudioBuffer,
    /** [start, end] in seconds; null loops the whole buffer */
    loop: [number, number] | null
  ) {
    const valid = loop && loop[0] >= 0 && loop[1] > loop[0] && loop[1] <= buffer.duration + 0.01;
    this.loopStart = valid ? loop[0] : 0;
    this.loopEnd = valid ? Math.min(loop[1], buffer.duration) : buffer.duration;
    this.output = ctx.createGain();
    this.output.connect(destination);
  }

  get paused(): boolean {
    return !this.source;
  }

  get duration(): number {
    return this.loopEnd;
  }

  /** Wrap a running position into the loop region once it has passed the loop end. */
  private normalize(t: number): number {
    if (t < this.loopEnd) return Math.max(0, t);
    return this.loopStart + ((t - this.loopStart) % (this.loopEnd - this.loopStart));
  }

  get currentTime(): number {
    return this.normalize(this.offset + (this.source ? this.ctx.currentTime - this.startedAt : 0));
  }

  set currentTime(t: number) {
    const running = !this.paused;
    this.pause();
    this.offset = this.normalize(Math.max(0, t));
    if (running) this.play();
  }

  set volume(v: number) {
    this.output.gain.value = v;
  }

  play(): void {
    if (this.source) return;
    const src = this.ctx.createBufferSource();
    src.buffer = this.buffer;
    src.loop = true;
    src.loopStart = this.loopStart;
    src.loopEnd = this.loopEnd;
    src.connect(this.output);
    this.startedAt = this.ctx.currentTime;
    src.start(this.startedAt, this.normalize(this.offset));
    this.source = src;
  }

  pause(): void {
    if (!this.source) return;
    this.offset = this.currentTime;
    this.source.stop();
    this.source.disconnect();
    this.source = null;
  }

  destroy(): void {
    this.pause();
    this.output.disconnect();
  }
}
