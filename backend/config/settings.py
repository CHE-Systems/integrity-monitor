"""Runtime configuration models aligned with the architecture plan."""

from __future__ import annotations

from typing import Dict, Optional

from pydantic import BaseModel, RootModel


class AirtableTableConfig(BaseModel):
    base_env: str
    table_env: str
    view_env: Optional[str] = None


class AirtableConfig(RootModel[Dict[str, AirtableTableConfig]]):
    root: Dict[str, AirtableTableConfig]

    def table(self, key: str) -> AirtableTableConfig:
        return self.root[key]


class AlertThresholds(BaseModel):
    max_run_minutes: int = 30
    duplicate_warning_count: int = 500


class RunConfig(BaseModel):
    nightly_cron: str
    weekly_cron: str
    alert_thresholds: AlertThresholds


class FirestoreConfig(BaseModel):
    runs_collection: str
    metrics_collection: str
    issues_collection: str
    config_document: str


class MetricThresholds(BaseModel):
    info: Optional[float] = None
    warning: Optional[float] = None
    critical: Optional[float] = None


class AttendanceRules(BaseModel):
    onboarding_grace_days: int = 7
    limited_schedule_threshold: int = 3
    thresholds: Dict[str, MetricThresholds]


class RuntimeConfig(BaseModel):
    metadata: dict
    run_config: RunConfig
    airtable: AirtableConfig
    firestore: FirestoreConfig
    attendance_rules: AttendanceRules
