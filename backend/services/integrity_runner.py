"""Orchestrates a single integrity run end-to-end."""

from __future__ import annotations

import logging
import os
import threading
import time
import uuid
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone
from typing import Any, Callable, Dict, List, Optional, Tuple

from ..analyzers import scorer
from ..checks import attendance, duplicates, links, required_fields, value_checks
from ..clients.airtable import AirtableClient
from ..clients.firestore import FirestoreClient
from ..clients.logging import get_logger, log_check, log_config_load, log_fetch, log_write
from ..config.config_loader import load_runtime_config
from ..config.schema_loader import load_schema_config
from ..config.settings import RuntimeConfig
from ..config.models import SchemaConfig
from ..utils.errors import CheckFailureError, FetchError, IntegrityRunError, WriteError
from ..utils.issues import IssuePayload
from ..fetchers.registry import build_fetchers
from ..utils.timing import timed
from ..writers.firestore_writer import FirestoreWriter
from ..services.feedback_analyzer import get_feedback_analyzer
from ..services.table_id_discovery import discover_table_ids
from ..services.config_updater import update_config
from ..services.status_calculator import calculate_result_status
from ..services.slack_notifier import get_slack_notifier
from ..services.school_year_service import SchoolYearService

logger = get_logger(__name__)

# Maximum duration for an integrity run (seconds)
# Runs exceeding this duration will be terminated and marked as "timeout"
MAX_RUN_DURATION_SECONDS = int(os.getenv("MAX_RUN_DURATION_SECONDS", "1800"))  # 30 minutes default


class IntegrityRunner:
    def __init__(
        self,
        runtime_config: RuntimeConfig | None = None,
    ):
        # Load config without Firestore overrides first to get Firestore config
        temp_config = runtime_config or load_runtime_config(attempt_discovery=True)
        
        self._firestore_client = FirestoreClient(temp_config.firestore)
        
        # Reload config with Firestore client to get overrides
        if runtime_config is None:
            self._runtime_config = load_runtime_config(firestore_client=self._firestore_client, attempt_discovery=True)
        else:
            self._runtime_config = runtime_config
        
        self._schema_config = load_schema_config(firestore_client=self._firestore_client)
        
        self._airtable_client = AirtableClient(self._runtime_config.airtable)
        
        self._firestore_writer = FirestoreWriter(self._firestore_client)

        # Initialize school year service for automatic filtering
        try:
            self._school_year_service = SchoolYearService(self._firestore_client)
            logger.info("Initialized SchoolYearService for automatic school year filtering")
        except Exception as e:
            logger.warning(f"Could not initialize SchoolYearService: {e}. School year filtering will be disabled.", exc_info=True)
            self._school_year_service = None

    def run(
        self,
        run_id: str | None = None,
        trigger: str = "manual",
        cancel_event=None,
        entities: List[str] | None = None,
        run_config: Dict[str, Any] | None = None
    ) -> Dict[str, Any]:
        # Explicitly reference module-level time to avoid UnboundLocalError
        # (Python may treat time as local if used in nested scopes)
        import time as _time_module
        import threading
        # Generate run_id if not provided (for backwards compatibility)
        if run_id is None:
            run_id = str(uuid.uuid4())
        start = _time_module.time()
        start_time = datetime.now(timezone.utc)
        metrics: Dict[str, int] = {}
        entity_counts: Dict[str, int] = {}
        failed_checks: List[str] = []
        status = "running"  # Start with "running" status
        error_message: str | None = None

        logger.info("Integrity run started", extra={"run_id": run_id, "trigger": trigger})
        
        # Store run_id for use in _fetch_records
        self._current_run_id = run_id
        
        # Create initial run document immediately to ensure it exists even if fetch fails
        try:
            initial_metadata = {
                "status": "running",
                "trigger": trigger,
                "started_at": start_time,
            }
            if run_config:
                initial_metadata["run_config"] = run_config
            self._firestore_writer.write_run(run_id, {}, initial_metadata)
        except Exception as exc:
            # Non-blocking - log but don't fail the run
            logger.warning(
                "Failed to create initial run document",
                extra={"run_id": run_id, "error": str(exc)},
            )
        
        # Store selected entities for use in _fetch_records
        # Prefer entities from run_config if provided
        if run_config and run_config.get("entities"):
            selected_entities = run_config["entities"]
        else:
            selected_entities = entities
        
        # Automatically include required entities for specific checks
        if run_config:
            checks = run_config.get("checks", {})
            rules = run_config.get("rules", {})

            # Include "absent" entity when attendance check is selected
            attendance_selected = (
                checks.get("attendance", False) or
                rules.get("attendance_rules", False)
            )
            if attendance_selected:
                # Ensure "absent" is included for attendance checks
                if selected_entities is None:
                    # If no entities specified, fetch all (including absent)
                    selected_entities = None
                elif isinstance(selected_entities, list) and "absent" not in selected_entities:
                    # Add "absent" if not already present
                    selected_entities = selected_entities + ["absent"]

            # Include source entities for cross-entity value check rules
            # E.g., if a rule is stored under "absent" but checks "students" records
            value_checks_selected = checks.get("value_checks", False)
            if value_checks_selected and selected_entities:
                # Get value check rules to find cross-entity dependencies
                value_check_rules = rules.get("value_checks", {})
                if value_check_rules:
                    additional_entities = set()

                    # For each selected entity, check if it has value check rules
                    for entity in selected_entities:
                        entity_rule_ids = value_check_rules.get(entity, [])
                        if entity_rule_ids:
                            # Load the actual rules to check for source_entity
                            try:
                                entity_schema = self._schema_config.entities.get(entity)
                                if entity_schema and entity_schema.value_checks:
                                    for check in entity_schema.value_checks:
                                        # If rule has source_entity, we need to fetch those records too
                                        if check.source_entity and check.source_entity != entity:
                                            additional_entities.add(check.source_entity)
                                            logger.info(
                                                f"Auto-including '{check.source_entity}' entity for cross-entity rule",
                                                extra={
                                                    "rule_id": check.rule_id,
                                                    "rule_entity": entity,
                                                    "source_entity": check.source_entity,
                                                }
                                            )
                            except Exception as exc:
                                logger.debug(f"Could not check cross-entity rules for {entity}: {exc}")

                    # Add any additional entities needed
                    if additional_entities:
                        selected_entities = list(set(selected_entities) | additional_entities)
                        logger.info(
                            "Auto-included source entities for cross-entity rules",
                            extra={
                                "run_id": run_id,
                                "additional_entities": list(additional_entities),
                                "final_entities": selected_entities,
                            }
                        )

            # Note: Relationship checks can validate min_links without fetching target entities.
            # Orphan detection (validating linked records exist) requires target entities,
            # but that's optional. The links check will gracefully skip orphan detection
            # if target entities aren't available.

        self._selected_entities = selected_entities
        
        # Store run_config for use in filtering
        self._run_config = run_config

        # Initialize summary to empty dict so it's always available in finally block
        summary: Dict[str, Any] = {}

        # Setup timeout mechanism
        timeout_triggered = threading.Event()
        timeout_cancel_sent = threading.Event()
        timeout_timer = None

        def handle_timeout():
            """Called when run exceeds maximum duration."""
            timeout_triggered.set()
            logger.error(
                "Run exceeded maximum duration",
                extra={"run_id": run_id, "max_duration_seconds": MAX_RUN_DURATION_SECONDS}
            )
            try:
                self._firestore_writer.write_log(
                    run_id,
                    "error",
                    f"Run exceeded maximum duration ({MAX_RUN_DURATION_SECONDS}s). Cancelling and marking as timeout."
                )
            except Exception:
                pass

            # Signal cancellation so long-running loops can stop ASAP
            try:
                if cancel_event and not cancel_event.is_set():
                    cancel_event.set()
                    timeout_cancel_sent.set()
                    try:
                        self._firestore_writer.write_log(
                            run_id,
                            "error",
                            "Timeout cancellation signal sent. Stopping as soon as current operation allows."
                        )
                    except Exception:
                        pass
            except Exception:
                pass

        # Start timeout timer
        timeout_timer = threading.Timer(MAX_RUN_DURATION_SECONDS, handle_timeout)
        timeout_timer.daemon = True
        timeout_timer.start()
        logger.info(f"Run timeout set to {MAX_RUN_DURATION_SECONDS}s", extra={"run_id": run_id})

        # Helper to check cancellation and timeout
        def check_cancelled():
            nonlocal status, error_message
            # Check timeout first
            if timeout_triggered.is_set():
                # Ensure cancellation signal is set (some code paths only call check_cancelled)
                try:
                    if cancel_event and not cancel_event.is_set():
                        cancel_event.set()
                        timeout_cancel_sent.set()
                except Exception:
                    pass
                raise TimeoutError(f"Run exceeded maximum duration of {MAX_RUN_DURATION_SECONDS} seconds")
            # Then check cancellation
            if cancel_event and cancel_event.is_set():
                status = "cancelled"
                error_message = "Scan cancelled by user"
                try:
                    self._firestore_writer.write_log(run_id, "info", "Scan cancellation detected, stopping...")
                except Exception:
                    pass
                raise IntegrityRunError(
                    run_id=run_id,
                    message=error_message,
                    transient=False,
                )
        
        # Log to Firestore
        try:
            self._firestore_writer.write_log(run_id, "info", f"Integrity run started (trigger: {trigger})")
        except Exception:
            pass  # Non-blocking

        # Auto-discover table IDs and base ID before running scan (non-blocking, fast-fail)
        # This runs synchronously but should complete quickly (< 1s for typical schema files).
        # If it fails or takes too long, we continue with existing config to avoid blocking the scan.
        discovery_result = {}
        try:
            self._firestore_writer.write_log(run_id, "info", "Discovering table IDs from schema...")
            discovery_result = discover_table_ids()
            if discovery_result and discovery_result.get("table_ids"):
                table_count = len(discovery_result.get("table_ids", {}))
                self._firestore_writer.write_log(run_id, "info", f"Discovered {table_count} table ID(s) from schema")
        except Exception as exc:
            logger.warning(
                "Table ID discovery failed, continuing with existing config",
                extra={"run_id": run_id, "error": str(exc)},
            )
            try:
                self._firestore_writer.write_log(run_id, "warning", f"Table ID discovery failed: {str(exc)}")
            except Exception:
                pass
            # Don't fail the run if discovery fails - this is a non-critical optimization
        
        if discovery_result and discovery_result.get("table_ids"):
            table_ids = discovery_result.get("table_ids", {})
            base_id = discovery_result.get("base_id")
            entities = list(table_ids.keys())
            
            logger.info(
                "Discovered IDs before scan",
                extra={
                    "run_id": run_id,
                    "base_id": base_id,
                    "table_count": len(table_ids),
                },
            )
            
            # Update config with discovered IDs (non-blocking, wrapped in try-except)
            # Also set env vars in current process so they're available immediately
            try:
                import os
                from ..services.config_updater import get_env_var_name
                
                # Set base IDs in current process environment (required for all entities)
                if not base_id:
                    logger.error(
                        "Base ID not discovered from schema - cannot set base environment variables",
                        extra={"run_id": run_id},
                    )
                else:
                    for entity in entities:
                        base_var = get_env_var_name(entity, is_base=True)
                        os.environ[base_var] = base_id
                        logger.info(
                            f"Set {base_var}={base_id} in process environment",
                            extra={"run_id": run_id, "entity": entity},
                        )
                
                # Set table IDs in current process environment
                for entity, table_id in table_ids.items():
                    table_var = get_env_var_name(entity, is_base=False)
                    os.environ[table_var] = table_id
                    logger.info(
                        f"Set {table_var}={table_id} in process environment",
                        extra={"run_id": run_id, "entity": entity},
                    )
                
                # Skip .env file updates to avoid triggering uvicorn --reload
                # The environment variables are already set in the current process (above)
                # and will persist for the duration of this scan.
                # Update .env file (fast, local operation)
                # from ..services.config_updater import update_env_file
                # env_results = update_env_file(
                #     table_ids,
                #     base_id=base_id,
                #     entities=entities,
                # )
                # env_updated = sum(1 for v in env_results.values() if v)
                env_updated = 0  # Disabled to prevent reload loop
                
                # Try Firestore update but don't block if it's slow
                fs_updated = 0
                try:
                    from ..services.config_updater import update_firestore_config
                    fs_results = update_firestore_config(
                        table_ids,
                        firestore_client=self._firestore_client,
                    )
                    fs_updated = sum(1 for v in fs_results.values() if v)
                except Exception as fs_exc:
                    logger.debug(
                        "Firestore config update skipped (non-critical)",
                        extra={"run_id": run_id, "error": str(fs_exc)},
                    )
                
                logger.info(
                    "Updated config with discovered IDs",
                    extra={
                        "run_id": run_id,
                        "base_id_set": bool(base_id),
                        "env_updates": env_updated,
                        "firestore_updates": fs_updated,
                    },
                )
                
                # Verify env vars are set before reloading config
                missing_vars = []
                for entity in entities:
                    base_var = get_env_var_name(entity, is_base=True)
                    table_var = get_env_var_name(entity, is_base=False)
                    base_val = os.getenv(base_var)
                    table_val = os.getenv(table_var)
                    
                    if base_id and not base_val:
                        missing_vars.append(base_var)
                    if not table_val:
                        missing_vars.append(table_var)
                
                if missing_vars:
                    logger.error(
                        f"Failed to set environment variables: {missing_vars}",
                        extra={"run_id": run_id},
                    )
                else:
                    logger.info(
                        f"Successfully set all environment variables for {len(entities)} entities",
                        extra={"run_id": run_id},
                    )
                
                # Reload configs dynamically to get latest rules from Firestore
                self._runtime_config = load_runtime_config(firestore_client=self._firestore_client, attempt_discovery=True)
                self._schema_config = load_schema_config(firestore_client=self._firestore_client)
                self._airtable_client = AirtableClient(self._runtime_config.airtable)
                
                logger.info(
                    "Reloaded configs dynamically",
                    extra={"run_id": run_id},
                )
                
            except Exception as exc:
                logger.warning(
                    "Failed to update config with discovered IDs (non-critical)",
                    extra={"run_id": run_id, "error": str(exc)},
                )
                # Continue with scan even if config update fails
        
        # Check for cancellation after discovery
        check_cancelled()

        # Write initial "running" status to Firestore immediately so frontend can see it
        # CRITICAL: Write run document FIRST before any logging to ensure it exists
        initial_metadata = {
            "trigger": trigger,
            "status": "running",
            "started_at": start_time,
        }
        # Include run_config if provided (contains selected entities and rules)
        if run_config:
            initial_metadata["run_config"] = run_config
        
        try:
            self._firestore_writer.write_run(run_id, {}, initial_metadata)
            logger.info("Initial run status written to Firestore", extra={"run_id": run_id})
        except Exception as exc:
            error_msg = str(exc)
            logger.error(
                "Failed to write initial run status to Firestore",
                extra={
                    "run_id": run_id,
                    "error": error_msg,
                    "hint": "Check GOOGLE_APPLICATION_CREDENTIALS environment variable and ensure Firestore is configured"
                },
                exc_info=True
            )
            # Don't fail the run if initial write fails - continue execution
            # The run will still complete and return results, just won't be tracked in Firestore
        
        # LOG SELECTED RULES AT SCAN START (after run document is created)
        # Wrap in try-except so logging failures don't affect the run
        try:
            if run_config:
                logger.info(
                    "=" * 80,
                    extra={"run_id": run_id}
                )
                logger.info(
                    "SCAN STARTED - Rules Configuration",
                    extra={"run_id": run_id}
                )
                logger.info(
                    "=" * 80,
                    extra={"run_id": run_id}
                )

                # Write selected rules to real-time Firestore logs
                selected_entities = run_config.get("entities", [])
                rules_config = run_config.get("rules", {})
                checks_config = run_config.get("checks", {})
                
                # Build summary of selected rules for real-time log
                rules_summary = []
                if rules_config.get("duplicates"):
                    dup_count = sum(len(r) for r in rules_config["duplicates"].values())
                    if dup_count > 0:
                        rules_summary.append(f"duplicates: {dup_count}")
                if rules_config.get("relationships"):
                    rel_count = sum(len(r) for r in rules_config["relationships"].values())
                    if rel_count > 0:
                        rules_summary.append(f"relationships: {rel_count}")
                if rules_config.get("required_fields"):
                    req_count = sum(len(r) for r in rules_config["required_fields"].values())
                    if req_count > 0:
                        rules_summary.append(f"required_fields: {req_count}")
                if rules_config.get("value_checks"):
                    val_count = sum(len(r) for r in rules_config["value_checks"].values())
                    if val_count > 0:
                        rules_summary.append(f"value_checks: {val_count}")
                if rules_config.get("attendance_rules"):
                    rules_summary.append("attendance: enabled")
                
                # Write to real-time Firestore log
                self._firestore_writer.write_log(
                    run_id, "info",
                    f"SCAN CONFIG: entities={selected_entities}, rules=[{', '.join(rules_summary) if rules_summary else 'NONE'}], checks={checks_config}"
                )

                # Log selected entities
                logger.info(
                    f"Selected Entities: {', '.join(selected_entities) if selected_entities else 'ALL'}",
                    extra={"run_id": run_id, "selected_entities": selected_entities}
                )

                # Log selected rules by category
                rules_config = run_config.get("rules", {})

                # Log duplicates
                if "duplicates" in rules_config:
                    dup_rules = rules_config["duplicates"]
                    total_dup = sum(len(rules) for rules in dup_rules.values())
                    logger.info(
                        f"Selected Duplicate Rules: {total_dup} total",
                        extra={"run_id": run_id, "duplicate_rules": dup_rules}
                    )
                    for entity, rule_ids in dup_rules.items():
                        logger.info(
                            f"  - {entity}: {', '.join(rule_ids)}",
                            extra={"run_id": run_id, "entity": entity, "rule_ids": rule_ids}
                        )
                else:
                    logger.info(
                        "Selected Duplicate Rules: NONE (category not selected)",
                        extra={"run_id": run_id}
                    )

                # Log relationships
                if "relationships" in rules_config:
                    rel_rules = rules_config["relationships"]
                    total_rel = sum(len(rules) for rules in rel_rules.values())
                    logger.info(
                        f"Selected Relationship Rules: {total_rel} total",
                        extra={"run_id": run_id, "relationship_rules": rel_rules}
                    )
                    for entity, rule_ids in rel_rules.items():
                        logger.info(
                            f"  - {entity}: {', '.join(rule_ids)}",
                            extra={"run_id": run_id, "entity": entity, "rule_ids": rule_ids}
                        )
                else:
                    logger.info(
                        "Selected Relationship Rules: NONE (category not selected)",
                        extra={"run_id": run_id}
                    )

                # Log required fields
                if "required_fields" in rules_config:
                    req_rules = rules_config["required_fields"]
                    total_req = sum(len(rules) for rules in req_rules.values())
                    logger.info(
                        f"Selected Required Field Rules: {total_req} total",
                        extra={"run_id": run_id, "required_field_rules": req_rules}
                    )
                    for entity, rule_ids in req_rules.items():
                        logger.info(
                            f"  - {entity}: {', '.join(rule_ids)}",
                            extra={"run_id": run_id, "entity": entity, "rule_ids": rule_ids}
                        )
                else:
                    logger.info(
                        "Selected Required Field Rules: NONE (category not selected)",
                        extra={"run_id": run_id}
                    )

                # Log attendance
                if "attendance_rules" in rules_config:
                    attendance_enabled = rules_config["attendance_rules"]
                    logger.info(
                        f"Selected Attendance Rules: {'ENABLED' if attendance_enabled else 'DISABLED'}",
                        extra={"run_id": run_id, "attendance_enabled": attendance_enabled}
                    )
                else:
                    logger.info(
                        "Selected Attendance Rules: NONE (category not selected)",
                        extra={"run_id": run_id}
                    )

                logger.info(
                    "=" * 80,
                    extra={"run_id": run_id}
                )
            else:
                logger.info(
                    "SCAN STARTED - No rule filtering (all rules will be used)",
                    extra={"run_id": run_id}
                )
                # Write to real-time Firestore log that no run_config was received
                self._firestore_writer.write_log(
                    run_id, "warning",
                    f"SCAN CONFIG: run_config is {'None' if run_config is None else 'empty'} - no rule filtering applied, ALL rules will be used"
                )
        except Exception as exc:
            # Logging failures should not affect the run
            logger.warning(
                "Failed to log selected rules configuration",
                extra={"run_id": run_id, "error": str(exc)},
                exc_info=True
            )

        try:
            # Load config (with timing)
            import time as _time_module
            config_start = _time_module.time()
            config_version = self._runtime_config.metadata.get("config_version") if self._runtime_config else None
            config_duration_ms = int((_time_module.time() - config_start) * 1000)
            log_config_load(logger, run_id, config_duration_ms, config_version)

            # Fetch records
            try:
                entities_param = getattr(self, '_selected_entities', None)
                # Note: _fetch_records() will log the start message, so we don't duplicate it here
                with timed("fetch", metrics):
                    records, entity_counts = self._fetch_records(entities_param, cancel_check=check_cancelled)
                fetch_duration = metrics.get("duration_fetch", 0)
                total_records = sum(entity_counts.values())
                log_fetch(logger, run_id, entity_counts, fetch_duration)
                self._firestore_writer.write_log(
                    run_id, "info", 
                    f"Fetched {total_records} records from {len(entity_counts)} entities in {(fetch_duration/1000):.1f}s",
                    {"entity_counts": entity_counts, "duration_ms": fetch_duration}
                )
                
                # Check for cancellation after fetching
                check_cancelled()
            except Exception as exc:
                # If it's already a specific CustomError, re-raise it (or wrap it preserving details)
                if isinstance(exc, (FetchError, IntegrityRunError)):
                    raise
                # Otherwise wrap in FetchError
                try:
                    self._firestore_writer.write_log(run_id, "error", f"Failed to fetch records: {str(exc)}")
                except Exception:
                    pass
                raise FetchError("all", str(exc), run_id) from exc

            # Execute checks
            issues: List[IssuePayload] = []
            try:
                # Log entity counts before starting checks
                total_records_count = sum(len(recs) for recs in records.values())
                entity_list = ", ".join(f"{k} ({len(v)})" for k, v in records.items())
                self._firestore_writer.write_log(
                    run_id, "info",
                    f"Running integrity checks on {total_records_count} records across {len(records)} entities: {entity_list}"
                )
                
                with timed("checks", metrics):
                    # Run each check individually with logging
                    check_results: List[IssuePayload] = []
                    
                    # Get filtered schema config if run_config has rule selection
                    schema_config_to_use = self._schema_config
                    if hasattr(self, "_run_config") and self._run_config:
                        schema_config_to_use = self._filter_rules_by_selection(
                            self._schema_config,
                            self._run_config
                        )
                    
                    should_run_duplicates = False
                    if hasattr(self, "_run_config") and self._run_config:
                        checks = self._run_config.get("checks", {})
                        # Explicitly check if duplicates key exists and respect its value (including False)
                        # This ensures False values from frontend are properly respected
                        if "duplicates" in checks:
                            should_run_duplicates = bool(checks["duplicates"])
                        elif "rules" in self._run_config and "duplicates" in self._run_config["rules"]:
                            # If checks.duplicates is missing, check if rules.duplicates has any rules selected
                            rules_dup = self._run_config["rules"]["duplicates"]
                            should_run_duplicates = any(rules_dup.values()) if isinstance(rules_dup, dict) else bool(rules_dup)
                    
                    if should_run_duplicates:
                        import time as _time_module
                        import json
                        self._firestore_writer.write_log(run_id, "info", "Running duplicates check...")
                        
                        check_start = _time_module.time()
                        dup_issues = duplicates.run(records, schema_config_to_use, run_id=run_id, firestore_writer=self._firestore_writer)
                        check_results.extend(dup_issues)
                        dup_summary = scorer.summarize(dup_issues)
                        dup_duration = int((_time_module.time() - check_start) * 1000)
                        log_check(
                            logger,
                            run_id,
                            "duplicates",
                            len(dup_issues),
                            dup_duration,
                            {k: v for k, v in dup_summary.items() if "duplicate" in k},
                        )
                        self._firestore_writer.write_log(run_id, "info", f"Duplicates check: {len(dup_issues)} issues found in {(dup_duration/1000):.1f}s")
                    else:
                        dup_issues = []
                        self._firestore_writer.write_log(run_id, "info", "Duplicates check skipped (not selected in checks)")
                    check_cancelled()
                    
                    # Links check
                    should_run_links = False  # Default to False - only run when explicitly selected
                    if hasattr(self, "_run_config") and self._run_config:
                        checks = self._run_config.get("checks", {})
                        # Explicitly check if links key exists and respect its value (including False)
                        # This ensures False values from frontend are properly respected
                        if "links" in checks:
                            should_run_links = bool(checks["links"])
                        elif "rules" in self._run_config and "relationships" in self._run_config["rules"]:
                            # If checks.links is missing, check if rules.relationships has any rules selected
                            rules_rel = self._run_config["rules"]["relationships"]
                            should_run_links = any(rules_rel.values()) if isinstance(rules_rel, dict) else bool(rules_rel)
                    
                    if should_run_links:
                        import time as _time_module
                        self._firestore_writer.write_log(run_id, "info", "Running links check...")
                        check_start = _time_module.time()
                        link_issues = links.run(records, schema_config_to_use)
                        check_results.extend(link_issues)
                        link_summary = scorer.summarize(link_issues)
                        link_duration = int((_time_module.time() - check_start) * 1000)
                        log_check(
                            logger,
                            run_id,
                            "links",
                            len(link_issues),
                            link_duration,
                            {k: v for k, v in link_summary.items() if "link" in k},
                        )
                        self._firestore_writer.write_log(run_id, "info", f"Links check: {len(link_issues)} issues found in {(link_duration/1000):.1f}s")
                    else:
                        link_issues = []
                        self._firestore_writer.write_log(run_id, "info", "Links check skipped (not selected in checks)")
                    check_cancelled()
                    
                    # Required fields check
                    should_run_required_fields = False  # Default to False - only run when explicitly selected
                    if hasattr(self, "_run_config") and self._run_config:
                        checks = self._run_config.get("checks", {})
                        # Explicitly check if required_fields key exists and respect its value (including False)
                        # This ensures False values from frontend are properly respected
                        if "required_fields" in checks:
                            should_run_required_fields = bool(checks["required_fields"])
                        elif "rules" in self._run_config and "required_fields" in self._run_config["rules"]:
                            # If checks.required_fields is missing, check if rules.required_fields has any rules selected
                            rules_req = self._run_config["rules"]["required_fields"]
                            should_run_required_fields = any(rules_req.values()) if isinstance(rules_req, dict) else bool(rules_req)
                    
                    if should_run_required_fields:
                        import time as _time_module
                        self._firestore_writer.write_log(run_id, "info", "Running required fields check...")
                        check_start = _time_module.time()
                        req_issues = required_fields.run(records, schema_config_to_use)
                        check_results.extend(req_issues)
                        req_summary = scorer.summarize(req_issues)
                        req_duration = int((_time_module.time() - check_start) * 1000)
                        log_check(
                            logger,
                            run_id,
                            "required_fields",
                            len(req_issues),
                            req_duration,
                            {k: v for k, v in req_summary.items() if "required" in k},
                        )
                        self._firestore_writer.write_log(run_id, "info", f"Required fields check: {len(req_issues)} issues found in {(req_duration/1000):.1f}s")
                    else:
                        req_issues = []
                        self._firestore_writer.write_log(run_id, "info", "Required fields check skipped (not selected in checks)")
                    check_cancelled()
                    
                    # Value checks
                    should_run_value_checks = False  # Default to False - only run when explicitly selected
                    if hasattr(self, "_run_config") and self._run_config:
                        checks = self._run_config.get("checks", {})
                        logger.info(
                            "Checking value_checks configuration",
                            extra={
                                "has_run_config": True,
                                "checks_keys": list(checks.keys()) if checks else [],
                                "checks_value_checks": checks.get("value_checks") if checks else None,
                                "has_rules": "rules" in self._run_config,
                                "rules_value_checks": self._run_config.get("rules", {}).get("value_checks") if "rules" in self._run_config else None,
                            }
                        )
                        # Explicitly check if value_checks key exists and respect its value (including False)
                        # This ensures False values from frontend are properly respected
                        if "value_checks" in checks:
                            should_run_value_checks = bool(checks["value_checks"])
                            logger.info(f"value_checks from checks config: {should_run_value_checks}")
                        elif "rules" in self._run_config and "value_checks" in self._run_config["rules"]:
                            # If checks.value_checks is missing, check if rules.value_checks has any rules selected
                            rules_val = self._run_config["rules"]["value_checks"]
                            should_run_value_checks = any(rules_val.values()) if isinstance(rules_val, dict) else bool(rules_val)
                            logger.info(f"value_checks from rules config: {should_run_value_checks} (rules_val: {rules_val})")
                    else:
                        logger.info("No run_config available for value_checks check")
                    
                    if should_run_value_checks:
                        import time as _time_module
                        self._firestore_writer.write_log(run_id, "info", "Running value checks...")
                        check_start = _time_module.time()
                        val_issues = value_checks.run(records, schema_config_to_use)
                        check_results.extend(val_issues)
                        val_summary = scorer.summarize(val_issues)
                        val_duration = int((_time_module.time() - check_start) * 1000)
                        log_check(
                            logger,
                            run_id,
                            "value_checks",
                            len(val_issues),
                            val_duration,
                            {k: v for k, v in val_summary.items() if "value" in k},
                        )
                        self._firestore_writer.write_log(run_id, "info", f"Value checks: {len(val_issues)} issues found in {(val_duration/1000):.1f}s")
                    else:
                        val_issues = []
                        self._firestore_writer.write_log(run_id, "info", "Value checks check skipped (not selected in checks)")
                    check_cancelled()
                    
                    # Attendance check
                    should_run_attendance = False  # Default to False - only run when explicitly selected
                    if hasattr(self, "_run_config") and self._run_config:
                        checks = self._run_config.get("checks", {})
                        # Explicitly check if attendance key exists and respect its value (including False)
                        # This ensures False values from frontend are properly respected
                        if "attendance" in checks:
                            should_run_attendance = bool(checks["attendance"])
                        elif "rules" in self._run_config and "attendance_rules" in self._run_config["rules"]:
                            # If checks.attendance is missing, check if rules.attendance_rules is enabled
                            should_run_attendance = bool(self._run_config["rules"]["attendance_rules"])

                    attendance_rules_to_use = None
                    if should_run_attendance:
                        attendance_rules_to_use = self._runtime_config.attendance_rules
                        # Also check the legacy rules.attendance_rules field for backwards compatibility
                        if (hasattr(self, "_run_config") and self._run_config and
                            self._run_config.get("rules") and
                            "attendance_rules" in self._run_config["rules"]):
                            # If attendance_rules is False in selection, skip attendance check
                            if self._run_config["rules"]["attendance_rules"] is False:
                                attendance_rules_to_use = None

                    import time as _time_module
                    if attendance_rules_to_use and should_run_attendance:
                        self._firestore_writer.write_log(run_id, "info", "Running attendance check...")
                        check_start = _time_module.time()
                        att_issues = attendance.run(records, attendance_rules_to_use)
                        check_results.extend(att_issues)
                        att_summary = scorer.summarize(att_issues)
                        att_duration = int((_time_module.time() - check_start) * 1000)
                        log_check(
                            logger,
                            run_id,
                            "attendance",
                            len(att_issues),
                            att_duration,
                            {k: v for k, v in att_summary.items() if "attendance" in k},
                        )
                        self._firestore_writer.write_log(run_id, "info", f"Attendance check: {len(att_issues)} issues found in {(att_duration/1000):.1f}s")
                    else:
                        att_issues = []
                        self._firestore_writer.write_log(run_id, "info", "Attendance check skipped (not selected in checks)")
                    
                    # Track which checks actually ran (for reconciliation scoping)
                    checks_executed: List[str] = []
                    if should_run_duplicates:
                        checks_executed.append("duplicates")
                    if should_run_links:
                        checks_executed.append("links")
                    if should_run_required_fields:
                        checks_executed.append("required_fields")
                    if should_run_value_checks:
                        checks_executed.append("value_checks")
                    if should_run_attendance and attendance_rules_to_use:
                        checks_executed.append("attendance")

                    # Merge and summarize issues
                    issues = check_results
                    total_issues_before_merge = len(issues)
                    
                    # Validate no duplicates exist before merging
                    from collections import defaultdict
                    seen_combinations = {}
                    duplicate_warnings = []
                    for issue in check_results:
                        key = f"{issue.rule_id}:{issue.record_id}"
                        if key in seen_combinations:
                            duplicate_warnings.append(f"Duplicate found: {key} (rule: {issue.rule_id}, record: {issue.record_id})")
                        else:
                            seen_combinations[key] = issue
                    
                    if duplicate_warnings:
                        logger.warning(
                            f"Found {len(duplicate_warnings)} duplicate issues before merge",
                            extra={"duplicate_count": len(duplicate_warnings), "total_issues": total_issues_before_merge}
                        )
                        for warning in duplicate_warnings[:10]:  # Log first 10
                            logger.warning(warning)
                    
                    self._firestore_writer.write_log(run_id, "info", f"Merging duplicate issues from {total_issues_before_merge} total issues...")
                    merged = scorer.merge(issues)
                    merged_count = len(merged)
                    self._firestore_writer.write_log(run_id, "info", f"Merged to {merged_count} unique issues (removed {total_issues_before_merge - merged_count} duplicates)")
                    
                    # Add detailed breakdown by rule
                    rule_counts_before = defaultdict(int)
                    rule_counts_after = defaultdict(int)
                    
                    for issue in check_results:
                        rule_counts_before[issue.rule_id] += 1
                    
                    for issue in merged:
                        rule_counts_after[issue.rule_id] += 1
                    
                    self._firestore_writer.write_log(
                        run_id, "info",
                        f"Issue counts by rule - Before merge: {dict(rule_counts_before)}, After merge: {dict(rule_counts_after)}"
                    )
                    
                    self._firestore_writer.write_log(run_id, "info", "Calculating issue summary...")
                    summary = scorer.summarize(merged)
                    self._firestore_writer.write_log(run_id, "info", f"Prepared {len(merged)} total issues for writing | summary={summary}")
            except Exception as exc:
                logger.error("Check execution failed catastrophically", extra={"run_id": run_id}, exc_info=True)
                failed_checks.append("all")
                status = "error"  # Catastrophic failure should be error, not warning
                error_message = f"Check execution failed: {str(exc)}"
                # Fail fast - don't continue with empty results when all checks fail
                raise IntegrityRunError(run_id, error_message, transient=False) from exc

            # Capture scope for reconciliation (entities that were actually fetched + checks that ran)
            entities_included = list(entity_counts.keys()) if entity_counts else []
            checks_executed_list = checks_executed if "checks_executed" in locals() else []

            # Always write to Firestore, even on failure
            # Keep status as "running" until all Firestore operations are complete
            try:
                with timed("write_firestore", metrics):
                    # Write initial run metadata with "running" status (will be updated after all operations complete)
                    run_metadata = {
                        "trigger": trigger,
                        "entity_counts": entity_counts,
                        "status": status,  # Still "running" at this point
                        "started_at": start_time,  # Keep original start time
                        "config_version": config_version,
                        "entities_included": entities_included,
                        "checks_executed": checks_executed_list,
                        **metrics,
                    }
                    if failed_checks:
                        run_metadata["failed_checks"] = failed_checks
                    if error_message:
                        run_metadata["error_message"] = error_message

                    # Include run_config in metadata if provided
                    if hasattr(self, "_run_config") and self._run_config:
                        run_metadata["run_config"] = self._run_config

                    # Update the existing document (merge=True in record_run)
                    # This keeps the status as "running" while operations continue
                    try:
                        self._firestore_writer.write_run(run_id, summary, run_metadata)
                    except RuntimeError as exc:
                        # Credential errors - log but don't fail
                        logger.error(
                            "Firestore credentials not configured - run will not be tracked in Firestore",
                            extra={"run_id": run_id, "error": str(exc)},
                        )
                    except Exception as exc:
                        logger.error(
                            "Failed to write run to Firestore",
                            extra={"run_id": run_id, "error": str(exc)},
                            exc_info=True,
                        )
                    
                    # Write metrics if run completed successfully (will check status after all operations)
                    # This will be done after status is calculated below
                    
                    # Write individual issues to Firestore
                    new_issues_count = 0
                    new_issues_by_severity = None
                    if issues:
                        check_cancelled()  # Check before starting long write operation
                        try:
                            total_issues_to_write = len(merged)
                            self._firestore_writer.write_log(run_id, "info", f"Writing {total_issues_to_write:,} issues to Firestore...")
                            with timed("write_issues_firestore", metrics):
                                new_issues_count = self._firestore_writer.write_issues(merged if issues else [], run_id=run_id)
                            write_issues_duration = metrics.get("duration_write_issues_firestore", 0)
                            updated_count = total_issues_to_write - new_issues_count
                            log_write(logger, run_id, "firestore_issues", total_issues_to_write, write_issues_duration)
                            self._firestore_writer.write_log(run_id, "info", f"Wrote {total_issues_to_write:,} issues to Firestore ({new_issues_count:,} new, {updated_count:,} updated) in {(write_issues_duration/1000):.1f}s")
                            
                            # Calculate new_issues_by_severity by querying Firestore for new issues
                            if new_issues_count > 0:
                                try:
                                    client = self._firestore_client._get_client()
                                    issues_ref = client.collection(self._firestore_client._config.issues_collection)
                                    query = issues_ref.where("first_seen_in_run", "==", run_id)
                                    
                                    by_severity = {"critical": 0, "warning": 0, "info": 0}
                                    for doc in query.stream():
                                        issue_data = doc.to_dict()
                                        severity = issue_data.get("severity", "info")
                                        if severity in by_severity:
                                            by_severity[severity] += 1
                                    
                                    new_issues_by_severity = by_severity
                                    logger.info(
                                        "Calculated new_issues_by_severity",
                                        extra={
                                            "run_id": run_id,
                                            "new_issues_count": new_issues_count,
                                            "by_severity": by_severity,
                                        }
                                    )
                                except Exception as severity_exc:
                                    logger.warning(
                                        "Failed to calculate new_issues_by_severity",
                                        extra={"run_id": run_id, "error": str(severity_exc)},
                                        exc_info=True
                                    )
                                    # Don't fail the run if severity calculation fails
                        except Exception as exc:
                            logger.error("Failed to write issues to Firestore", extra={"run_id": run_id}, exc_info=True)
                            try:
                                self._firestore_writer.write_log(run_id, "error", f"Failed to write issues to Firestore: {str(exc)}")
                            except Exception:
                                pass
                            # Don't fail the run if issue writing fails
                    
                    # Analyze ignored issues and flag rules (nightly runs only)
                    # Only run feedback analysis if run completed successfully (not failed)
                    # Status check will be done after status is calculated below
                    
                    # NOW calculate final status after all Firestore operations are complete
                    # Only calculate result status if run completed successfully (no technical errors)
                    if (status == "running" or status == "success") and not failed_checks and not error_message:
                        # Calculate result status based on issue counts
                        # summary is from scorer.summarize() - flat dict with keys like "issue_type:severity"
                        summary_for_calc = summary if "summary" in locals() and summary else {}
                        result_status = calculate_result_status(summary_for_calc)
                        logger.info(
                            "Calculated result status",
                            extra={
                                "run_id": run_id,
                                "previous_status": status,
                                "result_status": result_status,
                                "summary_total": sum(summary_for_calc.values()) if summary_for_calc else 0,
                            },
                        )
                        status = result_status
                    
                    # Write metrics if run completed successfully (healthy, warning, or critical - not failed)
                    if status in ("healthy", "warning", "critical", "success"):
                        try:
                            metrics_payload = {**summary, **entity_counts}
                            self._firestore_writer.write_metrics(metrics_payload)
                        except Exception as exc:
                            logger.warning(
                                "Failed to write metrics to Firestore",
                                extra={"run_id": run_id, "error": str(exc)},
                            )
                    
                    # Analyze ignored issues and flag rules (nightly runs only)
                    # Only run feedback analysis if run completed successfully (not failed)
                    if trigger == "nightly" and status in ("healthy", "warning", "critical", "success"):
                        try:
                            with timed("feedback_analysis", metrics):
                                feedback_analyzer = get_feedback_analyzer(self._runtime_config)
                                flagged_rules = feedback_analyzer.analyze_ignored_issues()
                                if flagged_rules:
                                    feedback_analyzer.record_flagged_rules(flagged_rules)
                            logger.info(
                                "Feedback analysis completed",
                                extra={"run_id": run_id, "flagged_rules": len(flagged_rules)},
                            )
                        except Exception as exc:
                            logger.warning(
                                "Feedback analysis failed",
                                extra={"run_id": run_id, "error": str(exc)},
                                exc_info=True,
                            )
                            # Don't fail the run if feedback analysis fails
                    
                    # Reconcile open issues: auto-resolve issues no longer found by this scan
                    reconcile_closed_count = 0
                    if status in ("healthy", "warning", "critical", "success") and not failed_checks:
                        try:
                            from .issue_reconciliation import reconcile_open_issues
                            merged_for_reconcile = merged if "merged" in locals() else []
                            with timed("reconcile_issues", metrics):
                                reconcile_closed_count = reconcile_open_issues(
                                    firestore_client=self._firestore_client,
                                    run_id=run_id,
                                    merged=merged_for_reconcile,
                                    entities_included=entities_included,
                                    checks_executed=checks_executed_list,
                                    log_callback=lambda lvl, msg: self._firestore_writer.write_log(run_id, lvl, msg),
                                )
                        except Exception as exc:
                            logger.warning(
                                "Issue reconciliation failed",
                                extra={"run_id": run_id, "error": str(exc)},
                                exc_info=True,
                            )

                    log_write(logger, run_id, "firestore", 1, metrics.get("duration_write_firestore", 0))
                    
                    # Write final status to Firestore now that all operations are complete
                    final_metadata = {
                        "trigger": trigger,
                        "entity_counts": entity_counts,
                        "status": status,  # Final calculated status
                        "started_at": start_time,
                        "config_version": config_version,
                        "entities_included": entities_included,
                        "checks_executed": checks_executed_list,
                        "reconcile_applied": reconcile_closed_count > 0,
                        "reconcile_closed_count": reconcile_closed_count,
                        **metrics,
                    }
                    if failed_checks:
                        final_metadata["failed_checks"] = failed_checks
                    if error_message:
                        final_metadata["error_message"] = error_message
                    # Include run_config in final metadata if provided
                    if hasattr(self, "_run_config") and self._run_config:
                        final_metadata["run_config"] = self._run_config

                    try:
                        self._firestore_writer.write_run(run_id, summary, final_metadata)
                    except Exception as exc:
                        logger.error(
                            "Failed to write final status to Firestore",
                            extra={"run_id": run_id, "error": str(exc)},
                            exc_info=True,
                        )
            except Exception as exc:
                logger.error("Firestore write failed", extra={"run_id": run_id}, exc_info=True)
                # This is critical - log but don't fail the run
                error_message = (error_message or "") + f" Firestore write failed: {str(exc)}"

        except TimeoutError as exc:
            status = "timeout"
            error_message = str(exc)
            logger.error(
                "Integrity run exceeded maximum duration",
                extra={"run_id": run_id, "max_duration_seconds": MAX_RUN_DURATION_SECONDS},
                exc_info=True,
            )
            try:
                self._firestore_writer.write_log(run_id, "error", f"Run timed out: {error_message}")
            except Exception:
                pass
            # Write timeout status to Firestore
            try:
                run_metadata = {
                    "status": status,
                    "started_at": start_time,
                    "ended_at": datetime.now(timezone.utc),
                    "error_message": error_message,
                    **metrics,
                }
                self._firestore_writer.write_run(run_id, {}, run_metadata)
            except Exception:
                logger.error("Failed to write timeout status to Firestore", extra={"run_id": run_id})

        except IntegrityRunError as exc:
            status = "error"
            error_message = str(exc)
            logger.error(
                "Integrity run failed",
                extra={"run_id": run_id, "error": error_message},
                exc_info=True,
            )
            try:
                self._firestore_writer.write_log(run_id, "error", f"Scan failed: {error_message}")
            except Exception:
                pass
            # Still try to write status to Firestore
            try:
                run_metadata = {
                    "status": status,
                    "started_at": start_time,
                    "ended_at": datetime.now(timezone.utc),
                    "error_message": error_message,
                    **metrics,
                }
                self._firestore_writer.write_run(run_id, {}, run_metadata)
            except Exception:
                logger.error("Failed to write error status to Firestore", extra={"run_id": run_id})

        except Exception as exc:
            status = "error"
            error_message = f"Unexpected error: {str(exc)}"
            logger.error(
                "Integrity run failed with unexpected error",
                extra={"run_id": run_id, "error": error_message},
                exc_info=True,
            )
            # Still try to write status to Firestore
            try:
                run_metadata = {
                    "status": status,
                    "started_at": start_time,
                    "ended_at": datetime.now(timezone.utc),
                    "error_message": error_message,
                    **metrics,
                }
                self._firestore_writer.write_run(run_id, {}, run_metadata)
            except Exception:
                logger.error("Failed to write error status to Firestore", extra={"run_id": run_id})

        finally:
            import time as _time_module

            # Cancel timeout timer if it's still running
            if timeout_timer is not None:
                timeout_timer.cancel()

            elapsed_ms = int((_time_module.time() - start) * 1000)
            end_time = datetime.now(timezone.utc)

            # Clear run_id reference
            if hasattr(self, '_current_run_id'):
                delattr(self, '_current_run_id')

            # Ensure status is not "running" before writing final status
            # This acts as a safety net in case status wasn't set earlier
            # Only calculate result status if run completed successfully (no technical errors)
            if status == "running" and not failed_checks and not error_message:
                # Calculate result status based on issue counts
                # summary may be empty dict if no issues found, which is fine - will return "healthy"
                result_status = calculate_result_status(summary if "summary" in locals() else {})
                status = result_status

            # Ensure final status is written
            try:
                final_metadata = {
                    "status": status,
                    "started_at": start_time,  # Always include to prevent fallback from overwriting
                    "ended_at": end_time,
                    "duration_ms": elapsed_ms,
                }
                if error_message:
                    final_metadata["error_message"] = error_message
                if failed_checks:
                    final_metadata["failed_checks"] = failed_checks
                # Include new_issues_count if it was captured
                if "new_issues_count" in locals():
                    final_metadata["new_issues_count"] = new_issues_count
                # Include new_issues_by_severity if it was calculated
                if "new_issues_by_severity" in locals() and new_issues_by_severity:
                    final_metadata["new_issues_by_severity"] = new_issues_by_severity
                # Include run_config in final metadata if provided
                if hasattr(self, "_run_config") and self._run_config:
                    final_metadata["run_config"] = self._run_config
                # Write summary (will only update counts if summary has content, preserving existing counts if empty)
                self._firestore_writer.write_run(run_id, summary, final_metadata)
            except Exception:
                pass  # Already logged above

            # Send Slack notification if enabled
            notify_slack = False
            if hasattr(self, "_run_config") and self._run_config:
                notify_slack = self._run_config.get("notify_slack", False)

            if notify_slack:
                try:
                    notifier = get_slack_notifier(firestore_client=self._firestore_client)
                    issue_summary = summary if "summary" in locals() else {}
                    # Get new_issues_count if it was captured during issue writing
                    new_count = new_issues_count if "new_issues_count" in locals() else None
                    result = notifier.send_notification(
                        run_id=run_id,
                        status=status,
                        issue_counts=issue_summary,
                        trigger=trigger,
                        duration_ms=elapsed_ms,
                        error_message=error_message,
                        run_config=self._run_config,
                        new_issues_count=new_count,
                        started_at=start_time,
                    )
                except Exception as slack_exc:
                    logger.warning(
                        f"Exception in Slack notification: {type(slack_exc).__name__}: {slack_exc}",
                        extra={"run_id": run_id, "error": str(slack_exc)},
                        exc_info=True,
                    )

        logger.info(
            "Integrity run completed",
            extra={
                "run_id": run_id,
                "stage": "complete",
                "trigger": trigger,
                "status": status,
                "duration_ms": elapsed_ms,
                "entity_counts": entity_counts,
                "failed_checks": failed_checks,
            },
        )

        result = {
            "run_id": run_id,
            "status": status,
            "duration_ms": elapsed_ms,
            "issues": summary if "summary" in locals() else {},
            "entity_counts": entity_counts,
        }
        if failed_checks:
            result["failed_checks"] = failed_checks
        if error_message:
            result["error_message"] = error_message

        return result

    def _fetch_records(
        self,
        entities: List[str] | None = None,
        cancel_check: Optional[Callable[[], None]] = None,
    ) -> Tuple[Dict[str, List[dict]], Dict[str, int]]:
        """Fetch records for the specified entities using parallel fetching.

        Args:
            entities: Optional list of entity names to fetch. If None, fetches all entities.
            cancel_check: Optional callback that raises an exception if the operation should be cancelled.
        """
        logger.info("Performing full scan")

        fetchers = build_fetchers(self._airtable_client, self._school_year_service)

        # Filter fetchers by selected entities if provided
        if entities:
            fetchers = {key: fetcher for key, fetcher in fetchers.items() if key in entities}
            logger.info(f"Filtered to {len(fetchers)} entities: {', '.join(entities)}")
        
        # Extract run_id for async logging
        run_id = None
        if hasattr(self, '_current_run_id'):
            run_id = self._current_run_id
        elif hasattr(logger, 'extra') and logger.extra:
            run_id = logger.extra.get('run_id')
        
        # Create async log buffer for non-blocking progress logging
        async_buffer = None
        if run_id:
            async_buffer = self._firestore_writer.create_async_log_buffer(run_id)
            async_buffer.start()
            try:
                async_buffer.log("info", f"Starting to fetch records (entities: {', '.join(fetchers.keys()) if fetchers else 'all'})...")
            except Exception:
                pass
                
        records: Dict[str, List[dict]] = {}
        counts: Dict[str, int] = {}
        errors: Dict[str, Exception] = {}
        
        # Fetch entities in parallel using ThreadPoolExecutor
        max_workers = min(4, len(fetchers)) if fetchers else 1
        parallel_fetch_start = time.time()
        
        logger.info(
            f"[TIMING] Starting parallel fetch: {len(fetchers)} entities, {max_workers} workers",
            extra={
                "entity_count": len(fetchers),
                "max_workers": max_workers,
                "entities": list(fetchers.keys()),
            }
        )
        
        def fetch_entity(key: str, fetcher) -> Tuple[str, List[dict], Optional[Exception]]:
            """Fetch a single entity and return (key, records, error)."""
            entity_start_time = time.time()
            try:
                logger.info(
                    f"[TIMING] Entity '{key}' fetch started",
                    extra={"entity": key, "thread_id": threading.current_thread().ident}
                )
                
                if async_buffer:
                    buffer_log_start = time.time()
                    async_buffer.log("info", f"Fetching {key} records...")
                    buffer_log_duration = time.time() - buffer_log_start
                    if buffer_log_duration > 0.01:
                        logger.debug(
                            f"[TIMING] Entity '{key}' async buffer log: {buffer_log_duration:.3f}s",
                            extra={"entity": key, "buffer_log_duration": buffer_log_duration}
                        )
                
                # Create progress callback that uses async buffer
                callback_times = []
                def log_progress(message: str, metadata: Optional[Dict[str, Any]] = None) -> None:
                    callback_start = time.time()
                    if async_buffer:
                        async_buffer.log("info", message, metadata)
                    callback_duration = time.time() - callback_start
                    callback_times.append(callback_duration)
                    if callback_duration > 0.1:  # Log slow callbacks
                        logger.warning(
                            f"[TIMING] Slow progress callback: {callback_duration:.3f}s",
                            extra={"entity": key, "message": message, "callback_duration": callback_duration}
                        )
                
                fetch_start = time.time()
                data = fetcher.fetch(
                    progress_callback=log_progress if async_buffer else None,
                    cancel_check=cancel_check,
                )
                fetch_duration = time.time() - fetch_start
                
                total_callback_time = sum(callback_times)
                entity_total_time = time.time() - entity_start_time
                
                logger.info(
                    f"[TIMING] Entity '{key}' completed: {entity_total_time:.3f}s total (fetch: {fetch_duration:.3f}s, callbacks: {total_callback_time:.3f}s, {len(callback_times)} callbacks)",
                    extra={
                        "entity": key,
                        "entity_total_time": entity_total_time,
                        "fetch_duration": fetch_duration,
                        "total_callback_time": total_callback_time,
                        "callback_count": len(callback_times),
                        "record_count": len(data),
                    }
                )
                
                if async_buffer:
                    async_buffer.log("info", f"Fetched {len(data)} {key} records")
                
                return (key, data, None)
            except Exception as exc:
                entity_error_time = time.time() - entity_start_time
                if async_buffer:
                    async_buffer.log("error", f"Failed to fetch {key}: {str(exc)}")
                logger.error(
                    f"Failed to fetch {key} after {entity_error_time:.3f}s",
                    extra={"entity": key, "error": str(exc), "duration": entity_error_time},
                    exc_info=True
                )
                return (key, [], exc)
        
        # Execute parallel fetches
        executor = ThreadPoolExecutor(max_workers=max_workers)
        try:
            submit_start = time.time()
            futures = {executor.submit(fetch_entity, key, fetcher): key for key, fetcher in fetchers.items()}
            submit_duration = time.time() - submit_start
            logger.info(
                f"[TIMING] Submitted {len(futures)} fetch tasks in {submit_duration:.3f}s",
                extra={"task_count": len(futures), "submit_duration": submit_duration}
            )
            
            completion_times = {}
            # Use a cancellable wait loop so timeouts/cancellations stop waiting on hung futures.
            pending = set(futures.keys())
            while pending:
                # Check cancellation/timeout frequently while waiting for futures
                if cancel_check:
                    cancel_check()

                done, pending = set(), pending
                try:
                    # Wait briefly for any futures to complete, then re-check cancellation.
                    from concurrent.futures import wait, FIRST_COMPLETED
                    done, pending = wait(pending, timeout=1.0, return_when=FIRST_COMPLETED)
                except Exception:
                    # If wait itself fails, bail out and let outer error handling handle it.
                    raise

                for future in done:
                    result_start = time.time()
                    key, data, error = future.result()
                    result_duration = time.time() - result_start
                    completion_times[key] = time.time() - parallel_fetch_start

                    logger.info(
                        f"[TIMING] Entity '{key}' result retrieved: {result_duration:.3f}s (completed at {completion_times[key]:.3f}s from start)",
                        extra={"entity": key, "result_duration": result_duration, "completion_time": completion_times[key]}
                    )

                    if error:
                        errors[key] = error
                    else:
                        records[key] = data
                        counts[key] = len(data)

            # If we were cancelled mid-wait, attempt to stop outstanding futures quickly.
            # Note: running thread tasks cannot be forcibly killed, but this cancels queued work.
            if cancel_check:
                cancel_check()
        except Exception:
            # Critical: on timeout/cancel we must NOT block waiting for worker threads.
            # Worker threads should stop quickly because Airtable pagination calls cancel_check each page.
            try:
                executor.shutdown(wait=False, cancel_futures=True)
            except Exception:
                pass
            raise
        finally:
            # Normal completion path: wait for threads to finish cleanly.
            # If the executor was already shutdown in the exception path, this is a no-op.
            try:
                executor.shutdown(wait=True, cancel_futures=False)
            except Exception:
                pass
        
        parallel_fetch_duration = time.time() - parallel_fetch_start
        logger.info(
            f"[TIMING] Parallel fetch completed: {parallel_fetch_duration:.3f}s total for {len(fetchers)} entities",
            extra={
                "parallel_fetch_duration": parallel_fetch_duration,
                "entity_count": len(fetchers),
                "completion_times": completion_times,
            }
        )
        
        # Stop async buffer and flush remaining logs
        buffer_stop_start = time.time()
        if async_buffer:
            async_buffer.stop()
        buffer_stop_duration = time.time() - buffer_stop_start
        if buffer_stop_duration > 0.1:
            logger.info(
                f"[TIMING] Async buffer stop/flush: {buffer_stop_duration:.3f}s",
                extra={"buffer_stop_duration": buffer_stop_duration}
            )
        
        # Raise error if any entity failed
        if errors:
            failed_entity = next(iter(errors.keys()))
            error = errors[failed_entity]
            # Include full error details in message
            error_msg = str(error)
            if not error_msg or error_msg == failed_entity:
                # If error message is just the entity name, try to get more details
                error_type = type(error).__name__
                error_repr = repr(error)
                if error_repr != error_msg:
                    error_msg = f"{error_type}: {error_repr}"
                else:
                    error_msg = f"{error_type}: {error_msg}"
            # Use current_run_id if available, otherwise None
            current_run_id = getattr(self, '_current_run_id', None)
            raise FetchError(failed_entity, error_msg, current_run_id) from error
        
        total_records_fetched = sum(counts.values())
        logger.info(
            f"[TIMING] Record fetch summary: {total_records_fetched} total records from {len(records)} entities",
            extra={
                "total_records": total_records_fetched,
                "entity_count": len(records),
                "entity_counts": counts,
            }
        )
        
        return records, counts

    def _filter_rules_by_selection(
        self, schema_config: SchemaConfig, run_config: Dict[str, Any] | None
    ) -> SchemaConfig:
        """Filter SchemaConfig based on selected rules in run_config.
        
        Validates that selected rule IDs exist in the current schema and logs
        warnings for any missing rules.
        
        Args:
            schema_config: Original SchemaConfig
            run_config: Run configuration with optional rules selection
            
        Returns:
            Filtered SchemaConfig with only selected rules that exist
        """
        if not run_config:
            # No run_config at all = use all rules (backwards compatibility)
            logger.info(
                "No run_config provided, using all loaded rules",
                extra={"has_run_config": False}
            )
            return schema_config
        
        rules_selection = run_config.get("rules")
        if rules_selection is None:
            # 'rules' key missing = use all rules (backwards compatibility)
            logger.info(
                "No 'rules' key in run_config, using all loaded rules",
                extra={"has_run_config": True, "has_rules_key": False}
            )
            return schema_config
        
        # If rules_selection is {} (empty dict), continue to filtering logic
        # which will correctly clear all rules for entities not in selection
        logger.info(
            "Rule filtering requested",
            extra={
                "has_run_config": True,
                "has_rules_key": True,
                "rules_selection_is_empty": rules_selection == {},
                "rules_selection_keys": list(rules_selection.keys()) if rules_selection else []
            }
        )
        
        # Extract and log all selected rule IDs from run_config
        selected_rules = {
            "duplicates": {},
            "relationships": {},
            "required_fields": {},
            "value_checks": {},
        }
        
        if "duplicates" in rules_selection:
            selected_rules["duplicates"] = rules_selection.get("duplicates", {})
        
        if "relationships" in rules_selection:
            selected_rules["relationships"] = rules_selection.get("relationships", {})
        
        if "required_fields" in rules_selection:
            selected_rules["required_fields"] = rules_selection.get("required_fields", {})
        
        if "value_checks" in rules_selection:
            selected_rules["value_checks"] = rules_selection.get("value_checks", {})
        
        logger.info(
            "Selected rules from run_config",
            extra={
                "selected_rules": selected_rules,
                "has_duplicates": bool(selected_rules["duplicates"]),
                "has_relationships": bool(selected_rules["relationships"]),
                "has_required_fields": bool(selected_rules["required_fields"]),
                "duplicates_entities": list(selected_rules["duplicates"].keys()) if selected_rules["duplicates"] else [],
                "relationships_entities": list(selected_rules["relationships"].keys()) if selected_rules["relationships"] else [],
                "required_fields_entities": list(selected_rules["required_fields"].keys()) if selected_rules["required_fields"] else [],
            }
        )
        
        # Log before filtering: count rules per category
        total_duplicates = sum(
            len(d.likely or []) + len(d.possible or [])
            for d in schema_config.duplicates.values()
        )
        total_relationships = sum(
            len(e.relationships) for e in schema_config.entities.values()
        )
        total_required_fields = sum(
            len(e.missing_key_data) for e in schema_config.entities.values()
        )
        total_value_checks = sum(
            len(e.value_checks) for e in schema_config.entities.values()
        )
        
        logger.info(
            "Rule filtering: before filtering",
            extra={
                "duplicates_count": total_duplicates,
                "relationships_count": total_relationships,
                "required_fields_count": total_required_fields,
                "value_checks_count": total_value_checks,
                "rules_selection": rules_selection,
            }
        )
        
        # Create a copy to avoid modifying the original
        from copy import deepcopy
        filtered_config = deepcopy(schema_config)
        
        # Track missing rules for logging
        missing_rules = []
        
        # Filter duplicates
        # If duplicates key exists in selection, filter based on selection
        # If it doesn't exist, clear ALL duplicate rules (user didn't select any)
        if "duplicates" in rules_selection:
            selected_dup = rules_selection.get("duplicates", {})
            if selected_dup:
                # User selected specific duplicate rules
                for entity, rule_ids in selected_dup.items():
                    if entity not in filtered_config.duplicates:
                        missing_rules.extend([
                            f"duplicates.{entity}.{rule_id}" 
                            for rule_id in rule_ids
                        ])
                        continue
                        
                    dup_def = filtered_config.duplicates[entity]
                    
                    # Log before filtering
                    before_likely = len(dup_def.likely or [])
                    before_possible = len(dup_def.possible or [])
                    all_existing_rule_ids = [
                        rule.rule_id for rule in (dup_def.likely or []) + (dup_def.possible or [])
                    ]
                    
                    logger.info(
                        f"Filtering duplicate rules for {entity}",
                        extra={
                            "entity": entity,
                            "selected_rule_ids": rule_ids,
                            "likely_before": before_likely,
                            "possible_before": before_possible,
                            "existing_rule_ids": all_existing_rule_ids,
                        }
                    )
                    
                    # Get all existing rule IDs for validation
                    existing_rule_ids = {
                        rule.rule_id for rule in (dup_def.likely or []) + (dup_def.possible or [])
                    }
                    
                    # Check for missing rule IDs
                    for rule_id in rule_ids:
                        if rule_id not in existing_rule_ids:
                            missing_rules.append(f"duplicates.{entity}.{rule_id}")
                    
                    # Filter likely rules
                    likely_filtered = []
                    for rule in (dup_def.likely or []):
                        if rule.rule_id in rule_ids:
                            likely_filtered.append(rule)
                        else:
                            logger.debug(
                                f"Filtering out likely rule: {rule.rule_id}",
                                extra={"entity": entity, "selected_rule_ids": rule_ids}
                            )
                    dup_def.likely = likely_filtered
                    
                    # Filter possible rules
                    possible_filtered = []
                    for rule in (dup_def.possible or []):
                        if rule.rule_id in rule_ids:
                            possible_filtered.append(rule)
                        else:
                            logger.debug(
                                f"Filtering out possible rule: {rule.rule_id}",
                                extra={"entity": entity, "selected_rule_ids": rule_ids}
                            )
                    dup_def.possible = possible_filtered
                    
                    # Log after filtering
                    after_likely = len(dup_def.likely)
                    after_possible = len(dup_def.possible)
                    matched_rule_ids = [
                        rule.rule_id for rule in (dup_def.likely or []) + (dup_def.possible or [])
                    ]
                    
                    logger.info(
                        f"Filtered duplicate rules for {entity}",
                        extra={
                            "entity": entity,
                            "selected_rule_ids": rule_ids,
                            "likely_before": before_likely,
                            "likely_after": after_likely,
                            "possible_before": before_possible,
                            "possible_after": after_possible,
                            "filtered_out": (before_likely + before_possible) - (after_likely + after_possible),
                            "matched_rule_ids": matched_rule_ids,
                        }
                    )
                
            # Clear duplicates for entities not in selection
            for entity in list(filtered_config.duplicates.keys()):
                if entity not in selected_dup:
                    del filtered_config.duplicates[entity]
        else:
            # Key absent = user didn't select any duplicates - clear all
            filtered_config.duplicates = {}
        
        # Filter relationships
        # If relationships key exists in selection, filter based on selection
        # If it doesn't exist, clear ALL relationships (user didn't select any)
        if "relationships" in rules_selection:
            selected_rel = rules_selection.get("relationships", {})
            if selected_rel:
                # User selected specific relationship rules
                for entity, rel_keys in selected_rel.items():
                    if entity not in filtered_config.entities:
                        missing_rules.extend([
                            f"relationships.{entity}.{key}" 
                            for key in rel_keys
                        ])
                        continue
                        
                    entity_schema = filtered_config.entities[entity]
                    # Get all existing relationship keys
                    existing_keys = set(entity_schema.relationships.keys())
                    
                    # Check for missing keys
                    for key in rel_keys:
                        if key not in existing_keys:
                            missing_rules.append(f"relationships.{entity}.{key}")
                    
                    # Filter relationships dict to only include selected keys that exist
                    entity_schema.relationships = {
                        key: rule
                        for key, rule in entity_schema.relationships.items()
                        if key in rel_keys
                    }
            
            # Clear relationships for entities not in selection
            for entity in filtered_config.entities:
                if entity not in selected_rel:
                    filtered_config.entities[entity].relationships = {}
        else:
            # Key absent = user didn't select any relationships - clear all
            for entity in filtered_config.entities:
                filtered_config.entities[entity].relationships = {}
        
        # Filter required fields
        # If required_fields key exists in selection, filter based on selection
        # If it doesn't exist, clear ALL required fields (user didn't select any)
        if "required_fields" in rules_selection:
            selected_req = rules_selection.get("required_fields", {})
            if selected_req:
                # User selected specific required field rules
                for entity, rule_ids in selected_req.items():
                    if entity not in filtered_config.entities:
                        missing_rules.extend([
                            f"required_fields.{entity}.{rule_id}" 
                            for rule_id in rule_ids
                        ])
                        continue
                        
                    entity_schema = filtered_config.entities[entity]
                    
                    # Log before filtering
                    total_rules_before = len(entity_schema.missing_key_data or [])
                    logger.info(
                        f"Filtering required fields for {entity}",
                        extra={
                            "entity": entity,
                            "selected_rule_ids": rule_ids,
                            "selected_rule_count": len(rule_ids),
                            "total_rules_before": total_rules_before,
                        }
                    )
                    
                    # Get all existing rule identifiers for validation
                    existing_identifiers = set()
                    for req in (entity_schema.missing_key_data or []):
                        existing_identifiers.add(f"required.{entity}.{req.field}")
                        if hasattr(req, "rule_id") and req.rule_id:
                            existing_identifiers.add(req.rule_id)
                            # Also add field-based match for timestamp format: {entity}_{field}_{timestamp}
                            if "_" in req.rule_id:
                                parts = req.rule_id.split("_")
                                if len(parts) >= 2:
                                    # Match by {entity}_{field} prefix (ignore timestamp)
                                    field_match = f"{entity}_{parts[1]}"
                                    existing_identifiers.add(field_match)
                    
                    # Check for missing rule IDs
                    for rule_id in rule_ids:
                        if rule_id not in existing_identifiers:
                            missing_rules.append(f"required_fields.{entity}.{rule_id}")
                            logger.warning(
                                f"Selected rule ID not found in schema for {entity}",
                                extra={
                                    "entity": entity,
                                    "rule_id": rule_id,
                                    "existing_identifiers": list(existing_identifiers),
                                }
                            )
                    
                    # Filter missing_key_data array - match ONLY by rule_id or constructed format
                    # Prioritize exact rule_id matching to prevent multiple rules matching
                    filtered_rules = []
                    for req in (entity_schema.missing_key_data or []):
                        rule_id = getattr(req, "rule_id", None)
                        matched = False
                        matched_by = None
                        
                        # Primary: Match by exact rule_id (most reliable)
                        if rule_id and rule_id in rule_ids:
                            matched = True
                            matched_by = "rule_id"
                        # Secondary: Match by constructed format (for rules without rule_id)
                        elif f"required.{entity}.{req.field}" in rule_ids:
                            matched = True
                            matched_by = "constructed_format"
                        # Tertiary: Match by field ID only (for timestamp-based rule IDs)
                        elif rule_id and "_" in rule_id:
                            # Extract field from rule_id format: {entity}_{field}_{timestamp}
                            parts = rule_id.split("_")
                            if len(parts) >= 2:
                                field_match = f"{entity}_{parts[1]}"
                                # Check if any selected rule_id starts with this pattern
                                for selected_id in rule_ids:
                                    if selected_id.startswith(field_match + "_") or selected_id == field_match:
                                        matched = True
                                        matched_by = "field_prefix"
                                        break
                        
                        if matched:
                            filtered_rules.append(req)
                            logger.debug(
                                f"Rule matched for {entity}",
                                extra={
                                    "rule_id": rule_id,
                                    "field": req.field,
                                    "matched_by": matched_by,
                                }
                            )
                    
                    entity_schema.missing_key_data = filtered_rules
                    
                    # Log after filtering with detailed match information
                    matched_rules_info = []
                    for req in filtered_rules:
                        rule_id = getattr(req, "rule_id", None)
                        matched_by = None
                        if rule_id and rule_id in rule_ids:
                            matched_by = "rule_id"
                        elif f"required.{entity}.{req.field}" in rule_ids:
                            matched_by = "constructed_format"
                        elif rule_id and "_" in rule_id:
                            parts = rule_id.split("_")
                            if len(parts) >= 2:
                                field_match = f"{entity}_{parts[1]}"
                                for selected_id in rule_ids:
                                    if selected_id.startswith(field_match + "_") or selected_id == field_match:
                                        matched_by = "field_prefix"
                                        break
                        matched_rules_info.append({
                            "rule_id": rule_id,
                            "field": req.field,
                            "matched_by": matched_by or "unknown"
                        })
                    
                    logger.info(
                        f"Required fields filtered for {entity}",
                        extra={
                            "entity": entity,
                            "matched_rules": matched_rules_info,
                            "matched_rule_count": len(filtered_rules),
                            "total_rules_before": total_rules_before,
                            "total_rules_after": len(filtered_rules),
                            "rules_filtered_out": total_rules_before - len(filtered_rules),
                        }
                    )
            
            # Clear required fields for entities not in selection
            for entity in filtered_config.entities:
                if entity not in selected_req:
                    filtered_config.entities[entity].missing_key_data = []
        else:
            # Key absent = user didn't select any required fields - clear all
            for entity in filtered_config.entities:
                filtered_config.entities[entity].missing_key_data = []
        
        # Filter value_checks
        if "value_checks" in rules_selection:
            selected_value = rules_selection.get("value_checks", {})
            if selected_value:
                # User selected specific value check rules
                for entity, rule_ids in selected_value.items():
                    if entity not in filtered_config.entities:
                        missing_rules.extend([
                            f"value_checks.{entity}.{rule_id}" 
                            for rule_id in rule_ids
                        ])
                        continue
                        
                    entity_schema = filtered_config.entities[entity]
                    
                    # Log before filtering
                    total_rules_before = len(entity_schema.value_checks or [])
                    logger.info(
                        f"Filtering value checks for {entity}",
                        extra={
                            "entity": entity,
                            "selected_rule_ids": rule_ids,
                            "selected_rule_count": len(rule_ids),
                            "total_rules_before": total_rules_before,
                        }
                    )
                    
                    # Get all existing rule identifiers for validation
                    existing_identifiers = set()
                    for check in (entity_schema.value_checks or []):
                        existing_identifiers.add(f"value_check.{entity}.{check.field}")
                        if hasattr(check, "rule_id") and check.rule_id:
                            existing_identifiers.add(check.rule_id)
                    
                    # Check for missing rule IDs
                    for rule_id in rule_ids:
                        if rule_id not in existing_identifiers:
                            missing_rules.append(f"value_checks.{entity}.{rule_id}")
                            logger.warning(
                                f"Selected value check rule ID not found in schema for {entity}",
                                extra={
                                    "entity": entity,
                                    "rule_id": rule_id,
                                    "existing_identifiers": list(existing_identifiers),
                                }
                            )
                    
                    # Filter value_checks array - match by rule_id or constructed format
                    filtered_rules = []
                    for check in (entity_schema.value_checks or []):
                        rule_id = getattr(check, "rule_id", None)
                        matched = False
                        matched_by = None
                        
                        # Primary: Match by exact rule_id (most reliable)
                        if rule_id and rule_id in rule_ids:
                            matched = True
                            matched_by = "rule_id"
                        # Secondary: Match by constructed format (for rules without rule_id)
                        elif f"value_check.{entity}.{check.field}" in rule_ids:
                            matched = True
                            matched_by = "constructed_format"
                        
                        if matched:
                            filtered_rules.append(check)
                            logger.debug(
                                f"Value check rule matched for {entity}",
                                extra={
                                    "rule_id": rule_id,
                                    "field": check.field,
                                    "matched_by": matched_by,
                                }
                            )
                    
                    entity_schema.value_checks = filtered_rules
                    
                    # Log after filtering
                    logger.info(
                        f"Filtered value checks for {entity}",
                        extra={
                            "entity": entity,
                            "selected_rule_ids": rule_ids,
                            "total_rules_before": total_rules_before,
                            "total_rules_after": len(filtered_rules),
                            "rules_filtered_out": total_rules_before - len(filtered_rules),
                        }
                    )
            
            # Clear value checks for entities not in selection
            for entity in filtered_config.entities:
                if entity not in selected_value:
                    filtered_config.entities[entity].value_checks = []
        else:
            # Key absent = user didn't select any value checks - clear all
            for entity in filtered_config.entities:
                filtered_config.entities[entity].value_checks = []
        
        # Log warnings for missing rules
        if missing_rules:
            logger.warning(
                "Some selected rules no longer exist in the current schema and will be ignored",
                extra={
                    "missing_rules": missing_rules,
                    "run_config_has_rules": bool(rules_selection),
                }
            )
        
        # Log after filtering: extract ALL rule IDs that remain
        filtered_duplicates = sum(
            len(d.likely or []) + len(d.possible or [])
            for d in filtered_config.duplicates.values()
        )
        filtered_relationships = sum(
            len(e.relationships) for e in filtered_config.entities.values()
        )
        filtered_required_fields = sum(
            len(e.missing_key_data) for e in filtered_config.entities.values()
        )
        filtered_value_checks = sum(
            len(e.value_checks) for e in filtered_config.entities.values()
        )
        
        # Extract all rule IDs that passed filtering
        filtered_rule_ids = {
            "duplicates": {},
            "relationships": {},
            "required_fields": {},
            "value_checks": {},
        }
        
        # Extract duplicate rule IDs
        for entity, dup_def in filtered_config.duplicates.items():
            likely_ids = [r.rule_id for r in (dup_def.likely or [])]
            possible_ids = [r.rule_id for r in (dup_def.possible or [])]
            filtered_rule_ids["duplicates"][entity] = {
                "likely": likely_ids,
                "possible": possible_ids,
            }
        
        # Extract relationship rule IDs (keys)
        for entity, entity_schema in filtered_config.entities.items():
            if entity_schema.relationships:
                filtered_rule_ids["relationships"][entity] = list(entity_schema.relationships.keys())
        
        # Extract required field rule IDs
        for entity, entity_schema in filtered_config.entities.items():
            if entity_schema.missing_key_data:
                req_ids = [
                    req.rule_id or f"required.{entity}.{req.field}"
                    for req in entity_schema.missing_key_data
                ]
                filtered_rule_ids["required_fields"][entity] = req_ids
        
        # Extract value check rule IDs
        for entity, entity_schema in filtered_config.entities.items():
            if entity_schema.value_checks:
                check_ids = [
                    check.rule_id or f"value_check.{entity}.{check.field}"
                    for check in entity_schema.value_checks
                ]
                filtered_rule_ids["value_checks"][entity] = check_ids
        
        logger.info(
            "Rule filtering: after filtering",
            extra={
                "duplicates_count": filtered_duplicates,
                "relationships_count": filtered_relationships,
                "required_fields_count": filtered_required_fields,
                "value_checks_count": filtered_value_checks,
                "duplicates_filtered": total_duplicates - filtered_duplicates,
                "relationships_filtered": total_relationships - filtered_relationships,
                "required_fields_filtered": total_required_fields - filtered_required_fields,
                "filtered_rule_ids": filtered_rule_ids,
            }
        )

        # DETAILED LOGGING: Show filtered rules in human-readable format
        logger.info("=" * 80)
        logger.info("RULES LOADED - After Filtering")
        logger.info("=" * 80)

        # Log duplicate rules
        if filtered_duplicates > 0:
            logger.info(f"Duplicate Rules Loaded: {filtered_duplicates} total")
            for entity, rule_dict in filtered_rule_ids["duplicates"].items():
                likely = rule_dict.get("likely", [])
                possible = rule_dict.get("possible", [])
                if likely:
                    logger.info(f"  - {entity} (likely): {', '.join(likely)}")
                if possible:
                    logger.info(f"  - {entity} (possible): {', '.join(possible)}")
        else:
            logger.info("Duplicate Rules Loaded: NONE")

        # Log relationship rules
        if filtered_relationships > 0:
            logger.info(f"Relationship Rules Loaded: {filtered_relationships} total")
            for entity, rule_ids in filtered_rule_ids["relationships"].items():
                if rule_ids:
                    logger.info(f"  - {entity}: {', '.join(rule_ids)}")
        else:
            logger.info("Relationship Rules Loaded: NONE")

        # Log required field rules
        if filtered_required_fields > 0:
            logger.info(f"Required Field Rules Loaded: {filtered_required_fields} total")
            for entity, rule_ids in filtered_rule_ids["required_fields"].items():
                if rule_ids:
                    logger.info(f"  - {entity}: {', '.join(rule_ids)}")
        else:
            logger.info("Required Field Rules Loaded: NONE")

        logger.info("=" * 80)

        # Note: attendance_rules is handled separately in attendance.run()
        # since it's not part of SchemaConfig

        return filtered_config
    
    def _execute_checks(self, records: Dict[str, List[dict]]) -> List[IssuePayload]:
        # Get filtered schema config if run_config has rule selection
        schema_config_to_use = self._schema_config
        if hasattr(self, "_run_config") and self._run_config:
            schema_config_to_use = self._filter_rules_by_selection(
                self._schema_config,
                self._run_config
            )
        
        # Log rule counts being passed to checks
        duplicates_count = sum(
            len(d.likely or []) + len(d.possible or [])
            for d in schema_config_to_use.duplicates.values()
        )
        relationships_count = sum(
            len(e.relationships) for e in schema_config_to_use.entities.values()
        )
        required_fields_count = sum(
            len(e.missing_key_data) for e in schema_config_to_use.entities.values()
        )
        value_checks_count = sum(
            len(e.value_checks) for e in schema_config_to_use.entities.values()
        )
        
        logger.info(
            "Executing checks with filtered rules",
            extra={
                "duplicates_rules": duplicates_count,
                "relationships_rules": relationships_count,
                "required_fields_rules": required_fields_count,
                "value_checks_rules": value_checks_count,
            }
        )
        
        results: List[IssuePayload] = []
        
        # Execute duplicates check
        logger.info("Executing duplicates check")
        dup_results = duplicates.run(records, schema_config_to_use)
        results.extend(dup_results)
        logger.info(
            "Duplicates check completed",
            extra={
                "category": "duplicates",
                "issues_found": len(dup_results),
            }
        )
        
        # Execute links check
        logger.info("Executing links check")
        links_results = links.run(records, schema_config_to_use)
        results.extend(links_results)
        logger.info(
            "Links check completed",
            extra={
                "category": "links",
                "issues_found": len(links_results),
            }
        )
        
        # Execute required fields check
        logger.info("Executing required fields check")
        req_results = required_fields.run(records, schema_config_to_use)
        results.extend(req_results)
        logger.info(
            "Required fields check completed",
            extra={
                "category": "required_fields",
                "issues_found": len(req_results),
            }
        )
        
        # Execute value checks
        logger.info("Executing value checks")
        value_results = value_checks.run(records, schema_config_to_use)
        results.extend(value_results)
        logger.info(
            "Value checks completed",
            extra={
                "category": "value_checks",
                "issues_found": len(value_results),
            }
        )
        
        # Handle attendance rules filtering
        attendance_rules_to_use = self._runtime_config.attendance_rules
        if (hasattr(self, "_run_config") and self._run_config and
            self._run_config.get("rules") and
            "attendance_rules" in self._run_config["rules"]):
            # If attendance_rules is False in selection, skip attendance check
            if self._run_config["rules"]["attendance_rules"] is False:
                attendance_rules_to_use = None
                logger.info("Attendance rules disabled by run_config")
        
        attendance_results = []
        if attendance_rules_to_use:
            logger.info("Executing attendance check")
            attendance_results = attendance.run(records, attendance_rules_to_use)
            results.extend(attendance_results)
            logger.info(
                "Attendance check completed",
                extra={
                    "category": "attendance",
                    "issues_found": len(attendance_results),
                }
            )
        else:
            logger.info("Attendance check skipped (no rules configured)")
        
        # Collect all executed rule IDs from filtered config for final summary
        executed_rules = {
            "duplicates": {},
            "relationships": {},
            "required_fields": {},
        }
        
        # Extract duplicate rule IDs
        for entity, dup_def in schema_config_to_use.duplicates.items():
            likely_ids = [r.rule_id for r in (dup_def.likely or [])]
            possible_ids = [r.rule_id for r in (dup_def.possible or [])]
            executed_rules["duplicates"][entity] = {
                "likely": likely_ids,
                "possible": possible_ids,
            }
        
        # Extract relationship rule IDs
        for entity, entity_schema in schema_config_to_use.entities.items():
            if entity_schema.relationships:
                executed_rules["relationships"][entity] = list(entity_schema.relationships.keys())
            if entity_schema.missing_key_data:
                req_ids = [
                    req.rule_id or f"required.{entity}.{req.field}"
                    for req in entity_schema.missing_key_data
                ]
                executed_rules["required_fields"][entity] = req_ids
        
        # Get selected rules from run_config if available
        selected_rules_summary = None
        if hasattr(self, "_run_config") and self._run_config and self._run_config.get("rules"):
            selected_rules_summary = {
                "duplicates": self._run_config["rules"].get("duplicates", {}),
                "relationships": self._run_config["rules"].get("relationships", {}),
                "required_fields": self._run_config["rules"].get("required_fields", {}),
            }
        
        # Log final summary with all selected and executed rules
        logger.info(
            "Final execution summary: All selected and executed rules",
            extra={
                "total_issues": len(results),
                "duplicates_issues": len(dup_results),
                "links_issues": len(links_results),
                "required_fields_issues": len(req_results),
                "attendance_issues": len(attendance_results),
                "selected_rules": selected_rules_summary,
                "executed_rules": executed_rules,
                "executed_duplicates_count": sum(
                    len(d.get("likely", [])) + len(d.get("possible", []))
                    for d in executed_rules["duplicates"].values()
                ),
                "executed_relationships_count": sum(
                    len(r) for r in executed_rules["relationships"].values()
                ),
                "executed_required_fields_count": sum(
                    len(r) for r in executed_rules["required_fields"].values()
                ),
            }
        )

        # DETAILED LOGGING: Human-readable final summary
        logger.info("=" * 80)
        logger.info("SCAN COMPLETED - Final Rules Execution Summary")
        logger.info("=" * 80)

        total_executed = (
            sum(len(d.get("likely", [])) + len(d.get("possible", []))
                for d in executed_rules["duplicates"].values()) +
            sum(len(r) for r in executed_rules["relationships"].values()) +
            sum(len(r) for r in executed_rules["required_fields"].values())
        )
        if attendance_results:
            total_executed += 1  # Count attendance as 1 rule if it ran

        logger.info(f"Total Rules Executed: {total_executed}")
        logger.info(f"Total Issues Found: {len(results)}")
        logger.info("")

        # Show executed rules by category with issue counts
        if executed_rules["duplicates"]:
            logger.info(f"Duplicate Rules Executed: {sum(len(d.get('likely', [])) + len(d.get('possible', [])) for d in executed_rules['duplicates'].values())} rules, {len(dup_results)} issues")
            for entity, rule_dict in executed_rules["duplicates"].items():
                likely = rule_dict.get("likely", [])
                possible = rule_dict.get("possible", [])
                if likely:
                    logger.info(f"  - {entity} (likely): {', '.join(likely)}")
                if possible:
                    logger.info(f"  - {entity} (possible): {', '.join(possible)}")
        else:
            logger.info(f"Duplicate Rules Executed: 0 rules, {len(dup_results)} issues")

        if executed_rules["relationships"]:
            logger.info(f"Relationship Rules Executed: {sum(len(r) for r in executed_rules['relationships'].values())} rules, {len(links_results)} issues")
            for entity, rule_ids in executed_rules["relationships"].items():
                if rule_ids:
                    logger.info(f"  - {entity}: {', '.join(rule_ids)}")
        else:
            logger.info(f"Relationship Rules Executed: 0 rules, {len(links_results)} issues")

        if executed_rules["required_fields"]:
            logger.info(f"Required Field Rules Executed: {sum(len(r) for r in executed_rules['required_fields'].values())} rules, {len(req_results)} issues")
            for entity, rule_ids in executed_rules["required_fields"].items():
                if rule_ids:
                    logger.info(f"  - {entity}: {', '.join(rule_ids)}")
        else:
            logger.info(f"Required Field Rules Executed: 0 rules, {len(req_results)} issues")

        if attendance_results:
            logger.info(f"Attendance Rules Executed: 1 rule set, {len(attendance_results)} issues")
        else:
            logger.info(f"Attendance Rules Executed: 0 rules, 0 issues")

        logger.info("=" * 80)

        return results
