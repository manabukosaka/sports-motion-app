import {
  asFrameIndex,
  asNormalizedPercent,
  asSeconds,
  type FrameIndex,
  type NormalizedPercent,
  type Seconds,
} from "@sports-motion/contracts";

export const PLAYBACK_RATES = [0.1, 0.25, 0.5, 1.0] as const;
export type PlaybackRate = (typeof PLAYBACK_RATES)[number];

const PLAYBACK_RATE_SET = new Set<number>(PLAYBACK_RATES);

export interface TrialPlaybackTimeline {
  readonly totalFrames: number;
  readonly fps: number;
  readonly startFrame: FrameIndex;
  readonly endFrame: FrameIndex;
  readonly startTimeSec?: Seconds;
  readonly endTimeSec?: Seconds;
}

export interface NormalizedTimeline {
  readonly totalFrames: number;
  readonly fps: number;
  readonly startFrame: FrameIndex;
  readonly endFrame: FrameIndex;
  readonly startTimeSec: Seconds;
  readonly endTimeSec: Seconds;
  readonly durationSec: Seconds;
  readonly frameSpan: number;
}

export interface PlaybackState {
  readonly percent: NormalizedPercent;
  readonly rate: PlaybackRate;
  readonly playing: boolean;
  readonly baselineFrame: FrameIndex;
  readonly targetFrame: FrameIndex;
  readonly baselinePercent: NormalizedPercent;
  readonly targetPercent: NormalizedPercent;
  readonly syncDeltaFrames: number;
}

export function validatePlaybackRate(rate: number): PlaybackRate {
  if (!PLAYBACK_RATE_SET.has(rate)) {
    throw new RangeError(
      `Unsupported playback rate "${String(rate)}"; expected one of ${PLAYBACK_RATES.join(", ")}`,
    );
  }
  return rate as PlaybackRate;
}

export function validateTrialTimeline(timeline: TrialPlaybackTimeline): NormalizedTimeline {
  if (!Number.isInteger(timeline.totalFrames) || timeline.totalFrames < 2) {
    throw new RangeError("Timeline totalFrames must be an integer >= 2");
  }
  if (!Number.isFinite(timeline.fps) || timeline.fps <= 0) {
    throw new RangeError("Timeline fps must be positive and finite");
  }
  const startFrame = asFrameIndex(timeline.startFrame);
  const endFrame = asFrameIndex(timeline.endFrame);
  if (endFrame <= startFrame) {
    throw new RangeError("Timeline endFrame must be strictly greater than startFrame");
  }
  if (endFrame >= timeline.totalFrames) {
    throw new RangeError("Timeline endFrame must be < totalFrames");
  }
  const startTimeSec = asSeconds(timeline.startTimeSec ?? startFrame / timeline.fps);
  const endTimeSec = asSeconds(timeline.endTimeSec ?? endFrame / timeline.fps);
  if (startTimeSec < 0 || endTimeSec <= startTimeSec) {
    throw new RangeError("Timeline interval must have strictly positive duration (t1 > t0 >= 0)");
  }
  return Object.freeze({
    totalFrames: timeline.totalFrames,
    fps: timeline.fps,
    startFrame,
    endFrame,
    startTimeSec,
    endTimeSec,
    durationSec: asSeconds(endTimeSec - startTimeSec),
    frameSpan: endFrame - startFrame,
  });
}

export function frameToNormalizedPercent(
  frame: FrameIndex,
  timeline: NormalizedTimeline,
): NormalizedPercent {
  const clamped = Math.min(timeline.endFrame, Math.max(timeline.startFrame, frame));
  return asNormalizedPercent(((clamped - timeline.startFrame) / timeline.frameSpan) * 100);
}

export function normalizedPercentToFrame(
  percent: NormalizedPercent,
  timeline: NormalizedTimeline,
): FrameIndex {
  const exact = timeline.startFrame + (percent / 100) * timeline.frameSpan;
  const rounded = Math.round(exact);
  const clamped = Math.min(timeline.endFrame, Math.max(timeline.startFrame, rounded));
  return asFrameIndex(clamped);
}

function buildState(
  baseline: NormalizedTimeline,
  target: NormalizedTimeline,
  percent: NormalizedPercent,
  rate: PlaybackRate,
  playing: boolean,
): PlaybackState {
  const exactBaselineFrame = baseline.startFrame + (percent / 100) * baseline.frameSpan;
  const exactTargetFrame = target.startFrame + (percent / 100) * target.frameSpan;
  const baselineFrame = normalizedPercentToFrame(percent, baseline);
  const targetFrame = normalizedPercentToFrame(percent, target);
  const baselinePercent = frameToNormalizedPercent(baselineFrame, baseline);
  const targetPercent = frameToNormalizedPercent(targetFrame, target);
  const syncDeltaFrames = Math.max(
    Math.abs(baselineFrame - exactBaselineFrame),
    Math.abs(targetFrame - exactTargetFrame),
  );
  return Object.freeze({
    percent,
    rate,
    playing,
    baselineFrame,
    targetFrame,
    baselinePercent,
    targetPercent,
    syncDeltaFrames,
  });
}

export class SynchronizedPlaybackController {
  readonly baseline: NormalizedTimeline;
  readonly target: NormalizedTimeline;
  private current: PlaybackState;

  constructor(
    baseline: TrialPlaybackTimeline,
    target: TrialPlaybackTimeline,
    initialRate: PlaybackRate = 1.0,
  ) {
    this.baseline = validateTrialTimeline(baseline);
    this.target = validateTrialTimeline(target);
    const rate = validatePlaybackRate(initialRate);
    this.current = buildState(this.baseline, this.target, asNormalizedPercent(0), rate, false);
  }

  get state(): PlaybackState {
    return this.current;
  }

  setRate(rate: PlaybackRate): PlaybackState {
    const validated = validatePlaybackRate(rate);
    this.current = buildState(
      this.baseline,
      this.target,
      this.current.percent,
      validated,
      this.current.playing,
    );
    return this.current;
  }

  play(): PlaybackState {
    this.current = buildState(
      this.baseline,
      this.target,
      this.current.percent,
      this.current.rate,
      true,
    );
    return this.current;
  }

  pause(): PlaybackState {
    this.current = buildState(
      this.baseline,
      this.target,
      this.current.percent,
      this.current.rate,
      false,
    );
    return this.current;
  }

  seekPercent(percent: number): PlaybackState {
    const normalized = asNormalizedPercent(percent);
    this.current = buildState(
      this.baseline,
      this.target,
      normalized,
      this.current.rate,
      this.current.playing,
    );
    return this.current;
  }

  stepFrame(delta: 1 | -1): PlaybackState {
    if (delta !== 1 && delta !== -1) {
      throw new RangeError("stepFrame delta must be +1 or -1");
    }
    const nextBaselineFrame = asFrameIndex(
      Math.min(
        this.baseline.endFrame,
        Math.max(this.baseline.startFrame, this.current.baselineFrame + delta),
      ),
    );
    const nextPercent = frameToNormalizedPercent(nextBaselineFrame, this.baseline);
    this.current = buildState(this.baseline, this.target, nextPercent, this.current.rate, false);
    return this.current;
  }

  advance(elapsedRealSec: number): PlaybackState {
    if (!Number.isFinite(elapsedRealSec) || elapsedRealSec < 0) {
      throw new RangeError("elapsedRealSec must be non-negative and finite");
    }
    if (!this.current.playing || elapsedRealSec === 0) {
      return this.current;
    }
    const deltaPercent = ((elapsedRealSec * this.current.rate) / this.baseline.durationSec) * 100;
    const rawNext = this.current.percent + deltaPercent;
    const clamped = asNormalizedPercent(Math.min(100, Math.max(0, rawNext)));
    const stillPlaying = rawNext < 100;
    this.current = buildState(this.baseline, this.target, clamped, this.current.rate, stillPlaying);
    return this.current;
  }
}
