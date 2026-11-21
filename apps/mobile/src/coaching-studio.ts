import {
  addAnnotation,
  addComment,
  type CoachingComment,
  type CompareTwoTrialsInput,
  commentsAtFrame,
  compareTwoTrials,
  type DrawingAnnotation,
  type PlaybackRate,
  type PlaybackState,
  removeAnnotation,
  removeComment,
  SynchronizedPlaybackController,
  type TrialPlaybackTimeline,
  type TwoTrialComparison,
  visibleAnnotationsAtFrame,
} from "@sports-motion/coaching";

export interface CoachingStudioSessionOptions extends CompareTwoTrialsInput {
  readonly baselineTimeline: TrialPlaybackTimeline;
  readonly targetTimeline: TrialPlaybackTimeline;
  readonly initialRate?: PlaybackRate;
  readonly initialAnnotations?: readonly DrawingAnnotation[];
  readonly initialComments?: readonly CoachingComment[];
}

export class CoachingStudioSession {
  readonly comparison: TwoTrialComparison;
  private readonly playback: SynchronizedPlaybackController;
  private annotationList: readonly DrawingAnnotation[];
  private commentList: readonly CoachingComment[];

  constructor(options: CoachingStudioSessionOptions) {
    this.comparison = compareTwoTrials(options);
    this.playback = new SynchronizedPlaybackController(
      options.baselineTimeline,
      options.targetTimeline,
      options.initialRate ?? 1.0,
    );
    let annotations: readonly DrawingAnnotation[] = Object.freeze([]);
    for (const annotation of options.initialAnnotations ?? []) {
      annotations = addAnnotation(annotations, annotation);
    }
    this.annotationList = annotations;

    let comments: readonly CoachingComment[] = Object.freeze([]);
    for (const comment of options.initialComments ?? []) {
      comments = addComment(comments, comment);
    }
    this.commentList = comments;
  }

  get playbackState(): PlaybackState {
    return this.playback.state;
  }

  get annotations(): readonly DrawingAnnotation[] {
    return this.annotationList;
  }

  get comments(): readonly CoachingComment[] {
    return this.commentList;
  }

  seekPercent(percent: number): PlaybackState {
    return this.playback.seekPercent(percent);
  }

  stepFrame(delta: 1 | -1): PlaybackState {
    return this.playback.stepFrame(delta);
  }

  setPlaybackRate(rate: PlaybackRate): PlaybackState {
    return this.playback.setRate(rate);
  }

  play(): PlaybackState {
    return this.playback.play();
  }

  pause(): PlaybackState {
    return this.playback.pause();
  }

  advance(elapsedRealSec: number): PlaybackState {
    return this.playback.advance(elapsedRealSec);
  }

  addAnnotation(annotation: DrawingAnnotation): readonly DrawingAnnotation[] {
    this.annotationList = addAnnotation(this.annotationList, annotation);
    return this.annotationList;
  }

  removeAnnotation(id: string): readonly DrawingAnnotation[] {
    this.annotationList = removeAnnotation(this.annotationList, id);
    return this.annotationList;
  }

  visibleAnnotationsAtCurrentFrame(): readonly DrawingAnnotation[] {
    return visibleAnnotationsAtFrame(this.annotationList, this.playback.state.baselineFrame);
  }

  addComment(comment: CoachingComment): readonly CoachingComment[] {
    this.commentList = addComment(this.commentList, comment);
    return this.commentList;
  }

  removeComment(id: string): readonly CoachingComment[] {
    this.commentList = removeComment(this.commentList, id);
    return this.commentList;
  }

  commentsAtCurrentFrame(): readonly CoachingComment[] {
    return commentsAtFrame(this.commentList, this.playback.state.baselineFrame);
  }
}
