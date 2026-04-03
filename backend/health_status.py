"""Health check payload for monitoring (read-only, fast dependency probes)."""

from __future__ import annotations

import logging
import os
from concurrent.futures import ThreadPoolExecutor, wait
from datetime import datetime, timezone
from typing import Any, Dict, Tuple

from .config.config_loader import load_runtime_config
from .config.models import SchemaConfig

logger = logging.getLogger(__name__)

SERVICE_NAME = os.getenv("SERVICE_NAME", "integrity-monitor")

# Firestore collection from default rules.yaml — used when probing without full config
_DEFAULT_RUNS_COLLECTION = "integrity_runs"

_HEALTH_API_TIMEOUT = (2, 2)  # (connect, read) seconds

_PARALLEL_WAIT_S = 2.0  # wall-clock budget for config + airtable + firestore (parallel)


def _utc_timestamp_ms_z() -> str:
    dt = datetime.now(timezone.utc)
    return dt.strftime("%Y-%m-%dT%H:%M:%S") + f".{dt.microsecond // 1000:03d}Z"


def _worst(a: str, b: str) -> str:
    order = {"ok": 0, "degraded": 1, "fail": 2}
    return a if order[a] >= order[b] else b


def _aggregate_status(checks: Dict[str, str]) -> str:
    s = "ok"
    for v in checks.values():
        s = _worst(s, v)
    return s


def _check_config() -> str:
    try:
        load_runtime_config(attempt_discovery=False)
        return "ok"
    except Exception as exc:
        logger.warning("Health: runtime config not loadable: %s", exc)
        return "fail"


def _check_airtable() -> str:
    pat = os.getenv("AIRTABLE_PAT")
    if not pat:
        from .utils.secrets import get_secret

        pat = get_secret("AIRTABLE_PAT")
    if not pat:
        return "fail"
    try:
        from pyairtable import Api

        api = Api(pat, timeout=_HEALTH_API_TIMEOUT)
        api.bases()
        return "ok"
    except Exception as exc:
        logger.warning("Health: Airtable probe failed: %s", exc)
        return "fail"


def _check_firestore() -> str:
    try:
        from google.cloud import firestore
        from google.auth.exceptions import DefaultCredentialsError

        project_id = (
            os.getenv("GOOGLE_CLOUD_PROJECT")
            or os.getenv("GCP_PROJECT_ID")
            or "data-integrity-monitor"
        )
        try:
            db = firestore.Client(project=project_id)
        except DefaultCredentialsError:
            return "fail"
        next(db.collection(_DEFAULT_RUNS_COLLECTION).limit(1).stream(), None)
        return "ok"
    except Exception as exc:
        logger.warning("Health: Firestore probe failed: %s", exc)
        return "fail"


def _check_schema(schema_config: SchemaConfig | None) -> str:
    if schema_config and getattr(schema_config, "entities", None) and len(schema_config.entities) > 0:
        return "ok"
    return "degraded"


def build_health_payload(
    *,
    runner: Any,
    schema_config: SchemaConfig | None,
) -> Tuple[Dict[str, Any], int]:
    """Return JSON body and HTTP status (200 for ok/degraded, 503 for fail)."""

    checks: Dict[str, str] = {}

    pool = ThreadPoolExecutor(max_workers=3)
    try:
        futures = {
            pool.submit(_check_config): "config",
            pool.submit(_check_airtable): "airtable",
            pool.submit(_check_firestore): "firestore",
        }
        done, not_done = wait(futures.keys(), timeout=_PARALLEL_WAIT_S)
        for fut in not_done:
            logger.warning(
                "Health: check %s did not finish within %ss",
                futures[fut],
                _PARALLEL_WAIT_S,
            )
            checks[futures[fut]] = "fail"
        for fut in done:
            name = futures[fut]
            try:
                checks[name] = fut.result()
            except Exception as exc:
                logger.warning("Health: check %s raised: %s", name, exc)
                checks[name] = "fail"
    finally:
        # Do not block the response on a hung dependency probe
        pool.shutdown(wait=False)

    checks["schema"] = _check_schema(schema_config)
    checks["integrity_runner"] = "ok" if runner is not None else "fail"

    overall = _aggregate_status(checks)
    status_code = 503 if overall == "fail" else 200

    body = {
        "status": overall,
        "service": SERVICE_NAME,
        "timestamp": _utc_timestamp_ms_z(),
        "checks": checks,
    }
    return body, status_code
