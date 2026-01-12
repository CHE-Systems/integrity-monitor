"""Slack notification service for sending scan alerts.

Sends formatted Slack messages when scans complete with issues or errors.
"""

import os
import time
from typing import Any, Dict, Optional
from datetime import datetime, timezone
import json

from ..clients.logging import get_logger

logger = get_logger(__name__)


class SlackNotifier:
    """Send notifications to Slack via webhook."""

    def __init__(
        self,
        webhook_url: Optional[str] = None,
        frontend_url: Optional[str] = None,
        firestore_client=None,
    ):
        """Initialize SlackNotifier.
        
        Args:
            webhook_url: Slack webhook URL. If not provided, attempts to read from
                        environment variable SLACK_WEBHOOK_URL or Secret Manager.
            frontend_url: Base URL for the frontend app (for generating links).
                         If not provided, reads from FRONTEND_URL env var.
            firestore_client: Optional FirestoreClient for querying total open issues.
        """
        self._webhook_url = webhook_url
        self._frontend_url = frontend_url or os.getenv("FRONTEND_URL", "")
        self._cached_secret_webhook: Optional[str] = None
        self._firestore_client = firestore_client

    def _get_webhook_url(self) -> Optional[str]:
        """Get webhook URL from configured source.

        Priority:
        1. Direct configuration (self._webhook_url)
        2. Environment variable (SLACK_WEBHOOK_URL)
        3. Google Secret Manager (slack-webhook-url)
        """
        if self._webhook_url:
            return self._webhook_url

        # Try environment variable
        env_webhook = os.getenv("SLACK_WEBHOOK_URL")
        if env_webhook:
            return env_webhook

        # Try Google Secret Manager
        if self._cached_secret_webhook:
            return self._cached_secret_webhook

        try:
            from google.cloud import secretmanager

            client = secretmanager.SecretManagerServiceClient()
            project_id = os.getenv("GCP_PROJECT_ID") or os.getenv("GOOGLE_CLOUD_PROJECT")

            if not project_id:
                logger.warning("No GCP project ID found, cannot access Secret Manager")
                return None

            secret_name = f"projects/{project_id}/secrets/slack-webhook-url/versions/latest"

            try:
                response = client.access_secret_version(request={"name": secret_name})
                self._cached_secret_webhook = response.payload.data.decode("UTF-8")
                return self._cached_secret_webhook
            except Exception as e:
                # Secret doesn't exist or access denied - this is expected if not configured
                logger.warning(f"Could not access Slack webhook secret: {e}")
                return None

        except ImportError:
            logger.warning("google-cloud-secret-manager not installed")
            return None
        except Exception as e:
            logger.warning(f"Error accessing Secret Manager: {e}")
            return None

    def _get_status_emoji(self, status: str) -> str:
        """Get emoji for status."""
        status_emojis = {
            "healthy": "✅",
            "success": "✅",
            "warning": "⚠️",
            "critical": "🚨",
            "error": "❌",
            "timeout": "⏱️",
            "cancelled": "🚫",
        }
        return status_emojis.get(status.lower(), "ℹ️")

    def _get_total_open_issues(self) -> int:
        """Get total count of open issues from Firestore.
        
        Returns:
            Total number of issues with status='open'
        """
        if not self._firestore_client:
            return 0
        
        try:
            client = self._firestore_client._get_client()
            issues_ref = client.collection(self._firestore_client._config.issues_collection)
            query = issues_ref.where("status", "==", "open")
            
            # Stream and count (more reliable than count aggregation)
            count = 0
            for _ in query.stream():
                count += 1
            return count
        except Exception as exc:
            logger.warning(
                "Failed to get total open issues count",
                extra={"error": str(exc)},
                exc_info=True
            )
            return 0

    def _get_status_color(self, status: str) -> str:
        """Get Slack attachment color for status."""
        status_colors = {
            "healthy": "#36a64f",  # green
            "success": "#36a64f",  # green
            "warning": "#ffc107",  # yellow/amber
            "critical": "#dc3545",  # red
            "error": "#dc3545",  # red
            "timeout": "#6c757d",  # gray
            "cancelled": "#6c757d",  # gray
        }
        return status_colors.get(status.lower(), "#439FE0")  # default blue

    def _build_message(
        self,
        run_id: str,
        status: str,
        issue_counts: Dict[str, int],
        trigger: str = "manual",
        duration_ms: Optional[int] = None,
        error_message: Optional[str] = None,
        run_config: Optional[Dict[str, Any]] = None,
        new_issues_count: Optional[int] = None,
        started_at: Optional[datetime] = None,
    ) -> Dict[str, Any]:
        """Build Slack message payload.

        Args:
            run_id: The integrity run ID
            status: Final status (healthy, warning, critical, error, timeout)
            issue_counts: Dictionary of issue type -> count
            trigger: What triggered the scan (manual, schedule, nightly)
            duration_ms: Run duration in milliseconds
            error_message: Error message if status is error/timeout
            run_config: Optional run configuration with rules info
            new_issues_count: Number of new issues found (vs previously existing)
            started_at: Optional datetime when the run started

        Returns:
            Slack message payload dict
        """
        emoji = self._get_status_emoji(status)
        color = self._get_status_color(status)

        # Build header based on status
        if status.lower() == "error":
            header_text = f"⛭ Data Integrity Scan Error"
        else:
            header_text = f"⛭ Data Integrity Scan Complete"

        # Format run info line
        trigger_display = trigger.title()
        
        # Format duration
        duration_str = ""
        if duration_ms is not None:
            duration_secs = duration_ms / 1000
            if duration_secs >= 60:
                duration_str = f"{int(duration_secs // 60)}m {int(duration_secs % 60)}s"
            else:
                duration_str = f"{duration_secs:.1f}s"
        
        # Format started time
        started_str = ""
        if started_at:
            if isinstance(started_at, datetime):
                start_dt = started_at
            else:
                # Try to convert from Firestore timestamp
                try:
                    start_dt = started_at.to_datetime() if hasattr(started_at, 'to_datetime') else datetime.fromisoformat(str(started_at))
                except:
                    start_dt = datetime.now(timezone.utc)
            
            # Format as "Today 4:25 PM" or "Yesterday 4:25 PM" or date
            now = datetime.now(timezone.utc)
            today_start = now.replace(hour=0, minute=0, second=0, microsecond=0)
            from datetime import timedelta
            yesterday_start = today_start - timedelta(days=1)
            
            # Format time (remove leading zero from hour)
            hour_str = str(start_dt.hour % 12 or 12)
            time_str = f"{hour_str}:{start_dt.strftime('%M %p')}"
            
            if start_dt >= today_start:
                started_str = f"Today {time_str}"
            elif start_dt >= yesterday_start:
                started_str = f"Yesterday {time_str}"
            else:
                day_str = str(start_dt.day)
                started_str = f"{start_dt.strftime('%b')} {day_str}, {time_str}"
        
        # Build run URL - try multiple sources
        run_url = None
        frontend_url = self._frontend_url or os.getenv("FRONTEND_URL", "")
        if not frontend_url and run_config:
            # Try to get from run_config if available
            frontend_url = run_config.get("frontend_url", "")
        
        # Try to construct from Firebase project if we have project ID
        if not frontend_url:
            project_id = os.getenv("GCP_PROJECT_ID") or os.getenv("GOOGLE_CLOUD_PROJECT")
            if project_id:
                # Default Firebase hosting pattern
                frontend_url = f"https://{project_id}.web.app"
        
        if frontend_url:
            base_url = frontend_url.rstrip("/")
            run_url = f"{base_url}/run/{run_id}"

        # Build run info line with hyperlinked runId
        if run_url:
            # Slack link format: <url|text>
            run_info_line = f"Run: <{run_url}|{run_id}> • Trigger: {trigger_display}"
        else:
            run_info_line = f"Run: {run_id} • Trigger: {trigger_display}"
        if duration_str:
            run_info_line += f" • Duration: {duration_str}"
        if started_str:
            run_info_line += f" • Started: {started_str}"

        # Parse issue counts to get types and severity, and calculate total without double counting
        issue_type_counts: Dict[str, int] = {}
        critical_count = 0
        warning_count = 0
        total_issues_from_scan = 0

        # Map internal keys to display names
        display_names = {
            "duplicates": "Duplicates",
            "duplicate": "Duplicates",
            "relationships": "Relationships",
            "relationship": "Relationships",
            "links": "Links",
            "link": "Links",
            "required_fields": "Required Fields",
            "required_field": "Missing required field",
            "missing_key_data": "Missing required field",
            "value_checks": "Value Checks",
            "value_check": "Value Checks",
            "attendance": "Attendance",
        }

        # Track which base keys we've seen with severity-specific versions
        base_keys_with_severity = set()
        
        # First pass: Identify all base keys that have severity-specific versions
        for key, count in issue_counts.items():
            if count > 0 and ":" in key:
                issue_type, _ = key.split(":", 1)
                base_key = issue_type.lower()
                base_keys_with_severity.add(base_key)
        
        # Second pass: Count issues, prioritizing severity-specific keys over base keys
        # Also calculate total issues from this scan (avoiding double counting)
        for key, count in issue_counts.items():
            if count > 0:
                if ":" in key:
                    # Severity-specific key like "duplicate:critical"
                    issue_type, severity = key.split(":", 1)
                    severity = severity.lower()
                    if severity in ("critical", "high"):
                        critical_count += count
                    elif severity in ("warning", "medium", "low"):
                        warning_count += count
                    
                    # Track by type (only count severity-specific keys to avoid double counting)
                    base_key = issue_type.lower()
                    display_name = display_names.get(base_key, base_key.replace("_", " ").title())
                    issue_type_counts[display_name] = issue_type_counts.get(display_name, 0) + count
                    # Count this in total (severity-specific keys are the source of truth)
                    total_issues_from_scan += count
                else:
                    # Base key like "duplicate" - only count if we haven't seen severity-specific versions
                    base_key = key.lower()
                    if base_key not in base_keys_with_severity:
                        display_name = display_names.get(base_key, base_key.replace("_", " ").title())
                        issue_type_counts[display_name] = issue_type_counts.get(display_name, 0) + count
                        # Count this in total (base key only counted if no severity-specific version exists)
                        total_issues_from_scan += count

        # Build scope section
        scope_lines = []
        if run_config:
            entities = run_config.get("entities", [])
            if entities:
                scope_lines.append(f"• Table: {entities[0]}")
            
            rules = run_config.get("rules", {})
            rule_set_name = None
            rule_name = None
            
            if rules.get("required_fields"):
                rule_set_name = "Required Fields"
                for entity, rule_ids in rules["required_fields"].items():
                    if rule_ids:
                        # Get first rule ID
                        rule_id = rule_ids[0]
                        if rule_id.startswith("required."):
                            parts = rule_id.split(".")
                            if len(parts) >= 3:
                                rule_name = f"required_field_rule.{parts[1]}.{parts[2]}"
                        else:
                            rule_name = f"required_field_rule.{entity}.{rule_id}"
                        break
            elif rules.get("duplicates"):
                rule_set_name = "Duplicates"
                for entity, rule_ids in rules["duplicates"].items():
                    if rule_ids:
                        rule_name = rule_ids[0]
                        break
            elif rules.get("relationships"):
                rule_set_name = "Relationships"
                for entity, rule_ids in rules["relationships"].items():
                    if rule_ids:
                        rule_name = rule_ids[0]
                        break
            elif rules.get("attendance_rules"):
                rule_set_name = "Attendance Rules"
                rule_name = "attendance.general"
            
            if rule_set_name:
                scope_lines.append(f"• Rule set: {rule_set_name}")
            if rule_name:
                scope_lines.append(f"• Rule: {rule_name}")

        # Build results section
        results_lines = []
        
        # New issues
        new_issues_display = new_issues_count if new_issues_count is not None else 0
        results_lines.append(f"• New issues: {new_issues_display}")
        
        # Total issues from this scan
        results_lines.append(f"• Total issues found: {total_issues_from_scan}")
        
        # Issue types
        if issue_type_counts:
            type_parts = []
            for issue_type, count in sorted(issue_type_counts.items()):
                type_parts.append(f"{issue_type} ({count})")
            results_lines.append(f"• Issue types: {', '.join(type_parts)}")
        
        # Severity
        severity_parts = []
        if warning_count > 0:
            severity_parts.append(f"Warning ({warning_count})")
        if critical_count > 0:
            severity_parts.append(f":red_circle: Critical ({critical_count})")
        if severity_parts:
            results_lines.append(f"• Severity: {' '.join(severity_parts)}")
        
        # Run status
        status_emoji = emoji
        status_display = status.title()
        results_lines.append(f"• Run status: {status_emoji} {status_display}")

        # Build message text
        text_parts = [run_info_line]
        text_parts.append("")
        
        if scope_lines:
            text_parts.append("Scope")
            text_parts.extend(scope_lines)
            text_parts.append("")
        
        if results_lines:
            text_parts.append("Results")
            text_parts.extend(results_lines)

        if error_message:
            text_parts.append(f"\n*Error:* {error_message}")

        # Add literal link at bottom as fallback
        if run_url:
            text_parts.append("")
            text_parts.append(f"View run: {run_url}")

        # Construct message
        attachment = {
            "color": color,
            "text": "\n".join(text_parts),
            "ts": int(time.time()),
        }

        if run_url:
            attachment["actions"] = [
                {
                    "type": "button",
                    "text": "View Details",
                    "url": run_url,
                    "style": "primary",
                }
            ]
            attachment["fallback"] = f"{header_text} - {run_url}"
        else:
            attachment["fallback"] = header_text

        return {
            "text": header_text,
            "attachments": [attachment],
        }

    def should_notify(self, status: str) -> bool:
        """Check if notification should be sent for this status.
        
        Notifications are sent for:
        - warning: Issues found but not critical
        - critical: Critical issues found
        - error: Scan failed with an error
        - timeout: Scan timed out
        
        NOT sent for:
        - healthy/success: No issues found
        - cancelled: User cancelled the scan
        """
        notify_statuses = {"warning", "critical", "error", "timeout"}
        return status.lower() in notify_statuses

    def send_notification(
        self,
        run_id: str,
        status: str,
        issue_counts: Dict[str, int],
        trigger: str = "manual",
        duration_ms: Optional[int] = None,
        error_message: Optional[str] = None,
        run_config: Optional[Dict[str, Any]] = None,
        new_issues_count: Optional[int] = None,
        started_at: Optional[datetime] = None,
    ) -> bool:
        """Send a Slack notification for a completed scan.

        Args:
            run_id: The integrity run ID
            status: Final status (healthy, warning, critical, error, timeout)
            issue_counts: Dictionary of issue type -> count
            trigger: What triggered the scan (manual, schedule, nightly)
            duration_ms: Run duration in milliseconds
            error_message: Error message if status is error/timeout
            run_config: Optional run configuration with rules info
            new_issues_count: Number of new issues found (vs previously existing)

        Returns:
            True if notification was sent successfully, False otherwise
        """
        # Check if we should notify for this status
        should_notify_result = self.should_notify(status)

        if not should_notify_result:
            logger.info(
                f"Skipping notification - status '{status}' not in notify list",
                extra={"run_id": run_id, "status": status},
            )
            return False

        webhook_url = self._get_webhook_url()

        if not webhook_url:
            logger.warning(
                "Slack webhook URL not configured",
                extra={"run_id": run_id},
            )
            return False

        try:
            import urllib.request
            import urllib.error
            message = self._build_message(
                run_id=run_id,
                status=status,
                issue_counts=issue_counts,
                trigger=trigger,
                duration_ms=duration_ms,
                error_message=error_message,
                run_config=run_config,
                new_issues_count=new_issues_count,
                started_at=started_at,
            )

            # Log the full message payload
            logger.info(f"[SLACK DEBUG] Message payload:\n{json.dumps(message, indent=2)}")

            data = json.dumps(message).encode("utf-8")
            logger.info(f"[SLACK DEBUG] Sending POST request to Slack webhook ({len(data)} bytes)...")

            req = urllib.request.Request(
                webhook_url,
                data=data,
                headers={"Content-Type": "application/json"},
                method="POST",
            )

            with urllib.request.urlopen(req, timeout=10) as response:
                response_body = response.read().decode("utf-8")
                logger.info(
                    f"[SLACK DEBUG] Slack API response: status={response.status}, body='{response_body}'"
                )

                if response.status == 200:
                    logger.info(
                        f"[SLACK DEBUG] ✅ Slack notification sent successfully!",
                        extra={"run_id": run_id, "status": status},
                    )
                    return True
                else:
                    logger.warning(
                        f"[SLACK DEBUG] ❌ Slack API returned non-200 status: {response.status}, body: {response_body}",
                        extra={"run_id": run_id, "status": status},
                    )
                    return False

        except urllib.error.HTTPError as e:
            response_body = e.read().decode("utf-8") if e.fp else "No response body"
            logger.error(
                f"[SLACK DEBUG] ❌ HTTP Error sending Slack notification: {e.code} {e.reason}, "
                f"response body: {response_body}",
                extra={"run_id": run_id, "status": status},
            )
            return False
        except urllib.error.URLError as e:
            logger.error(
                f"[SLACK DEBUG] ❌ URL Error sending Slack notification: {e}",
                extra={"run_id": run_id, "status": status},
                exc_info=True,
            )
            return False
        except Exception as e:
            logger.error(
                f"[SLACK DEBUG] ❌ Unexpected error sending Slack notification: {type(e).__name__}: {e}",
                extra={"run_id": run_id, "status": status},
                exc_info=True,
            )
            return False


def get_slack_notifier(
    webhook_url: Optional[str] = None,
    frontend_url: Optional[str] = None,
    firestore_client=None,
) -> SlackNotifier:
    """Factory function to create a SlackNotifier instance.
    
    Args:
        webhook_url: Optional webhook URL override
        frontend_url: Optional frontend URL override
        firestore_client: Optional FirestoreClient for querying total open issues
        
    Returns:
        Configured SlackNotifier instance
    """
    return SlackNotifier(webhook_url=webhook_url, frontend_url=frontend_url, firestore_client=firestore_client)


def set_slack_webhook_secret(webhook_url: str, project_id: Optional[str] = None) -> bool:
    """Store Slack webhook URL in Google Secret Manager.
    
    Args:
        webhook_url: The Slack webhook URL to store
        project_id: GCP project ID (defaults to env var)
        
    Returns:
        True if successful, False otherwise
    """
    try:
        from google.cloud import secretmanager
        
        project = project_id or os.getenv("GCP_PROJECT_ID") or os.getenv("GOOGLE_CLOUD_PROJECT")
        if not project:
            logger.error("No GCP project ID found")
            return False

        client = secretmanager.SecretManagerServiceClient()
        parent = f"projects/{project}"
        secret_id = "slack-webhook-url"
        secret_name = f"{parent}/secrets/{secret_id}"

        # Check if secret exists
        try:
            client.get_secret(request={"name": secret_name})
            secret_exists = True
        except Exception:
            secret_exists = False

        # Create secret if it doesn't exist
        if not secret_exists:
            client.create_secret(
                request={
                    "parent": parent,
                    "secret_id": secret_id,
                    "secret": {"replication": {"automatic": {}}},
                }
            )
            logger.info(f"Created secret {secret_id}")

        # Add new version with the webhook URL
        client.add_secret_version(
            request={
                "parent": secret_name,
                "payload": {"data": webhook_url.encode("UTF-8")},
            }
        )
        
        logger.info("Slack webhook URL saved to Secret Manager")
        return True

    except ImportError:
        logger.error("google-cloud-secret-manager not installed")
        return False
    except Exception as e:
        logger.error(f"Failed to save Slack webhook to Secret Manager: {e}", exc_info=True)
        return False


def get_slack_webhook_status(project_id: Optional[str] = None) -> Dict[str, Any]:
    """Get the status of Slack webhook configuration.
    
    Returns:
        Dictionary with 'configured' (bool) and optionally 'masked_url' (str)
    """
    # Check environment variable first
    env_webhook = os.getenv("SLACK_WEBHOOK_URL")
    if env_webhook:
        return {
            "configured": True,
            "source": "environment",
            "masked_url": _mask_url(env_webhook),
        }

    # Check Secret Manager
    try:
        from google.cloud import secretmanager
        
        project = project_id or os.getenv("GCP_PROJECT_ID") or os.getenv("GOOGLE_CLOUD_PROJECT")
        if not project:
            return {"configured": False, "source": None}

        client = secretmanager.SecretManagerServiceClient()
        secret_name = f"projects/{project}/secrets/slack-webhook-url/versions/latest"

        try:
            response = client.access_secret_version(request={"name": secret_name})
            webhook_url = response.payload.data.decode("UTF-8")
            return {
                "configured": True,
                "source": "secret_manager",
                "masked_url": _mask_url(webhook_url),
            }
        except Exception:
            return {"configured": False, "source": None}

    except ImportError:
        return {"configured": False, "source": None, "error": "secret_manager_not_available"}
    except Exception as e:
        return {"configured": False, "source": None, "error": str(e)}


def _mask_url(url: str) -> str:
    """Mask a URL for display, showing only the first and last few characters."""
    if not url:
        return ""
    if len(url) <= 20:
        return "*" * len(url)
    return f"{url[:20]}...{url[-8:]}"
