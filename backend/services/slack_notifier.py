"""Slack notification service for sending scan alerts.

Sends formatted Slack messages when scans complete with issues or errors.
"""

import os
import time
from typing import Any, Dict, Optional
import json

from ..clients.logging import get_logger

logger = get_logger(__name__)


class SlackNotifier:
    """Send notifications to Slack via webhook."""

    def __init__(
        self,
        webhook_url: Optional[str] = None,
        frontend_url: Optional[str] = None,
    ):
        """Initialize SlackNotifier.
        
        Args:
            webhook_url: Slack webhook URL. If not provided, attempts to read from
                        environment variable SLACK_WEBHOOK_URL or Secret Manager.
            frontend_url: Base URL for the frontend app (for generating links).
                         If not provided, reads from FRONTEND_URL env var.
        """
        self._webhook_url = webhook_url
        self._frontend_url = frontend_url or os.getenv("FRONTEND_URL", "")
        self._cached_secret_webhook: Optional[str] = None

    def _get_webhook_url(self) -> Optional[str]:
        """Get webhook URL from configured source.

        Priority:
        1. Direct configuration (self._webhook_url)
        2. Environment variable (SLACK_WEBHOOK_URL)
        3. Google Secret Manager (slack-webhook-url)
        """
        # #region agent log
        debug_log_path = '/Users/joshuaedwards/Library/CloudStorage/GoogleDrive-jedwards@che.school/My Drive/CHE/che-data-integrity-monitor/.cursor/debug.log'
        try:
            import json as _json
            import time
            with open(debug_log_path, 'a') as f:
                f.write(_json.dumps({"sessionId":"debug-session","runId":"webhook-check","hypothesisId":"C","location":"slack_notifier.py:35","message":"_get_webhook_url entry","data":{"has_direct_config":self._webhook_url is not None},"timestamp":int(time.time()*1000)})+'\n')
        except: pass
        # #endregion agent log
        print("[SLACK DEBUG] _get_webhook_url: Checking webhook sources...")
        logger.info("[SLACK DEBUG] _get_webhook_url: Checking webhook sources...")

        if self._webhook_url:
            print("[SLACK DEBUG] _get_webhook_url: Found direct config webhook URL")
            logger.info("[SLACK DEBUG] _get_webhook_url: Found direct config webhook URL")
            # #region agent log
            try:
                with open(debug_log_path, 'a') as f:
                    f.write(_json.dumps({"sessionId":"debug-session","runId":"webhook-check","hypothesisId":"C","location":"slack_notifier.py:47","message":"Found direct config webhook","data":{},"timestamp":int(time.time()*1000)})+'\n')
            except: pass
            # #endregion agent log
            return self._webhook_url

        # Try environment variable
        env_webhook = os.getenv("SLACK_WEBHOOK_URL")
        if env_webhook:
            print("[SLACK DEBUG] _get_webhook_url: Found SLACK_WEBHOOK_URL env var")
            logger.info("[SLACK DEBUG] _get_webhook_url: Found SLACK_WEBHOOK_URL env var")
            # #region agent log
            try:
                with open(debug_log_path, 'a') as f:
                    f.write(_json.dumps({"sessionId":"debug-session","runId":"webhook-check","hypothesisId":"C","location":"slack_notifier.py:53","message":"Found SLACK_WEBHOOK_URL env var","data":{},"timestamp":int(time.time()*1000)})+'\n')
            except: pass
            # #endregion agent log
            return env_webhook

        print("[SLACK DEBUG] _get_webhook_url: No env var, checking Secret Manager...")
        logger.info("[SLACK DEBUG] _get_webhook_url: No env var, checking Secret Manager...")

        # Try Google Secret Manager
        if self._cached_secret_webhook:
            print("[SLACK DEBUG] _get_webhook_url: Using cached Secret Manager webhook")
            logger.info("[SLACK DEBUG] _get_webhook_url: Using cached Secret Manager webhook")
            # #region agent log
            try:
                with open(debug_log_path, 'a') as f:
                    f.write(_json.dumps({"sessionId":"debug-session","runId":"webhook-check","hypothesisId":"C","location":"slack_notifier.py:60","message":"Using cached Secret Manager webhook","data":{},"timestamp":int(time.time()*1000)})+'\n')
            except: pass
            # #endregion agent log
            return self._cached_secret_webhook

        try:
            from google.cloud import secretmanager

            client = secretmanager.SecretManagerServiceClient()
            project_id = os.getenv("GCP_PROJECT_ID") or os.getenv("GOOGLE_CLOUD_PROJECT")

            print(f"[SLACK DEBUG] _get_webhook_url: GCP project ID = {project_id}")
            logger.info(f"[SLACK DEBUG] _get_webhook_url: GCP project ID = {project_id}")
            # #region agent log
            try:
                with open(debug_log_path, 'a') as f:
                    f.write(_json.dumps({"sessionId":"debug-session","runId":"webhook-check","hypothesisId":"D","location":"slack_notifier.py:68","message":"Checking GCP project ID","data":{"project_id":project_id},"timestamp":int(time.time()*1000)})+'\n')
            except: pass
            # #endregion agent log

            if not project_id:
                print("[SLACK DEBUG] _get_webhook_url: No GCP project ID found, cannot access Secret Manager")
                logger.warning("[SLACK DEBUG] _get_webhook_url: No GCP project ID found, cannot access Secret Manager")
                # #region agent log
                try:
                    with open(debug_log_path, 'a') as f:
                        f.write(_json.dumps({"sessionId":"debug-session","runId":"webhook-check","hypothesisId":"D","location":"slack_notifier.py:71","message":"No GCP project ID found","data":{},"timestamp":int(time.time()*1000)})+'\n')
                except: pass
                # #endregion agent log
                return None

            secret_name = f"projects/{project_id}/secrets/slack-webhook-url/versions/latest"
            print(f"[SLACK DEBUG] _get_webhook_url: Accessing secret: {secret_name}")
            logger.info(f"[SLACK DEBUG] _get_webhook_url: Accessing secret: {secret_name}")
            # #region agent log
            try:
                with open(debug_log_path, 'a') as f:
                    f.write(_json.dumps({"sessionId":"debug-session","runId":"webhook-check","hypothesisId":"C","location":"slack_notifier.py:75","message":"Attempting to access secret","data":{"secret_name":secret_name},"timestamp":int(time.time()*1000)})+'\n')
            except: pass
            # #endregion agent log

            try:
                response = client.access_secret_version(request={"name": secret_name})
                self._cached_secret_webhook = response.payload.data.decode("UTF-8")
                print("[SLACK DEBUG] _get_webhook_url: ✅ Successfully retrieved webhook from Secret Manager")
                logger.info("[SLACK DEBUG] _get_webhook_url: ✅ Successfully retrieved webhook from Secret Manager")
                # #region agent log
                try:
                    masked_url = _mask_url(self._cached_secret_webhook)
                    with open(debug_log_path, 'a') as f:
                        f.write(_json.dumps({"sessionId":"debug-session","runId":"webhook-check","hypothesisId":"C","location":"slack_notifier.py:81","message":"Successfully retrieved webhook from Secret Manager","data":{"masked_url":masked_url},"timestamp":int(time.time()*1000)})+'\n')
                except: pass
                # #endregion agent log
                return self._cached_secret_webhook
            except Exception as e:
                # Secret doesn't exist or access denied - this is expected if not configured
                print(f"[SLACK DEBUG] _get_webhook_url: Could not access Slack webhook secret: {e}")
                logger.warning(f"[SLACK DEBUG] _get_webhook_url: Could not access Slack webhook secret: {e}")
                # #region agent log
                try:
                    with open(debug_log_path, 'a') as f:
                        f.write(_json.dumps({"sessionId":"debug-session","runId":"webhook-check","hypothesisId":"C","location":"slack_notifier.py:84","message":"Could not access Slack webhook secret","data":{"error_type":type(e).__name__,"error":str(e)},"timestamp":int(time.time()*1000)})+'\n')
                except: pass
                # #endregion agent log
                return None

        except ImportError:
            print("[SLACK DEBUG] _get_webhook_url: google-cloud-secret-manager not installed")
            logger.warning("[SLACK DEBUG] _get_webhook_url: google-cloud-secret-manager not installed")
            # #region agent log
            try:
                with open(debug_log_path, 'a') as f:
                    f.write(_json.dumps({"sessionId":"debug-session","runId":"webhook-check","hypothesisId":"C","location":"slack_notifier.py:88","message":"google-cloud-secret-manager not installed","data":{},"timestamp":int(time.time()*1000)})+'\n')
            except: pass
            # #endregion agent log
            return None
        except Exception as e:
            print(f"[SLACK DEBUG] _get_webhook_url: Error accessing Secret Manager: {e}")
            logger.warning(f"[SLACK DEBUG] _get_webhook_url: Error accessing Secret Manager: {e}")
            # #region agent log
            try:
                with open(debug_log_path, 'a') as f:
                    f.write(_json.dumps({"sessionId":"debug-session","runId":"webhook-check","hypothesisId":"C","location":"slack_notifier.py:91","message":"Error accessing Secret Manager","data":{"error_type":type(e).__name__,"error":str(e)},"timestamp":int(time.time()*1000)})+'\n')
            except: pass
            # #endregion agent log
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

        Returns:
            Slack message payload dict
        """
        emoji = self._get_status_emoji(status)
        color = self._get_status_color(status)

        # Build header
        header_text = f"{emoji} Data Integrity Scan Complete"

        # Build status line
        status_display = status.title()

        # Build issue summary - only count base keys (without severity suffix)
        # to avoid double counting since issue_counts contains both
        # "duplicate": 5 AND "duplicate:high": 2, "duplicate:medium": 3
        issue_lines = []
        total_issues = 0
        critical_count = 0
        warning_count = 0

        # Map internal keys to display names
        display_names = {
            "duplicates": "Duplicates",
            "duplicate": "Duplicates",
            "relationships": "Relationships",
            "relationship": "Relationships",
            "links": "Links",
            "link": "Links",
            "required_fields": "Required Fields",
            "required_field": "Required Fields",
            "missing_key_data": "Required Fields",
            "value_checks": "Value Checks",
            "value_check": "Value Checks",
            "attendance": "Attendance",
        }

        # Only count base keys (those without ":" in them) to avoid double counting
        aggregated: Dict[str, int] = {}
        for key, count in issue_counts.items():
            if count > 0:
                if ":" in key:
                    # This is a severity-specific key like "duplicate:high"
                    # Use these for severity breakdown
                    severity = key.split(":")[1].lower()
                    if severity in ("critical", "high"):
                        critical_count += count
                    elif severity in ("warning", "medium", "low"):
                        warning_count += count
                else:
                    # This is a base key like "duplicate" - use for total count
                    base_key = key.lower()
                    display_name = display_names.get(base_key, base_key.replace("_", " ").title())
                    aggregated[display_name] = aggregated.get(display_name, 0) + count
                    total_issues += count

        for display_name, count in sorted(aggregated.items()):
            issue_lines.append(f"• {display_name}: {count}")

        # Build fields - prioritize new issues
        fields = [
            {
                "title": "Run status",
                "value": f"{emoji} {status_display}",
                "short": True,
            },
            {
                "title": "Trigger",
                "value": trigger.title(),
                "short": True,
            },
        ]

        # Note: New issues will be shown in text, not fields

        if duration_ms is not None:
            duration_secs = duration_ms / 1000
            if duration_secs >= 60:
                duration_str = f"{int(duration_secs // 60)}m {int(duration_secs % 60)}s"
            else:
                duration_str = f"{duration_secs:.1f}s"
            fields.append({
                "title": "Duration",
                "value": duration_str,
                "short": True,
            })

        # Add severity breakdown if we have issues
        if critical_count > 0 or warning_count > 0:
            severity_parts = []
            if critical_count > 0:
                severity_parts.append(f"🔴 {critical_count} Critical")
            if warning_count > 0:
                severity_parts.append(f"🟡 {warning_count} Warning")
            fields.append({
                "title": "Issue severity breakdown",
                "value": " | ".join(severity_parts),
                "short": True,
            })

        # Build message text
        text_parts = []

        # Add rules summary if available
        if run_config and run_config.get("rules"):
            rules = run_config["rules"]
            rules_lines = []

            if rules.get("duplicates"):
                dup_entities = [e for e, r in rules["duplicates"].items() if r]
                if dup_entities:
                    entities_str = ", ".join(dup_entities)
                    rules_lines.append(f"• *Duplicates:* {entities_str}")

            if rules.get("relationships"):
                rel_entities = [e for e, r in rules["relationships"].items() if r]
                if rel_entities:
                    entities_str = ", ".join(rel_entities)
                    rules_lines.append(f"• *Relationships:* {entities_str}")

            if rules.get("required_fields"):
                req_details = []
                for entity, rule_ids in rules["required_fields"].items():
                    if rule_ids:
                        # Extract field names from rule_ids
                        # Rule IDs can be: "field_name" or "required.entity.field_name"
                        field_names = []
                        for rule_id in rule_ids:
                            if rule_id.startswith("required."):
                                # Format: required.entity.field_name
                                parts = rule_id.split(".")
                                if len(parts) >= 3:
                                    field_names.append(parts[2])
                            else:
                                field_names.append(rule_id)
                        # Remove duplicates while preserving order
                        seen = set()
                        unique_fields = []
                        for f in field_names:
                            if f not in seen:
                                seen.add(f)
                                unique_fields.append(f)
                        if unique_fields:
                            fields_str = ", ".join(unique_fields)
                            req_details.append(f"{entity}: {fields_str}")
                if req_details:
                    rules_lines.append(f"• *Required Fields:*")
                    for detail in req_details:
                        rules_lines.append(f"    - {detail}")

            if rules.get("value_checks"):
                value_entities = [e for e, r in rules["value_checks"].items() if r]
                if value_entities:
                    entities_str = ", ".join(value_entities)
                    rules_lines.append(f"• *Value Checks:* {entities_str}")

            if rules.get("attendance_rules"):
                rules_lines.append("• *Attendance:* enabled")

            if rules_lines:
                text_parts.append("*Rules Checked:*")
                text_parts.extend(rules_lines)
                text_parts.append("")  # Add spacing

        # Add new issues (always show, even if 0)
        if new_issues_count is not None:
            if new_issues_count > 0:
                text_parts.append(f"*New Issues:* {new_issues_count}")
            else:
                text_parts.append("*New Issues:* No new issues found")
            text_parts.append("")  # Add spacing

        # Add total issues found
        if total_issues > 0:
            text_parts.append(f"*Total Issues Found:* {total_issues}")
            text_parts.append("")  # Add spacing

        if issue_lines:
            text_parts.append("*Issues Found:*")
            text_parts.extend(issue_lines)

        if error_message:
            text_parts.append(f"\n*Error:* {error_message}")

        # Build run details link
        run_url = None
        if self._frontend_url:
            # Remove trailing slash if present
            base_url = self._frontend_url.rstrip("/")
            run_url = f"{base_url}/run/{run_id}"

        # Build actions/footer
        footer_text = f"Run ID: {run_id[:8]}..."

        # Construct message
        attachment = {
            "color": color,
            "fields": fields,
            "footer": footer_text,
            "ts": int(time.time()),
        }

        if text_parts:
            attachment["text"] = "\n".join(text_parts)

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
        logger.info(
            f"[SLACK DEBUG] send_notification called with: run_id={run_id}, status={status}, "
            f"trigger={trigger}, duration_ms={duration_ms}, issue_counts={issue_counts}, "
            f"error_message={error_message}"
        )

        # Check if we should notify for this status
        should_notify_result = self.should_notify(status)
        print(f"[SLACK DEBUG] should_notify('{status}') = {should_notify_result} (notify statuses: warning, critical, error, timeout)")
        logger.info(
            f"[SLACK DEBUG] should_notify('{status}') = {should_notify_result} "
            f"(notify statuses: warning, critical, error, timeout)"
        )
        # #region agent log
        debug_log_path = '/Users/joshuaedwards/Library/CloudStorage/GoogleDrive-jedwards@che.school/My Drive/CHE/che-data-integrity-monitor/.cursor/debug.log'
        try:
            import json as _json
            import time
            with open(debug_log_path, 'a') as f:
                f.write(_json.dumps({"sessionId":"debug-session","runId":run_id,"hypothesisId":"E","location":"slack_notifier.py:308","message":"should_notify check","data":{"status":status,"should_notify":should_notify_result},"timestamp":int(time.time()*1000)})+'\n')
        except: pass
        # #endregion agent log

        if not should_notify_result:
            print(f"[SLACK DEBUG] Skipping notification - status '{status}' not in notify list")
            logger.info(
                f"[SLACK DEBUG] Skipping notification - status '{status}' not in notify list",
                extra={"run_id": run_id, "status": status},
            )
            # #region agent log
            try:
                with open(debug_log_path, 'a') as f:
                    f.write(_json.dumps({"sessionId":"debug-session","runId":run_id,"hypothesisId":"E","location":"slack_notifier.py:315","message":"Skipping notification - status not in notify list","data":{"status":status},"timestamp":int(time.time()*1000)})+'\n')
            except: pass
            # #endregion agent log
            return False

        print("[SLACK DEBUG] Attempting to get webhook URL...")
        logger.info("[SLACK DEBUG] Attempting to get webhook URL...")
        webhook_url = self._get_webhook_url()

        if not webhook_url:
            print("[SLACK DEBUG] Slack webhook URL not configured! Checked: 1) direct config, 2) SLACK_WEBHOOK_URL env var, 3) Secret Manager 'slack-webhook-url'")
            logger.warning(
                "[SLACK DEBUG] Slack webhook URL not configured! Checked: "
                "1) direct config, 2) SLACK_WEBHOOK_URL env var, 3) Secret Manager 'slack-webhook-url'",
                extra={"run_id": run_id},
            )
            # #region agent log
            try:
                with open(debug_log_path, 'a') as f:
                    f.write(_json.dumps({"sessionId":"debug-session","runId":run_id,"hypothesisId":"C","location":"slack_notifier.py:324","message":"Webhook URL not configured","data":{},"timestamp":int(time.time()*1000)})+'\n')
            except: pass
            # #endregion agent log
            return False

        # Log masked webhook URL for debugging
        masked_url = _mask_url(webhook_url)
        logger.info(f"[SLACK DEBUG] Webhook URL found: {masked_url}")

        try:
            import urllib.request
            import urllib.error

            logger.info("[SLACK DEBUG] Building Slack message payload...")
            message = self._build_message(
                run_id=run_id,
                status=status,
                issue_counts=issue_counts,
                trigger=trigger,
                duration_ms=duration_ms,
                error_message=error_message,
                run_config=run_config,
                new_issues_count=new_issues_count,
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
) -> SlackNotifier:
    """Factory function to create a SlackNotifier instance.
    
    Args:
        webhook_url: Optional webhook URL override
        frontend_url: Optional frontend URL override
        
    Returns:
        Configured SlackNotifier instance
    """
    return SlackNotifier(webhook_url=webhook_url, frontend_url=frontend_url)


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
