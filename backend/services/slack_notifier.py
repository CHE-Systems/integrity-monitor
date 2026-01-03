"""Slack notification service for sending scan alerts.

Sends formatted Slack messages when scans complete with issues or errors.
"""

import logging
import os
from typing import Any, Dict, Optional
import json

logger = logging.getLogger(__name__)


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
                logger.debug("No GCP project ID found, cannot access Secret Manager")
                return None

            secret_name = f"projects/{project_id}/secrets/slack-webhook-url/versions/latest"
            
            try:
                response = client.access_secret_version(request={"name": secret_name})
                self._cached_secret_webhook = response.payload.data.decode("UTF-8")
                return self._cached_secret_webhook
            except Exception as e:
                # Secret doesn't exist or access denied - this is expected if not configured
                logger.debug(f"Could not access Slack webhook secret: {e}")
                return None

        except ImportError:
            logger.debug("google-cloud-secret-manager not installed")
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
    ) -> Dict[str, Any]:
        """Build Slack message payload.
        
        Args:
            run_id: The integrity run ID
            status: Final status (healthy, warning, critical, error, timeout)
            issue_counts: Dictionary of issue type -> count
            trigger: What triggered the scan (manual, schedule, nightly)
            duration_ms: Run duration in milliseconds
            error_message: Error message if status is error/timeout
            
        Returns:
            Slack message payload dict
        """
        emoji = self._get_status_emoji(status)
        color = self._get_status_color(status)
        
        # Build header
        header_text = f"{emoji} Data Integrity Scan Complete"
        
        # Build status line
        status_display = status.title()
        
        # Build issue summary
        issue_lines = []
        total_issues = 0
        
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
            "attendance": "Attendance",
        }
        
        # Aggregate counts by display name
        aggregated: Dict[str, int] = {}
        for key, count in issue_counts.items():
            if count > 0:
                # Handle keys like "duplicate:high", "link:medium", etc.
                base_key = key.split(":")[0].lower()
                display_name = display_names.get(base_key, base_key.replace("_", " ").title())
                aggregated[display_name] = aggregated.get(display_name, 0) + count
                total_issues += count

        for display_name, count in sorted(aggregated.items()):
            issue_lines.append(f"• {display_name}: {count}")

        # Build fields
        fields = [
            {
                "title": "Status",
                "value": f"{emoji} {status_display}",
                "short": True,
            },
            {
                "title": "Trigger",
                "value": trigger.title(),
                "short": True,
            },
        ]
        
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

        if total_issues > 0:
            fields.append({
                "title": "Total Issues",
                "value": str(total_issues),
                "short": True,
            })

        # Build message text
        text_parts = []
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
            run_url = f"{base_url}/runs/{run_id}"

        # Build actions/footer
        footer_text = f"Run ID: {run_id[:8]}..."
        
        # Construct message
        attachment = {
            "color": color,
            "fields": fields,
            "footer": footer_text,
            "ts": int(__import__("time").time()),
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
    ) -> bool:
        """Send a Slack notification for a completed scan.
        
        Args:
            run_id: The integrity run ID
            status: Final status (healthy, warning, critical, error, timeout)
            issue_counts: Dictionary of issue type -> count
            trigger: What triggered the scan (manual, schedule, nightly)
            duration_ms: Run duration in milliseconds
            error_message: Error message if status is error/timeout
            
        Returns:
            True if notification was sent successfully, False otherwise
        """
        # Check if we should notify for this status
        if not self.should_notify(status):
            logger.info(
                f"Skipping Slack notification for status '{status}' (only warning/critical/error/timeout trigger notifications)",
                extra={"run_id": run_id, "status": status},
            )
            return False

        webhook_url = self._get_webhook_url()
        if not webhook_url:
            logger.warning(
                "Slack webhook URL not configured, skipping notification",
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
            )

            data = json.dumps(message).encode("utf-8")
            req = urllib.request.Request(
                webhook_url,
                data=data,
                headers={"Content-Type": "application/json"},
                method="POST",
            )

            with urllib.request.urlopen(req, timeout=10) as response:
                if response.status == 200:
                    logger.info(
                        "Slack notification sent successfully",
                        extra={"run_id": run_id, "status": status},
                    )
                    return True
                else:
                    logger.warning(
                        f"Slack API returned non-200 status: {response.status}",
                        extra={"run_id": run_id, "status": status},
                    )
                    return False

        except urllib.error.URLError as e:
            logger.error(
                f"Failed to send Slack notification: {e}",
                extra={"run_id": run_id, "status": status},
                exc_info=True,
            )
            return False
        except Exception as e:
            logger.error(
                f"Unexpected error sending Slack notification: {e}",
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
