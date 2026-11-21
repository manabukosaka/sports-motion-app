import { type KeyObject, randomUUID } from "node:crypto";
import {
  type KinematicMetrics,
  type ShareReportSnapshot,
  validateContract,
} from "@sports-motion/contracts";
import { type ShareTokenClaims, signShareToken, verifyShareToken } from "./share-token.js";
import type { StateStore } from "./state-store.js";

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
}

export interface EvidenceRecord extends Owned {
  analysisRevisionId: string;
  trialId: string;
  contractVersion: string;
  registryVersion: string;
  comparisons: ShareReportSnapshot["evidence_comparisons"];
  nonDiagnostic?: boolean;
  disclaimerTextJa: string;
}

interface Link extends Scoped {
  claims: ShareTokenClaims;
  snapshotJson: string;
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

function presentRow(row: ResourceRecord) {
  if ("claims" in row) {
    return { id: row.id, ...row.claims, revoked: row.revoked };
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

  read(userId: string | undefined, teamId: string, resource: Resource, id: string) {
    const state = this.store.read();
    const member = memberFor(state, userId, teamId, resource, "R");
    const row = inTeam<ResourceRecord>(state[collections[resource]], id, teamId);
    return member && row && permittedRow(state, member, resource, row)
      ? presentRow(row)
      : undefined;
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
      state.links.push({
        id: shareLinkId,
        teamId,
        claims,
        snapshotJson: JSON.stringify(snapshot),
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
      return link.snapshotJson;
    }
  }
}
