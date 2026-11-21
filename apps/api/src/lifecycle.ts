import { isDeepStrictEqual } from "node:util";
import { type CoordinateRevision, validateContract } from "@sports-motion/contracts";
import { canonicalJson, jsonDigest } from "./canonical-json.js";
import { MemoryStateStore, type StateStore } from "./state-store.js";

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type CoordinateEdit = CoordinateRevision["edits"][number];

function id(prefix: string, identity: Json): string {
  return `${prefix}-${jsonDigest(identity)}`;
}

function trialId(teamId: string, captureId: string) {
  return id("trial", [teamId, captureId]);
}

function bytes(value: Uint8Array) {
  return Buffer.from(value).toString("base64");
}

function positiveInteger(value: number) {
  return Number.isSafeInteger(value) && value > 0;
}

function monotonic(tick: number, previous: number) {
  if (!Number.isSafeInteger(tick) || tick < previous) {
    throw new RangeError("Clock must advance monotonically in integer ticks");
  }
}

export interface Capture {
  teamId: string;
  captureId: string;
  video: Uint8Array;
  contractVersion: string;
}

export interface CaptureAck {
  teamId: string;
  captureId: string;
  trialId: string;
}

export interface JobSettings {
  calibrationId: string;
  pipelineVersion: string;
  modelHash: string;
  filterSpec: Json;
}

interface JobInputs extends JobSettings {
  trialId: string;
  coordinateRevisionId: string | null;
}

export interface LifecycleLimits {
  uploadDeadlineTicks: number;
  queueDeadlineTicks: number;
  execDeadlineTicks: number;
  maxAttempts: number;
  retryDelayTicks?: number;
}

function validateLimits(limits: LifecycleLimits) {
  if (
    ![
      limits.uploadDeadlineTicks,
      limits.queueDeadlineTicks,
      limits.execDeadlineTicks,
      limits.maxAttempts,
    ].every(positiveInteger) ||
    (limits.retryDelayTicks !== undefined && !positiveInteger(limits.retryDelayTicks))
  ) {
    throw new RangeError("Lifecycle limits must be positive integer ticks or counts");
  }
  return { ...limits, retryDelayTicks: limits.retryDelayTicks ?? 1 };
}

type Failure = "transient" | "permanent" | "expired" | "superseded";
type FailureState = "FailedRetryable" | "FailedTerminal";

export class LifecycleConflict extends Error {
  constructor(
    readonly reason: "capture_id" | "revision_id" | "head" | "session" | "history" | "analysis",
    readonly currentHead?: string | null,
  ) {
    super(`Lifecycle conflict: ${reason}`);
  }
}

type UploadStatus = "LocalCaptured" | "QueuedOffline" | "Uploading" | "Uploaded" | FailureState;
interface Upload {
  teamId: string;
  captureId: string;
  videoBase64: string;
  contractVersion: string;
  requestVersion: string;
  status: UploadStatus;
  attemptNo: number;
  deadline: number;
  retryAt: number;
  ack?: CaptureAck;
  queued: boolean;
}

export interface CaptureQueueState {
  tick: number;
  captures: Upload[];
}

export function emptyCaptureQueue(): CaptureQueueState {
  return { tick: 0, captures: [] };
}

export class CaptureQueue {
  private readonly limits;

  constructor(
    limits: LifecycleLimits,
    private readonly store: StateStore<CaptureQueueState> = new MemoryStateStore(
      emptyCaptureQueue(),
    ),
  ) {
    this.limits = validateLimits(limits);
  }

  snapshot() {
    return this.store.read();
  }

  record(capture: Capture) {
    if (
      !capture.teamId ||
      !capture.captureId ||
      !capture.video.length ||
      !capture.contractVersion
    ) {
      throw new TypeError("Capture identity, video and contract version are required");
    }
    return this.store.update(({ captures }) => {
      const existing = captures.find(
        (item) => item.teamId === capture.teamId && item.captureId === capture.captureId,
      );
      const videoBase64 = bytes(capture.video);
      if (existing) {
        if (existing.videoBase64 !== videoBase64) {
          throw new LifecycleConflict("capture_id");
        }
        return;
      }
      captures.push({
        teamId: capture.teamId,
        captureId: capture.captureId,
        videoBase64,
        contractVersion: capture.contractVersion,
        requestVersion: capture.contractVersion,
        status: "LocalCaptured",
        attemptNo: 0,
        deadline: 0,
        retryAt: 0,
        queued: false,
      });
    });
  }

  recover() {
    this.store.update(({ captures, tick }) => {
      for (const item of captures) {
        if (item.ack) {
          continue;
        }
        item.queued = true;
        if (item.status === "LocalCaptured") {
          item.status = "QueuedOffline";
        } else if (item.status === "Uploading") {
          this.markFailed(item, tick);
        }
      }
    });
  }

  enqueue(teamId: string, captureId: string) {
    return this.store.update(({ captures }) => {
      const item = captures.find(
        (capture) => capture.teamId === teamId && capture.captureId === captureId,
      );
      if (item?.status !== "LocalCaptured") {
        return false;
      }
      item.status = "QueuedOffline";
      item.queued = true;
      return true;
    });
  }

  migrate(contractVersion: string) {
    if (!contractVersion) {
      throw new TypeError("Contract version is required");
    }
    this.store.update(({ captures }) => {
      for (const item of captures) {
        if (!item.ack) {
          item.requestVersion = contractVersion;
        }
      }
    });
  }

  start(
    teamId: string,
    captureId: string,
    connected: boolean,
    supportedVersions: readonly string[],
  ) {
    return this.store.update(({ captures, tick }) => {
      const item = captures.find(
        (capture) => capture.teamId === teamId && capture.captureId === captureId,
      );
      if (
        !item?.queued ||
        item.ack ||
        item.attemptNo >= this.limits.maxAttempts ||
        (item.status !== "QueuedOffline" && item.status !== "FailedRetryable") ||
        tick < item.retryAt
      ) {
        return;
      }
      if (!connected || !supportedVersions.includes(item.requestVersion)) {
        item.status = "QueuedOffline";
        return;
      }
      item.status = "Uploading";
      item.deadline = tick + this.limits.uploadDeadlineTicks;
      item.attemptNo++;
      return {
        capture: {
          teamId,
          captureId,
          contractVersion: item.requestVersion,
          video: Buffer.from(item.videoBase64, "base64"),
        },
        attemptNo: item.attemptNo,
      };
    });
  }

  acknowledge(teamId: string, captureId: string, ack: CaptureAck) {
    return this.store.update(({ captures }) => {
      const item = captures.find(
        (capture) => capture.teamId === teamId && capture.captureId === captureId,
      );
      if (
        !item ||
        item.attemptNo === 0 ||
        ack.teamId !== teamId ||
        ack.captureId !== captureId ||
        ack.trialId !== trialId(teamId, captureId)
      ) {
        return false;
      }
      item.ack = { teamId, captureId, trialId: ack.trialId };
      item.status = "Uploaded";
      return true;
    });
  }

  remove(teamId: string, captureId: string) {
    return this.store.update(({ captures }) => {
      const item = captures.find(
        (capture) => capture.teamId === teamId && capture.captureId === captureId,
      );
      if (!item?.ack) {
        return false;
      }
      item.queued = false;
      return true;
    });
  }

  fail(teamId: string, captureId: string, attemptNo: number, permanent = false) {
    this.store.update(({ captures, tick }) => {
      const item = captures.find(
        (capture) => capture.teamId === teamId && capture.captureId === captureId,
      );
      if (item?.status === "Uploading" && item.attemptNo === attemptNo) {
        this.markFailed(item, tick, permanent);
      }
    });
  }

  advanceTo(tick: number) {
    this.store.update((state) => {
      monotonic(tick, state.tick);
      state.tick = tick;
      for (const item of state.captures) {
        if (item.status === "Uploading" && tick >= item.deadline) {
          this.markFailed(item, item.deadline);
        }
      }
    });
  }

  private markFailed(item: Upload, tick: number, permanent = false) {
    item.status =
      permanent || item.attemptNo >= this.limits.maxAttempts ? "FailedTerminal" : "FailedRetryable";
    item.retryAt = tick + this.limits.retryDelayTicks;
  }
}

type JobStatus = "AnalysisQueued" | "Analyzing" | "Recalculating" | "Analyzed" | FailureState;
interface Attempt {
  attemptNo: number;
  status: JobStatus;
  queuedAt: number;
  deadline: number;
  failure?: Failure;
}

interface AnalysisJob {
  id: string;
  inputs: JobInputs;
  kind: "analysis" | "recalc";
  status: JobStatus;
  retryAt?: number;
  attempts: [Attempt, ...Attempt[]];
}

interface CommittedRevision {
  operation: CoordinateRevision;
  version: number;
  effectiveEdits: CoordinateEdit[];
  jobId: string;
}

interface Trial {
  ack: CaptureAck;
  videoBase64: string;
  rawBase64?: string;
  revisions: CommittedRevision[];
  editHistory: (string | null)[];
  editCursor: number;
  sessions: { editorId: string; expectedHead: string | null; status: "EditingCoords" }[];
  currentJobId: string;
  publishedId?: string;
}

export interface AnalysisRevision {
  id: string;
  jobId: string;
  inputs: JobInputs;
  result: Json;
}

export interface LifecycleState {
  tick: number;
  trials: Trial[];
  jobs: AnalysisJob[];
  analyses: AnalysisRevision[];
}

export function emptyLifecycle(): LifecycleState {
  return { tick: 0, trials: [], jobs: [], analyses: [] };
}

function head(trial: Trial) {
  return trial.revisions.at(-1)?.operation.revision_id ?? null;
}

function activeAttempt(job: AnalysisJob) {
  return job.attempts.at(-1) ?? job.attempts[0];
}

function findTrial(state: LifecycleState, id: string) {
  const trial = state.trials.find((trial) => trial.ack.trialId === id);
  if (!trial) {
    throw new RangeError("Unknown trial");
  }
  return trial;
}

function findJob(state: LifecycleState, id: string) {
  const job = state.jobs.find((job) => job.id === id);
  if (!job) {
    throw new RangeError("Unknown job");
  }
  return job;
}

function editKey(edit: CoordinateEdit) {
  return JSON.stringify([edit.view_id, edit.frame_index, edit.landmark.landmark_id]);
}

export class LifecycleEngine {
  private readonly limits;
  private readonly initialSettings;

  constructor(
    limits: LifecycleLimits,
    initialSettings: JobSettings,
    private readonly store: StateStore<LifecycleState> = new MemoryStateStore(emptyLifecycle()),
  ) {
    this.limits = validateLimits(limits);
    this.initialSettings = structuredClone(initialSettings);
  }

  snapshot() {
    return this.store.read();
  }

  submitCapture(capture: Capture): CaptureAck {
    if (
      !capture.teamId ||
      !capture.captureId ||
      !capture.video.length ||
      !capture.contractVersion
    ) {
      throw new TypeError("Capture identity, video and contract version are required");
    }
    const videoBase64 = bytes(capture.video);
    return this.store.update((state) => {
      const id = trialId(capture.teamId, capture.captureId);
      const existing = state.trials.find((trial) => trial.ack.trialId === id);
      if (existing) {
        if (existing.videoBase64 !== videoBase64) {
          throw new LifecycleConflict("capture_id");
        }
        return existing.ack;
      }
      const ack = { teamId: capture.teamId, captureId: capture.captureId, trialId: id };
      const trial: Trial = {
        ack,
        videoBase64,
        revisions: [],
        editHistory: [null],
        editCursor: 0,
        sessions: [],
        currentJobId: "",
      };
      this.enqueue(state, trial, this.initialSettings, "analysis");
      state.trials.push(trial);
      return ack;
    });
  }

  beginEdit(trialId: string, editorId: string) {
    return this.store.update((state) => {
      const trial = findTrial(state, trialId);
      if (trial.rawBase64 === undefined) {
        throw new LifecycleConflict("analysis", head(trial));
      }
      const existing = trial.sessions.find((session) => session.editorId === editorId);
      if (existing) {
        return existing;
      }
      const session = { editorId, expectedHead: head(trial), status: "EditingCoords" } as const;
      trial.sessions.push(session);
      return session;
    });
  }

  discardEdit(trialId: string, editorId: string) {
    this.store.update((state) => {
      const trial = findTrial(state, trialId);
      trial.sessions = trial.sessions.filter((session) => session.editorId !== editorId);
    });
  }

  commitRevision(trialId: string, editorId: string, operation: unknown) {
    if (!validateContract("coordinate_revision", operation)) {
      throw new TypeError("Invalid coordinate revision");
    }
    return this.store.update((state) => {
      const trial = findTrial(state, trialId);
      const current = head(trial);
      const existing = trial.revisions.find(
        (record) => record.operation.revision_id === operation.revision_id,
      );
      if (existing) {
        const { contract_version: _previousVersion, ...previous } = existing.operation;
        const { contract_version: _requestVersion, ...request } = operation;
        if (!isDeepStrictEqual(previous, request)) {
          throw new LifecycleConflict("revision_id", current);
        }
        return existing;
      }
      if (operation.expected_head !== current || operation.parent_revision_id !== current) {
        throw new LifecycleConflict("head", current);
      }
      if (
        !trial.sessions.some(
          (session) => session.editorId === editorId && session.expectedHead === current,
        )
      ) {
        throw new LifecycleConflict("session", current);
      }
      const cursor = trial.editCursor;
      const nextCursor = cursor + (operation.operation === "undo" ? -1 : 1);
      if (
        operation.operation !== "edit" &&
        (nextCursor < 0 || nextCursor >= trial.editHistory.length)
      ) {
        throw new LifecycleConflict("history", current);
      }
      const effectiveId = trial.editHistory[operation.operation === "edit" ? cursor : nextCursor];
      const base = trial.revisions.find((record) => record.operation.revision_id === effectiveId);
      const edits = new Map((base?.effectiveEdits ?? []).map((edit) => [editKey(edit), edit]));
      for (const edit of operation.edits) {
        edits.set(editKey(edit), edit);
      }
      if (operation.operation === "edit") {
        trial.editHistory = [...trial.editHistory.slice(0, nextCursor), operation.revision_id];
      }
      trial.editCursor = nextCursor;
      const settings = findJob(state, trial.currentJobId).inputs;
      const record = {
        operation: structuredClone(operation),
        version: trial.revisions.length + 1,
        effectiveEdits: [...edits.values()],
        jobId: "",
      };
      trial.revisions.push(record);
      record.jobId = this.enqueue(state, trial, settings, "recalc").id;
      trial.sessions = trial.sessions.filter((session) => session.editorId !== editorId);
      return record;
    });
  }

  requestAnalysis(trialId: string, settings: JobSettings) {
    return this.store.update((state) => {
      const trial = findTrial(state, trialId);
      return this.enqueue(state, trial, settings, head(trial) === null ? "analysis" : "recalc");
    });
  }

  claim(jobId: string) {
    return this.store.update((state) => {
      const job = findJob(state, jobId);
      const attempt = activeAttempt(job);
      if (job.status !== "AnalysisQueued" || !this.isCurrent(state, job)) {
        return;
      }
      const trial = findTrial(state, job.inputs.trialId);
      const source =
        job.kind === "analysis"
          ? ({ kind: "video", videoBase64: trial.videoBase64 } as const)
          : this.recalcSource(trial, job.inputs.coordinateRevisionId);
      job.status = attempt.status = job.kind === "analysis" ? "Analyzing" : "Recalculating";
      attempt.deadline = state.tick + this.limits.execDeadlineTicks;
      return { jobId, attemptNo: attempt.attemptNo, inputs: job.inputs, source };
    });
  }

  retry(jobId: string) {
    return this.store.update((state) => {
      const job = findJob(state, jobId);
      const last = activeAttempt(job);
      if (
        job.status !== "FailedRetryable" ||
        job.retryAt === undefined ||
        !this.isCurrent(state, job) ||
        state.tick < job.retryAt
      ) {
        return false;
      }
      last.status = "FailedTerminal";
      job.attempts.push(this.queuedAttempt(state.tick, last.attemptNo + 1));
      job.status = "AnalysisQueued";
      delete job.retryAt;
      return true;
    });
  }

  fail(jobId: string, attemptNo: number, permanent = false) {
    this.store.update((state) => {
      const job = findJob(state, jobId);
      const attempt = activeAttempt(job);
      if (
        attempt.attemptNo === attemptNo &&
        (attempt.status === "Analyzing" || attempt.status === "Recalculating")
      ) {
        this.markFailed(job, permanent ? "permanent" : "transient", state.tick);
      }
    });
  }

  complete(jobId: string, attemptNo: number, result: Json, rawObservations?: Uint8Array) {
    return this.store.update((state) => {
      const job = findJob(state, jobId);
      const attempt = activeAttempt(job);
      if (attempt.attemptNo === attemptNo && attempt.status === "Analyzed") {
        return state.analyses.find((revision) => revision.jobId === jobId);
      }
      if (
        attempt.attemptNo !== attemptNo ||
        (attempt.status !== "Analyzing" && attempt.status !== "Recalculating")
      ) {
        const expired = job.attempts.find(
          (candidate) => candidate.attemptNo === attemptNo && candidate.failure === "expired",
        );
        if (expired) {
          expired.status = "FailedTerminal";
        }
        return;
      }
      const trial = findTrial(state, job.inputs.trialId);
      if (trial.currentJobId !== jobId || job.inputs.coordinateRevisionId !== head(trial)) {
        this.markFailed(job, "superseded", state.tick);
        return;
      }
      if (trial.rawBase64 === undefined) {
        if (!rawObservations?.length) {
          throw new TypeError("Initial analysis must provide raw observations");
        }
        trial.rawBase64 = bytes(rawObservations);
      }
      const revision = {
        id: id("analysis", jobId),
        jobId,
        inputs: job.inputs,
        result: JSON.parse(canonicalJson(result)) as Json,
      };
      state.analyses.push(revision);
      trial.publishedId = revision.id;
      job.status = attempt.status = "Analyzed";
      return revision;
    });
  }

  currentAnalysis(trialId: string) {
    const state = this.store.read();
    const trial = findTrial(state, trialId);
    return state.analyses.find(
      (revision) =>
        revision.id === trial.publishedId &&
        revision.jobId === trial.currentJobId &&
        revision.inputs.coordinateRevisionId === head(trial),
    );
  }

  historicalAnalysis(revisionId: string) {
    return this.store.read().analyses.find((revision) => revision.id === revisionId);
  }

  advanceTo(tick: number) {
    this.store.update((state) => {
      monotonic(tick, state.tick);
      state.tick = tick;
      for (const job of state.jobs) {
        const attempt = activeAttempt(job);
        if (
          (attempt.status === "AnalysisQueued" ||
            attempt.status === "Analyzing" ||
            attempt.status === "Recalculating") &&
          tick >= attempt.deadline
        ) {
          this.markFailed(job, "expired", attempt.deadline);
        }
      }
    });
  }

  private enqueue(
    state: LifecycleState,
    trial: Trial,
    settings: JobSettings,
    kind: AnalysisJob["kind"],
  ) {
    const { calibrationId, pipelineVersion, modelHash, filterSpec } = settings;
    const inputs = {
      trialId: trial.ack.trialId,
      coordinateRevisionId: head(trial),
      calibrationId,
      pipelineVersion,
      modelHash,
      filterSpec,
    };
    const jobId = id("job", inputs);
    const existing = state.jobs.find((job) => job.id === jobId);
    if (existing) {
      return existing;
    }
    if (trial.currentJobId) {
      const previous = findJob(state, trial.currentJobId);
      if (previous.status !== "Analyzed" && previous.status !== "FailedTerminal") {
        this.markFailed(previous, "superseded", state.tick);
      }
    }
    const job: AnalysisJob = {
      id: jobId,
      inputs,
      kind,
      status: "AnalysisQueued",
      attempts: [this.queuedAttempt(state.tick, 1)],
    };
    state.jobs.push(job);
    trial.currentJobId = jobId;
    delete trial.publishedId;
    return job;
  }

  private isCurrent(state: LifecycleState, job: AnalysisJob) {
    const trial = findTrial(state, job.inputs.trialId);
    return trial.currentJobId === job.id && job.inputs.coordinateRevisionId === head(trial);
  }

  private recalcSource(trial: Trial, coordinateRevisionId: string | null) {
    const revision = trial.revisions.find(
      (record) => record.operation.revision_id === coordinateRevisionId,
    );
    if (!revision || trial.rawBase64 === undefined) {
      throw new Error("Recalculation input is missing");
    }
    return { kind: "raw", rawBase64: trial.rawBase64, edits: revision.effectiveEdits } as const;
  }

  private queuedAttempt(tick: number, attemptNo: number): Attempt {
    return {
      attemptNo,
      queuedAt: tick,
      deadline: tick + this.limits.queueDeadlineTicks,
      status: "AnalysisQueued",
    };
  }

  private markFailed(job: AnalysisJob, failure: Failure, tick: number) {
    const attempt = activeAttempt(job);
    job.status = attempt.status =
      failure === "superseded" ||
      failure === "permanent" ||
      attempt.attemptNo >= this.limits.maxAttempts
        ? "FailedTerminal"
        : "FailedRetryable";
    attempt.failure = failure;
    attempt.deadline = tick;
    if (job.status === "FailedRetryable") {
      job.retryAt = tick + this.limits.retryDelayTicks;
    } else {
      delete job.retryAt;
    }
  }
}
