from hashlib import file_digest
from pathlib import Path
from typing import Annotated, Self

from pydantic import Field, model_validator

from .contracts import Contract, LicenseTier, NonBlank, SemVer, Stage, StageModel


class LicenseAttestation(Contract):
    attested_by: NonBlank
    rights_evidence: NonBlank
    intended_use: NonBlank


class PluginManifest(StageModel):
    plugin_version: SemVer
    contract_compatibility: Annotated[list[SemVer], Field(min_length=1)]
    license_attestation: LicenseAttestation

    @model_validator(mode="after")
    def validate_compatibility(self) -> Self:
        if len(set(self.contract_compatibility)) != len(self.contract_compatibility):
            raise ValueError("duplicate contract compatibility version")
        return self

    def stage_model(self) -> StageModel:
        return StageModel(
            stage=self.stage, model_hash=self.model_hash, license_tier=self.license_tier
        )


def load_plugin_manifest(
    manifest_path: Path,
    *,
    expected_stage: Stage,
    contract_version: str,
    model_path: Path | None = None,
    expected_plugin_version: str | None = None,
    expected_license_tier: LicenseTier | None = None,
    commercial_default: bool = True,
) -> PluginManifest:
    manifest = PluginManifest.model_validate_json(manifest_path.read_bytes())
    if (
        manifest.stage != expected_stage
        or contract_version not in manifest.contract_compatibility
    ):
        raise ValueError("plugin stage or contract version mismatch")
    if (
        expected_plugin_version is not None
        and manifest.plugin_version != expected_plugin_version
    ):
        raise ValueError("plugin version mismatch")
    if (
        expected_license_tier is not None
        and manifest.license_tier != expected_license_tier
    ):
        raise ValueError("plugin license tier mismatch")
    if commercial_default and manifest.license_tier != "A":
        raise ValueError("commercial default accepts only Tier A plugins")
    if model_path is None:
        actual_hash = "none"
    else:
        with model_path.open("rb") as stream:
            actual_hash = file_digest(stream, "sha256").hexdigest()
    if manifest.model_hash.lower() != actual_hash:
        raise ValueError("model hash mismatch")
    return manifest
