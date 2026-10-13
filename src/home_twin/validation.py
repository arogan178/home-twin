"""Stable validation results and public failures."""

from __future__ import annotations

from dataclasses import dataclass
from enum import StrEnum


class Severity(StrEnum):
    ERROR = "error"
    WARNING = "warning"
    INFO = "info"


@dataclass(frozen=True, slots=True)
class Finding:
    code: str
    severity: Severity
    message: str
    fixture_tags: tuple[str, ...] = ()
    measured_mm: float | None = None
    required_mm: float | None = None


@dataclass(frozen=True, slots=True)
class ValidationReport:
    findings: tuple[Finding, ...] = ()

    @property
    def valid(self) -> bool:
        return not any(finding.severity == Severity.ERROR for finding in self.findings)


class HomeTwinError(RuntimeError):
    code = "home_twin_error"


class GeometryUnavailable(HomeTwinError):
    code = "geometry_unavailable"


class ExternalModification(HomeTwinError):
    code = "external_modification"


class StaleRevision(HomeTwinError):
    code = "stale_revision"


class LayoutRejected(HomeTwinError):
    code = "layout_rejected"

    def __init__(self, report: ValidationReport) -> None:
        self.report = report
        super().__init__("Lighting layout failed validation")

