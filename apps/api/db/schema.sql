BEGIN;

CREATE TABLE organizations (
    organization_id text PRIMARY KEY,
    name text NOT NULL
);

CREATE TABLE teams (
    team_id text PRIMARY KEY,
    organization_id text NOT NULL REFERENCES organizations (organization_id),
    name text NOT NULL
);

CREATE TABLE athlete_profiles (
    team_id text NOT NULL REFERENCES teams (team_id),
    athlete_id text NOT NULL,
    name text NOT NULL,
    share_consent boolean NOT NULL DEFAULT false,
    PRIMARY KEY (team_id, athlete_id)
);

CREATE TABLE memberships (
    team_id text NOT NULL REFERENCES teams (team_id),
    user_id text NOT NULL,
    role text NOT NULL CHECK (role IN ('OrgAdmin', 'Coach', 'Athlete', 'Guardian')),
    active boolean NOT NULL DEFAULT true,
    athlete_id text,
    PRIMARY KEY (team_id, user_id),
    FOREIGN KEY (team_id, athlete_id) REFERENCES athlete_profiles (team_id, athlete_id) ON DELETE CASCADE,
    CHECK ((role = 'Athlete') = (athlete_id IS NOT NULL))
);

CREATE TABLE guardian_links (
    team_id text NOT NULL,
    user_id text NOT NULL,
    athlete_id text NOT NULL,
    active boolean NOT NULL DEFAULT true,
    PRIMARY KEY (team_id, user_id, athlete_id),
    FOREIGN KEY (team_id, user_id) REFERENCES memberships (team_id, user_id) ON DELETE CASCADE,
    FOREIGN KEY (team_id, athlete_id) REFERENCES athlete_profiles (team_id, athlete_id) ON DELETE CASCADE
);

CREATE TABLE trial_videos (
    trial_id text PRIMARY KEY,
    team_id text NOT NULL,
    athlete_id text NOT NULL,
    capture_id text NOT NULL,
    object_key text NOT NULL,
    title text NOT NULL,
    UNIQUE (team_id, trial_id),
    UNIQUE (team_id, capture_id),
    FOREIGN KEY (team_id, athlete_id) REFERENCES athlete_profiles (team_id, athlete_id) ON DELETE CASCADE
);

CREATE TABLE coordinate_revisions (
    team_id text NOT NULL,
    trial_id text NOT NULL,
    revision_id text NOT NULL,
    parent_revision_id text,
    revision_number bigint NOT NULL CHECK (revision_number >= 0),
    payload jsonb NOT NULL,
    PRIMARY KEY (team_id, trial_id, revision_id),
    UNIQUE (trial_id, revision_id),
    UNIQUE (trial_id, revision_number),
    FOREIGN KEY (team_id, trial_id) REFERENCES trial_videos (team_id, trial_id) ON DELETE CASCADE,
    FOREIGN KEY (team_id, trial_id, parent_revision_id)
        REFERENCES coordinate_revisions (team_id, trial_id, revision_id),
    CHECK ((revision_number = 0) = (parent_revision_id IS NULL)),
    CHECK (revision_id IS DISTINCT FROM parent_revision_id)
);

CREATE TABLE analysis_revisions (
    team_id text NOT NULL,
    analysis_revision_id text NOT NULL,
    trial_id text NOT NULL,
    analysis_job_id text NOT NULL,
    coordinate_revision_id text NOT NULL,
    contract_version text NOT NULL,
    kinematic_summary jsonb NOT NULL,
    pose3d_object_key text,
    provenance jsonb NOT NULL,
    PRIMARY KEY (team_id, analysis_revision_id),
    UNIQUE (trial_id, analysis_job_id),
    FOREIGN KEY (team_id, trial_id, coordinate_revision_id)
        REFERENCES coordinate_revisions (team_id, trial_id, revision_id) ON DELETE CASCADE
);

CREATE TABLE evidence_snapshots (
    team_id text NOT NULL,
    evidence_snapshot_id text NOT NULL,
    analysis_revision_id text NOT NULL,
    registry_version text NOT NULL,
    contract_version text NOT NULL,
    comparisons jsonb NOT NULL,
    disclaimer_text_ja text NOT NULL,
    non_diagnostic boolean NOT NULL CHECK (non_diagnostic),
    PRIMARY KEY (team_id, evidence_snapshot_id),
    UNIQUE (team_id, analysis_revision_id, evidence_snapshot_id),
    FOREIGN KEY (team_id, analysis_revision_id)
        REFERENCES analysis_revisions (team_id, analysis_revision_id) ON DELETE CASCADE
);

CREATE TABLE share_links (
    team_id text NOT NULL REFERENCES teams (team_id),
    share_link_id uuid NOT NULL,
    analysis_revision_id text,
    evidence_snapshot_id text,
    snapshot_payload bytea,
    pose3d_object_key text,
    issued_at timestamptz NOT NULL,
    expires_at timestamptz NOT NULL CHECK (expires_at > issued_at),
    revoked_at timestamptz CHECK (revoked_at >= issued_at),
    PRIMARY KEY (team_id, share_link_id),
    FOREIGN KEY (team_id, analysis_revision_id, evidence_snapshot_id)
        REFERENCES evidence_snapshots (team_id, analysis_revision_id, evidence_snapshot_id),
    CHECK (
        (analysis_revision_id IS NOT NULL AND evidence_snapshot_id IS NOT NULL AND snapshot_payload IS NOT NULL)
        OR (revoked_at IS NOT NULL AND analysis_revision_id IS NULL AND evidence_snapshot_id IS NULL
            AND snapshot_payload IS NULL AND pose3d_object_key IS NULL)
    )
);

CREATE TABLE deletion_audit_logs (
    receipt_id uuid PRIMARY KEY,
    team_id text NOT NULL REFERENCES teams (team_id),
    deleted_at timestamptz NOT NULL,
    removed_trials integer NOT NULL CHECK (removed_trials >= 0),
    removed_analyses integer NOT NULL CHECK (removed_analyses >= 0),
    revoked_share_links integer NOT NULL CHECK (revoked_share_links >= 0)
);

-- ADR-0003/0006 and S2. Raw references and committed revisions are append-only.
-- The authorized erasure transaction revokes and clears share rows, deletes the athlete
-- with its dependent rows, and inserts the non-PII receipt before committing.
CREATE FUNCTION reject_immutable_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION USING ERRCODE = 'check_violation', MESSAGE = 'Immutable record';
END;
$$;

CREATE TRIGGER trial_capture_immutable
    BEFORE UPDATE OF team_id, trial_id, athlete_id, capture_id, object_key ON trial_videos
    FOR EACH ROW EXECUTE FUNCTION reject_immutable_update();
CREATE TRIGGER coordinate_revision_immutable
    BEFORE UPDATE ON coordinate_revisions
    FOR EACH ROW EXECUTE FUNCTION reject_immutable_update();
CREATE TRIGGER analysis_revision_immutable
    BEFORE UPDATE ON analysis_revisions
    FOR EACH ROW EXECUTE FUNCTION reject_immutable_update();
CREATE TRIGGER evidence_snapshot_immutable
    BEFORE UPDATE ON evidence_snapshots
    FOR EACH ROW EXECUTE FUNCTION reject_immutable_update();
CREATE TRIGGER deletion_audit_immutable
    BEFORE UPDATE OR DELETE ON deletion_audit_logs
    FOR EACH ROW EXECUTE FUNCTION reject_immutable_update();

-- A3. Revocation may erase the pinned payload and references. It cannot replace them or reopen a link.
CREATE FUNCTION enforce_share_snapshot_immutability() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF ROW(NEW.team_id, NEW.share_link_id, NEW.issued_at, NEW.expires_at)
           IS DISTINCT FROM ROW(OLD.team_id, OLD.share_link_id, OLD.issued_at, OLD.expires_at)
       OR (OLD.revoked_at IS NOT NULL AND NEW.revoked_at IS DISTINCT FROM OLD.revoked_at)
       OR (ROW(NEW.analysis_revision_id, NEW.evidence_snapshot_id, NEW.snapshot_payload, NEW.pose3d_object_key)
           IS DISTINCT FROM ROW(OLD.analysis_revision_id, OLD.evidence_snapshot_id, OLD.snapshot_payload, OLD.pose3d_object_key)
           AND NOT (NEW.revoked_at IS NOT NULL AND NEW.analysis_revision_id IS NULL
                    AND NEW.evidence_snapshot_id IS NULL AND NEW.snapshot_payload IS NULL
                    AND NEW.pose3d_object_key IS NULL)) THEN
        RAISE EXCEPTION USING ERRCODE = 'check_violation', MESSAGE = 'Immutable share snapshot';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER share_snapshot_immutable
    BEFORE UPDATE ON share_links
    FOR EACH ROW EXECUTE FUNCTION enforce_share_snapshot_immutability();

COMMIT;
