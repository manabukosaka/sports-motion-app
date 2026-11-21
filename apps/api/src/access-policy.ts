import { type KeyObject, randomUUID } from "node:crypto";
import {
  type CoordinateRevision,
  type EvidenceCatalog,
  type KinematicMetrics,
  type Pose3DSequence,
  type ShareReportSnapshot,
  validateContract,
} from "@sports-motion/contracts";
import { replayCoordinateHistory } from "@sports-motion/editing";
import {
  type CoachingCheckpoint,
  compareMetricsAgainstCatalog,
  loadEvidenceCatalog,
} from "@sports-motion/evidence";
import {
  AnalysisConflict,
  type AnalysisInputs,
  type AnalysisReceipt,
  parseAnalysisSubmission,
  parseRevisionCommit,
  type RevisionCommitReceipt,
  validateEditHistory,
} from "./analysis.js";
import { jsonDigest } from "./canonical-json.js";
import { type ShareTokenClaims, signShareToken, verifyShareToken } from "./share-token.js";
import type { StateStore } from "./state-store.js";
import {
  type MotionWorker,
  validateWorkerResult,
  type WorkerAnalysisRequest,
  type WorkerAnalysisResult,
} from "./worker.js";

export type Role = "OrgAdmin" | "Coach" | "Athlete" | "Guardian";
export type Principal = Role | "AnonymousShareViewer" | "Unauthenticated";
export type Operation = "R" | "L" | "W" | "S";
export type Resource =
  | "Team"
  | "AthleteProfile"
  | "TrialVideo"
  | "AnalysisRevision"
  | "EvidenceSnapshot"
  | "ShareLink";

const permissions = {
  OrgAdmin: {
    Team: "RLW",
    AthleteProfile: "RLW",
    TrialVideo: "RLW",
    AnalysisRevision: "RL",
    EvidenceSnapshot: "RL",
    ShareLink: "RLS",
  },
  Coach: {
    Team: "R",
    AthleteProfile: "RL",
    TrialVideo: "RLW",
    AnalysisRevision: "RL",
    EvidenceSnapshot: "RL",
    ShareLink: "RLS",
  },
  Athlete: {
    Team: "R",
    AthleteProfile: "R",
    TrialVideo: "RLW",
    AnalysisRevision: "RL",
    EvidenceSnapshot: "RL",
    ShareLink: "",
  },
  Guardian: {
    Team: "",
    AthleteProfile: "R",
    TrialVideo: "R",
    AnalysisRevision: "R",
    EvidenceSnapshot: "R",
    ShareLink: "",
  },
} satisfies Record<Role, Record<Resource, string>>;

interface Scoped {
  id: string;
  teamId: string;
}

interface Owned extends Scoped {
  athleteId: string;
}

export interface Team extends Scoped {
  orgId: string;
  name: string;
}

export interface AthleteProfile extends Scoped {
  name: string;
  shareConsent: boolean;
}

export interface TrialVideo extends Owned {
  title: string;
}

export interface AnalysisRecord extends Owned {
  trialId: string;
  summary: KinematicMetrics;
  pose3d?: Pose3DSequence;
  calibration?: WorkerAnalysisRequest["calibration"];
  selectedCutoffsHz?: WorkerAnalysisResult["selected_cutoffs_hz"];
}

export interface EvidenceRecord extends Owned {
  analysisRevisionId: string;
  trialId: string;
  contractVersion: string;
  registryVersion: string;
  comparisons: ShareReportSnapshot["evidence_comparisons"];
  checkpoints?: CoachingCheckpoint[];
  nonDiagnostic?: boolean;
  disclaimerTextJa: string;
}

interface Link extends Scoped {
  claims: ShareTokenClaims;
  snapshotJson: string;
  pose3dJson?: string;
  revoked: boolean;
}

export interface Membership {
  userId: string;
  teamId: string;
  role: Role;
  active: boolean;
  athleteId?: string;
}

export interface GuardianLink {
  userId: string;
  teamId: string;
  athleteId: string;
  active: boolean;
}

export interface AccessState {
  memberships: Membership[];
  guardians: GuardianLink[];
  teams: Team[];
  athletes: AthleteProfile[];
  trials: TrialVideo[];
  analyses: AnalysisRecord[];
  evidence: EvidenceRecord[];
  links: Link[];
  motionJobs?: MotionJob[];
}

interface MotionJob {
  teamId: string;
  trialId: string;
  captureId: string;
  jobId: string;
  captureDigest: string;
  requestDigest: string;
  captureInputs?: AnalysisInputs;
  coordinateCommit?: { revision: CoordinateRevision; recomputeMs: number };
}

function checkMotionJob(jobs: Iterable<MotionJob>, job: MotionJob) {
  let existing: MotionJob | undefined;
  for (const saved of jobs) {
    if (saved.teamId !== job.teamId) {
      continue;
    }
    const sameTrial = saved.trialId === job.trialId;
    const sameJob = sameTrial && saved.jobId === job.jobId;
    if (
      (saved.captureId === job.captureId &&
        (!sameTrial || saved.captureDigest !== job.captureDigest)) ||
      (sameTrial && saved.captureId !== job.captureId) ||
      (sameJob && saved.requestDigest !== job.requestDigest)
    ) {
      throw new AnalysisConflict("Capture or analysis job already has different inputs");
    }
    if (sameJob) {
      existing = saved;
    }
  }
  return existing;
}

function motionIds(job: MotionJob) {
  const digest = jsonDigest([job.teamId, job.trialId, job.jobId]);
  return { analysis_revision_id: `analysis-${digest}`, evidence_snapshot_id: `evidence-${digest}` };
}

function evidenceReceiptFields(evidence: EvidenceRecord) {
  return {
    evidence_registry_version: evidence.registryVersion,
    non_diagnostic_flag: true,
    disclaimer_text_ja: evidence.disclaimerTextJa,
    evidence_comparisons: evidence.comparisons,
  } as const;
}

function savedAnalysis(
  state: AccessState,
  job: MotionJob,
  trial: TrialVideo,
): AnalysisReceipt | undefined {
  const ids = motionIds(job);
  const analysis = inTeam(state.analyses, ids.analysis_revision_id, job.teamId);
  const evidence = inTeam(state.evidence, ids.evidence_snapshot_id, job.teamId);
  if (
    !analysis?.pose3d ||
    !analysis.selectedCutoffsHz ||
    analysis.trialId !== trial.id ||
    analysis.athleteId !== trial.athleteId ||
    evidence?.nonDiagnostic !== true ||
    evidence.analysisRevisionId !== analysis.id ||
    evidence.trialId !== trial.id ||
    evidence.athleteId !== trial.athleteId
  ) {
    return;
  }
  return {
    ...ids,
    pose3d: analysis.pose3d,
    kinematic_metrics: analysis.summary,
    selected_cutoffs_hz: analysis.selectedCutoffsHz,
    ...evidenceReceiptFields(evidence),
  };
}

function revisionHistory(state: AccessState, trial: TrialVideo) {
  const jobs = (state.motionJobs ?? []).filter(
    ({ teamId, trialId }) => teamId === trial.teamId && trialId === trial.id,
  );
  const base = jobs.find(({ captureInputs }) => captureInputs);
  if (!base?.captureInputs || !savedAnalysis(state, base, trial)) {
    return;
  }
  const inputs = base.captureInputs;
  const revisions = [...(inputs.revisions ?? [])];
  for (const job of jobs) {
    if (job.coordinateCommit) {
      revisions.push(job.coordinateCommit.revision);
    }
  }
  const { currentHead } = replayCoordinateHistory(
    revisions,
    inputs.calibration.contract_version,
    inputs.raw_revision_id,
  );
  return { base, inputs, jobs, revisions, currentHead: currentHead ?? inputs.raw_revision_id };
}

function revisionReceipt(
  analysis: AnalysisReceipt,
  coordinateRevisionId: string,
  currentHead: string,
  recomputeMs: number,
): RevisionCommitReceipt {
  return {
    analysis_revision_id: analysis.analysis_revision_id,
    evidence_snapshot_id: analysis.evidence_snapshot_id,
    coordinate_revision_id: coordinateRevisionId,
    current_head: currentHead,
    recompute_ms: recomputeMs,
    pose3d: analysis.pose3d,
    kinematic_metrics: analysis.kinematic_metrics,
  };
}

const collections = {
  Team: "teams",
  AthleteProfile: "athletes",
  TrialVideo: "trials",
  AnalysisRevision: "analyses",
  EvidenceSnapshot: "evidence",
  ShareLink: "links",
} as const satisfies Record<Resource, keyof AccessState>;

type ResourceRecord = AccessState[(typeof collections)[Resource]][number];
interface Fields {
  readonly [key: string]: unknown;
  readonly id?: unknown;
  readonly teamId?: unknown;
  readonly name?: unknown;
  readonly title?: unknown;
  readonly athleteId?: unknown;
  readonly expiresAt?: unknown;
  readonly analysisRevisionId?: unknown;
  readonly evidenceSnapshotId?: unknown;
}

function memberFor(
  state: AccessState,
  userId: string | undefined,
  teamId: string,
  resource: Resource,
  operation: Operation,
) {
  return state.memberships.find(
    (member) =>
      userId !== undefined &&
      member.userId === userId &&
      member.teamId === teamId &&
      member.active &&
      permissions[member.role][resource].includes(operation),
  );
}

function inTeam<T extends Scoped>(rows: readonly T[], id: string, teamId: string): T | undefined {
  return rows.find((row) => row.id === id && row.teamId === teamId);
}

function trialInScope(state: AccessState, row: Owned & { trialId: string }) {
  return inTeam(state.trials, row.trialId, row.teamId)?.athleteId === row.athleteId;
}

function evidenceInScope(state: AccessState, row: EvidenceRecord) {
  const analysis = inTeam(state.analyses, row.analysisRevisionId, row.teamId);
  return (
    trialInScope(state, row) &&
    analysis?.trialId === row.trialId &&
    analysis.athleteId === row.athleteId
  );
}

function canReadLink(state: AccessState, link: Link) {
  const analysis = inTeam(state.analyses, link.claims.analysisRevisionId, link.teamId);
  const evidence = inTeam(state.evidence, link.claims.evidenceSnapshotId, link.teamId);
  return (
    link.claims.teamId === link.teamId &&
    link.claims.shareLinkId === link.id &&
    analysis !== undefined &&
    evidence?.analysisRevisionId === analysis.id &&
    evidenceInScope(state, evidence) &&
    inTeam(state.athletes, evidence.athleteId, evidence.teamId) !== undefined
  );
}

function rowScope(
  state: AccessState,
  resource: Resource,
  row: ResourceRecord,
): { athleteId?: string } | undefined {
  if (!inTeam(state.teams, row.teamId, row.teamId)) {
    return;
  }
  switch (resource) {
    case "Team":
      return row.id === row.teamId ? {} : undefined;
    case "AthleteProfile":
      return { athleteId: row.id };
    case "ShareLink":
      return canReadLink(state, row as Link) ? {} : undefined;
  }
  const owned = row as Owned;
  if (
    !inTeam(state.athletes, owned.athleteId, owned.teamId) ||
    (resource === "AnalysisRevision" && !trialInScope(state, row as AnalysisRecord)) ||
    (resource === "EvidenceSnapshot" && !evidenceInScope(state, row as EvidenceRecord))
  ) {
    return;
  }
  return { athleteId: owned.athleteId };
}

function permittedRow(
  state: AccessState,
  member: Membership,
  resource: Resource,
  row: ResourceRecord,
) {
  const scope = row.teamId === member.teamId && rowScope(state, resource, row);
  if (!scope) {
    return false;
  }
  if (member.role === "Guardian") {
    return state.guardians.some(
      (link) =>
        link.userId === member.userId &&
        link.teamId === member.teamId &&
        link.athleteId === scope.athleteId &&
        link.active,
    );
  }
  return member.role !== "Athlete" || resource === "Team" || scope.athleteId === member.athleteId;
}

function writableTrial(
  state: AccessState,
  userId: string | undefined,
  teamId: string,
  trialId: string,
) {
  const member = memberFor(state, userId, teamId, "TrialVideo", "W");
  const trial = inTeam(state.trials, trialId, teamId);
  return member && trial && permittedRow(state, member, "TrialVideo", trial) ? trial : undefined;
}

function presentRow(row: ResourceRecord) {
  if ("claims" in row) {
    return { id: row.id, ...row.claims, revoked: row.revoked };
  }
  if ("checkpoints" in row) {
    const { checkpoints: _, ...evidence } = row;
    return evidence;
  }
  return row;
}

function onlyFields(fields: Fields, allowed: readonly string[]) {
  return Object.keys(fields).every((key) => allowed.includes(key));
}

function nonblank(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

export class AccessPolicy {
  private lastTime = Number.NEGATIVE_INFINITY;
  private evidenceCatalog = loadEvidenceCatalog();
  private readonly pendingMotionJobs = new Map<
    string,
    {
      job: MotionJob;
      result: Promise<WorkerAnalysisResult>;
    }
  >();
  private readonly pendingRevisionJobs = new Map<
    string,
    { job: MotionJob; result: Promise<{ analysis: WorkerAnalysisResult; recomputeMs: number }> }
  >();

  constructor(
    private readonly store: StateStore<AccessState>,
    private readonly secret: KeyObject,
    private readonly clock: () => number = Date.now,
    private readonly allowShare?: (claims: Readonly<ShareTokenClaims>) => boolean,
  ) {
    if (secret.type !== "secret" || (secret.symmetricKeySize ?? 0) < 32) {
      throw new TypeError("Share signing requires a secret key of at least 32 bytes");
    }
  }

  private now() {
    const current = this.clock();
    if (!Number.isSafeInteger(current)) {
      throw new RangeError("Invalid access clock");
    }
    this.lastTime = Math.max(this.lastTime, current);
    return this.lastTime;
  }

  setEvidenceCatalog(catalog: EvidenceCatalog) {
    this.evidenceCatalog = loadEvidenceCatalog(catalog);
  }

  private readableRow<ResourceKind extends Resource>(
    userId: string | undefined,
    teamId: string,
    resource: ResourceKind,
    id: string,
  ) {
    const state = this.store.read();
    const member = memberFor(state, userId, teamId, resource, "R");
    const row = inTeam<AccessState[(typeof collections)[ResourceKind]][number]>(
      state[collections[resource]],
      id,
      teamId,
    );
    return member && row && permittedRow(state, member, resource, row) ? row : undefined;
  }

  read(userId: string | undefined, teamId: string, resource: Resource, id: string) {
    const row = this.readableRow(userId, teamId, resource, id);
    return row && presentRow(row);
  }

  readEvidenceCheckpoints(userId: string | undefined, teamId: string, id: string) {
    const evidence = this.readableRow(userId, teamId, "EvidenceSnapshot", id);
    return (
      evidence && {
        evidence_snapshot_id: evidence.id,
        evidence_registry_version: evidence.registryVersion,
        checkpoints: evidence.checkpoints ?? [],
      }
    );
  }

  list(userId: string | undefined, teamId: string, resource: Resource) {
    const state = this.store.read();
    const member = memberFor(state, userId, teamId, resource, "L");
    if (!member || !inTeam(state.teams, teamId, teamId)) {
      return;
    }
    const rows = state[collections[resource]]
      .filter((row) => permittedRow(state, member, resource, row))
      .map(presentRow);
    return { rows, count: rows.length };
  }

  write(
    userId: string | undefined,
    teamId: string,
    resource: Resource,
    id: string,
    fields: Fields,
  ) {
    return this.store.update((state) => {
      const member = memberFor(state, userId, teamId, resource, "W");
      if (
        !member ||
        (Object.hasOwn(fields, "teamId") && fields.teamId !== teamId) ||
        (Object.hasOwn(fields, "id") && fields.id !== id) ||
        !inTeam(state.teams, teamId, teamId)
      ) {
        return;
      }
      const common = ["teamId", "id"];
      if (
        resource === "Team" &&
        id === teamId &&
        onlyFields(fields, [...common, "name"]) &&
        nonblank(fields.name)
      ) {
        const team = inTeam(state.teams, id, teamId);
        if (team) {
          team.name = fields.name;
        }
        return team;
      }
      if (
        resource === "AthleteProfile" &&
        onlyFields(fields, [...common, "name"]) &&
        nonblank(fields.name)
      ) {
        const athlete = inTeam(state.athletes, id, teamId);
        if (athlete) {
          athlete.name = fields.name;
        }
        return athlete;
      }
      if (
        resource === "TrialVideo" &&
        onlyFields(fields, [...common, "athleteId", "title"]) &&
        nonblank(fields.title)
      ) {
        const existing = state.trials.find((row) => row.id === id);
        const athleteId = Object.hasOwn(fields, "athleteId")
          ? fields.athleteId
          : existing?.athleteId;
        if (
          !nonblank(athleteId) ||
          (existing && (existing.teamId !== teamId || existing.athleteId !== athleteId))
        ) {
          return;
        }
        const trial = { id, teamId, athleteId, title: fields.title };
        if (!permittedRow(state, member, resource, trial)) {
          return;
        }
        if (existing) {
          existing.title = trial.title;
        } else {
          state.trials.push(trial);
        }
        return trial;
      }
    });
  }

  canAnalyzeTrial(userId: string | undefined, teamId: string, trialId: string) {
    return writableTrial(this.store.read(), userId, teamId, trialId) !== undefined;
  }

  async analyzeTrial(
    userId: string | undefined,
    teamId: string,
    trialId: string,
    submission: unknown,
    worker: MotionWorker,
  ) {
    const state = this.store.read();
    const trial = writableTrial(state, userId, teamId, trialId);
    if (!trial) {
      return;
    }
    const { capture_id, analysis_job_id, ...inputs } = parseAnalysisSubmission(submission, trialId);
    const job: MotionJob = {
      teamId,
      trialId,
      captureId: capture_id,
      jobId: analysis_job_id,
      captureDigest: jsonDigest([inputs.raw_revision_id, inputs.views]),
      requestDigest: jsonDigest([trialId, capture_id, inputs]),
    };
    const existing = checkMotionJob(state.motionJobs ?? [], job);
    if (existing) {
      const receipt = savedAnalysis(state, existing, trial);
      if (
        receipt &&
        !state.motionJobs?.some(
          (saved) => saved.teamId === teamId && saved.trialId === trialId && saved.captureInputs,
        )
      ) {
        this.store.update((draft) => {
          const saved = checkMotionJob(draft.motionJobs ?? [], job);
          if (saved) {
            saved.captureInputs = inputs;
          }
        });
      }
      return receipt && { receipt, created: false };
    }
    checkMotionJob(
      [...this.pendingMotionJobs.values(), ...this.pendingRevisionJobs.values()].map(
        ({ job }) => job,
      ),
      job,
    );
    const key = JSON.stringify([teamId, trialId, analysis_job_id]);
    const pending = this.pendingMotionJobs.get(key);
    const ids = motionIds(job);
    const request = { ...inputs, analysis_revision_id: ids.analysis_revision_id };
    const computation = pending?.result ?? Promise.resolve().then(() => worker.analyze(request));
    if (!pending) {
      this.pendingMotionJobs.set(key, { job, result: computation });
    }
    try {
      const result = await computation;
      if (!validateWorkerResult(result, request)) {
        throw new Error("Motion worker returned an invalid analysis result");
      }
      return this.store.update((draft) => {
        if (writableTrial(draft, userId, teamId, trialId)?.athleteId !== trial.athleteId) {
          return;
        }
        const saved = checkMotionJob(draft.motionJobs ?? [], job);
        if (saved) {
          const receipt = savedAnalysis(draft, saved, trial);
          return receipt && { receipt, created: false };
        }
        if (
          !draft.motionJobs?.some(
            (saved) => saved.teamId === teamId && saved.trialId === trialId && saved.captureInputs,
          )
        ) {
          job.captureInputs = inputs;
        }
        const receipt = this.recordAnalysis(draft, trial, job, inputs.calibration, result);
        return { receipt, created: true };
      });
    } finally {
      if (!pending) {
        this.pendingMotionJobs.delete(key);
      }
    }
  }

  async commitCoordinateRevision(
    userId: string | undefined,
    teamId: string,
    trialId: string,
    submission: unknown,
    worker: MotionWorker,
  ) {
    const state = this.store.read();
    const trial = writableTrial(state, userId, teamId, trialId);
    const history = trial && revisionHistory(state, trial);
    if (!trial || !history) {
      return;
    }
    const { revision, analysisJobId } = parseRevisionCommit(submission);
    const revisionId = revision.revision_id;
    const revisionDigest = jsonDigest(revision);
    const repeat = (snapshot: AccessState, current: typeof history) => {
      const saved = current.jobs.find(
        (job) => job.coordinateCommit?.revision.revision_id === revisionId,
      );
      if (!saved?.coordinateCommit) {
        return;
      }
      if (jsonDigest(saved.coordinateCommit.revision) !== revisionDigest) {
        throw new AnalysisConflict("Coordinate revision ID already has different content");
      }
      const analysis = savedAnalysis(snapshot, saved, trial);
      if (!analysis) {
        throw new Error("Committed coordinate revision is missing its analysis");
      }
      return {
        receipt: revisionReceipt(
          analysis,
          revisionId,
          current.currentHead,
          saved.coordinateCommit.recomputeMs,
        ),
        created: false,
      };
    };
    const repeated = repeat(state, history);
    if (repeated) {
      return repeated;
    }
    if (
      revision.expected_head !== history.currentHead ||
      revision.parent_revision_id !== history.currentHead ||
      revisionId === history.inputs.raw_revision_id ||
      history.revisions.some(({ revision_id }) => revision_id === revisionId)
    ) {
      throw new AnalysisConflict("Coordinate revision does not match the current head");
    }

    const job: MotionJob = {
      teamId,
      trialId,
      captureId: history.base.captureId,
      captureDigest: history.base.captureDigest,
      jobId: analysisJobId,
      requestDigest: jsonDigest(["coordinate_revision", revisionDigest]),
    };
    const key = JSON.stringify([teamId, trialId]);
    const pending = this.pendingRevisionJobs.get(key);
    if (
      (pending && pending.job.requestDigest !== job.requestDigest) ||
      checkMotionJob(state.motionJobs ?? [], job) ||
      checkMotionJob(
        Array.from(this.pendingMotionJobs.values(), ({ job }) => job),
        job,
      )
    ) {
      throw new AnalysisConflict("Another analysis or revision already uses this head or job ID");
    }
    const revisionJob = pending?.job ?? job;
    const { inputs } = history;
    const revisions = [...history.revisions, revision];
    const request = {
      ...inputs,
      revisions,
      analysis_revision_id: motionIds(revisionJob).analysis_revision_id,
    };
    if (!pending) {
      validateEditHistory(inputs, revisions);
    }
    const computation =
      pending?.result ??
      Promise.resolve().then(async () => {
        const start = performance.now();
        const analysis = await worker.analyze(request);
        return { analysis, recomputeMs: performance.now() - start };
      });
    if (!pending) {
      this.pendingRevisionJobs.set(key, { job: revisionJob, result: computation });
    }
    try {
      const { analysis, recomputeMs } = await computation;
      if (!validateWorkerResult(analysis, request)) {
        throw new Error("Motion worker returned an invalid analysis result");
      }
      return this.store.update((draft) => {
        if (writableTrial(draft, userId, teamId, trialId)?.athleteId !== trial.athleteId) {
          return;
        }
        const current = revisionHistory(draft, trial);
        if (!current) {
          return;
        }
        const saved = repeat(draft, current);
        if (saved) {
          return saved;
        }
        if (
          current.currentHead !== history.currentHead ||
          checkMotionJob(draft.motionJobs ?? [], revisionJob)
        ) {
          throw new AnalysisConflict("Coordinate history advanced during recomputation");
        }
        const result = this.recordAnalysis(
          draft,
          trial,
          { ...revisionJob, coordinateCommit: { revision, recomputeMs } },
          inputs.calibration,
          analysis,
        );
        return {
          receipt: revisionReceipt(result, revisionId, revisionId, recomputeMs),
          created: true,
        };
      });
    } finally {
      if (!pending) {
        this.pendingRevisionJobs.delete(key);
      }
    }
  }

  private recordAnalysis(
    draft: AccessState,
    trial: TrialVideo,
    job: MotionJob,
    calibration: AnalysisInputs["calibration"],
    result: WorkerAnalysisResult,
  ): AnalysisReceipt {
    const ids = motionIds(job);
    const { teamId, athleteId, id: trialId } = trial;
    if (
      inTeam(draft.analyses, ids.analysis_revision_id, teamId) ||
      inTeam(draft.evidence, ids.evidence_snapshot_id, teamId)
    ) {
      throw new AnalysisConflict("Analysis or evidence ID is already taken");
    }
    const scope = { teamId, trialId, athleteId };
    const catalog = this.evidenceCatalog;
    const { evidence_comparisons, checkpoints } = compareMetricsAgainstCatalog(
      result.kinematic_metrics,
      catalog,
    );
    draft.analyses.push({
      ...scope,
      id: ids.analysis_revision_id,
      summary: result.kinematic_metrics,
      pose3d: result.pose3d,
      calibration,
      selectedCutoffsHz: result.selected_cutoffs_hz,
    });
    const evidence: EvidenceRecord = {
      ...scope,
      id: ids.evidence_snapshot_id,
      analysisRevisionId: ids.analysis_revision_id,
      contractVersion: result.kinematic_metrics.contract_version,
      registryVersion: catalog.evidence_registry_version,
      comparisons: evidence_comparisons,
      checkpoints,
      nonDiagnostic: catalog.disclaimer_policy.non_diagnostic_flag,
      disclaimerTextJa: catalog.disclaimer_policy.user_facing_text_ja,
    };
    draft.evidence.push(evidence);
    draft.motionJobs ??= [];
    draft.motionJobs.push(job);
    return { ...result, ...ids, ...evidenceReceiptFields(evidence) };
  }

  issue(userId: string | undefined, teamId: string, fields: Fields) {
    const { expiresAt, analysisRevisionId, evidenceSnapshotId } = fields;
    if (
      !onlyFields(fields, ["teamId", "analysisRevisionId", "evidenceSnapshotId", "expiresAt"]) ||
      (Object.hasOwn(fields, "teamId") && fields.teamId !== teamId) ||
      !nonblank(analysisRevisionId) ||
      !nonblank(evidenceSnapshotId) ||
      typeof expiresAt !== "number" ||
      !Number.isSafeInteger(expiresAt) ||
      expiresAt > 8.64e15
    ) {
      return;
    }
    return this.store.update((state) => {
      const now = this.now();
      const member = memberFor(state, userId, teamId, "ShareLink", "S");
      const analysis = inTeam(state.analyses, analysisRevisionId, teamId);
      const evidence = inTeam(state.evidence, evidenceSnapshotId, teamId);
      if (
        now >= expiresAt ||
        !member ||
        !analysis ||
        !evidence ||
        evidence.analysisRevisionId !== analysis.id ||
        evidence.nonDiagnostic !== true ||
        !memberFor(state, userId, teamId, "AnalysisRevision", "R") ||
        !memberFor(state, userId, teamId, "EvidenceSnapshot", "R") ||
        !permittedRow(state, member, "AnalysisRevision", analysis) ||
        !permittedRow(state, member, "EvidenceSnapshot", evidence) ||
        inTeam(state.athletes, analysis.athleteId, teamId)?.shareConsent !== true
      ) {
        return;
      }
      const shareLinkId = randomUUID();
      const claims = { shareLinkId, teamId, analysisRevisionId, evidenceSnapshotId, expiresAt };
      const snapshot = {
        contract_version: evidence.contractVersion,
        share_link_id: shareLinkId,
        team_id: teamId,
        analysis_revision_id: analysisRevisionId,
        evidence_snapshot_id: evidenceSnapshotId,
        evidence_registry_version: evidence.registryVersion,
        issued_at: new Date(now).toISOString(),
        expires_at: new Date(expiresAt).toISOString(),
        non_diagnostic_flag: evidence.nonDiagnostic,
        disclaimer_text_ja: evidence.disclaimerTextJa,
        kinematic_summary: analysis.summary,
        evidence_comparisons: evidence.comparisons,
      };
      if (!validateContract("share_report", snapshot)) {
        return;
      }
      const token = signShareToken(claims, this.secret);
      const pose = analysis.pose3d;
      state.links.push({
        id: shareLinkId,
        teamId,
        claims,
        snapshotJson: JSON.stringify(snapshot),
        ...(validateContract("pose3d", pose) &&
          pose.contract_version === snapshot.contract_version && {
            pose3dJson: JSON.stringify(pose),
          }),
        revoked: false,
      });
      return { shareLinkId, token };
    });
  }

  revoke(userId: string | undefined, teamId: string, id: string) {
    return this.store.update((state) => {
      const member = memberFor(state, userId, teamId, "ShareLink", "S");
      const link = inTeam(state.links, id, teamId);
      if (!member || !link || !permittedRow(state, member, "ShareLink", link)) {
        return false;
      }
      link.revoked = true;
      return true;
    });
  }

  readShare(
    id: string,
    token: string,
    selectors: Partial<Omit<ShareTokenClaims, "shareLinkId" | "expiresAt">>,
    representation: "report" | "pose3d" = "report",
  ) {
    const claims = verifyShareToken(token, this.secret);
    if (
      !claims ||
      claims.shareLinkId !== id ||
      this.now() >= claims.expiresAt ||
      Object.entries(selectors).some(
        ([key, value]) => claims[key as keyof ShareTokenClaims] !== value,
      )
    ) {
      return;
    }
    const link = inTeam(this.store.read().links, id, claims.teamId);
    if (
      !link ||
      link.revoked ||
      link.id !== link.claims.shareLinkId ||
      link.teamId !== link.claims.teamId ||
      Object.keys(claims).some(
        (key) =>
          claims[key as keyof ShareTokenClaims] !== link.claims[key as keyof ShareTokenClaims],
      )
    ) {
      return;
    }
    let snapshot: unknown;
    try {
      snapshot = JSON.parse(link.snapshotJson);
    } catch {
      return;
    }
    if (
      validateContract("share_report", snapshot) &&
      snapshot.non_diagnostic_flag === true &&
      snapshot.share_link_id === id &&
      snapshot.team_id === claims.teamId &&
      snapshot.analysis_revision_id === claims.analysisRevisionId &&
      snapshot.evidence_snapshot_id === claims.evidenceSnapshotId &&
      Date.parse(snapshot.expires_at) === claims.expiresAt &&
      (this.allowShare === undefined || this.allowShare(claims))
    ) {
      if (representation === "report") {
        return link.snapshotJson;
      }
      if (link.pose3dJson !== undefined) {
        try {
          const pose: unknown = JSON.parse(link.pose3dJson);
          if (
            validateContract("pose3d", pose) &&
            pose.contract_version === snapshot.contract_version
          ) {
            return link.pose3dJson;
          }
        } catch {
          return;
        }
      }
    }
  }
}
