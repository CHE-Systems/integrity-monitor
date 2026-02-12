"""Integration tests for IntegrityRunner with mocked clients."""

from unittest.mock import Mock, patch, MagicMock
import pytest
from datetime import datetime, timezone

from backend.services.integrity_runner import IntegrityRunner
from backend.config.settings import RuntimeConfig, AirtableConfig, FirestoreConfig
from backend.config.models import SchemaConfig


@pytest.fixture
def mock_airtable_client():
    """Create a mocked Airtable client."""
    client = Mock()
    client.fetch_records = Mock(return_value=[])
    return client


@pytest.fixture
def mock_firestore_client():
    """Create a mocked Firestore client."""
    client = Mock()
    client.record_run = Mock()
    client.record_metrics = Mock()
    client.record_issues = Mock()
    client.get_last_successful_run_timestamp = Mock(return_value=None)
    return client


@pytest.fixture
def mock_runtime_config():
    """Create a minimal runtime config for testing."""
    return RuntimeConfig(
        airtable=AirtableConfig(
            students={"base_env": "AT_STUDENTS_BASE", "table_env": "AT_STUDENTS_TABLE"},
            parents={"base_env": "AT_PARENTS_BASE", "table_env": "AT_PARENTS_TABLE"},
            contractors={"base_env": "AT_CONTRACTORS_BASE", "table_env": "AT_CONTRACTORS_TABLE"},
            classes={"base_env": "AT_CLASSES_BASE", "table_env": "AT_CLASSES_TABLE"},
            attendance={"base_env": "AT_ATTENDANCE_BASE", "table_env": "AT_ATTENDANCE_TABLE"},
            truth={"base_env": "AT_TRUTH_BASE", "table_env": "AT_TRUTH_TABLE"},
            payments={"base_env": "AT_PAYMENTS_BASE", "table_env": "AT_PAYMENTS_TABLE"},
        ),
        firestore=FirestoreConfig(
            runs_collection="test_runs",
            metrics_collection="test_metrics",
            issues_collection="test_issues",
            config_document="test_config",
        ),
        run_config={
            "nightly_cron": "0 2 * * *",
            "weekly_cron": "0 3 * * 0",
            "alert_thresholds": {
                "max_run_minutes": 30,
                "duplicate_warning_count": 500
            }
        },
        attendance_rules={
            "onboarding_grace_days": 7,
            "limited_schedule_threshold": 3,
            "thresholds": {
                "attendance_rate": {"warning": 0.8, "critical": 0.7}
            }
        },
        metadata={},
    )


@patch("backend.services.integrity_runner.AirtableClient")
@patch("backend.services.integrity_runner.FirestoreClient")
@patch("backend.services.integrity_runner.load_runtime_config")
@patch("backend.services.integrity_runner.load_schema_config")
def test_integrity_runner_full_flow(
    mock_load_schema,
    mock_load_runtime,
    mock_firestore_class,
    mock_airtable_class,
    sample_records,
    mock_runtime_config,
):
    """Test full integrity runner flow with mocked clients."""
    # Setup mocks
    mock_airtable_instance = Mock()
    mock_airtable_instance.fetch_records = Mock(side_effect=lambda key, *args, **kwargs: sample_records.get(key, []))
    mock_airtable_class.return_value = mock_airtable_instance
    
    mock_firestore_instance = Mock()
    mock_firestore_instance.record_run = Mock()
    mock_firestore_instance.record_metrics = Mock()
    mock_firestore_instance.record_issues = Mock()
    mock_firestore_instance.get_last_successful_run_timestamp = Mock(return_value=None)
    mock_firestore_class.return_value = mock_firestore_instance
    
    mock_load_runtime.return_value = mock_runtime_config
    mock_load_schema.return_value = SchemaConfig(
        entities={},
        duplicates={},
        metadata={"source": "test", "generated": "now"}
    )
    
    # Create runner
    runner = IntegrityRunner(runtime_config=mock_runtime_config)
    runner._airtable_client = mock_airtable_instance
    runner._firestore_client = mock_firestore_instance
    
    # Run integrity check
    result = runner.run(mode="full", trigger="test")
    
    # Verify results
    assert result["status"] in ["success", "warning"]
    assert "run_id" in result
    assert "entity_counts" in result
    
    # Verify Firestore writes were called
    assert mock_firestore_instance.record_run.call_count >= 2
    mock_firestore_instance.record_issues.assert_called()


@patch("backend.services.integrity_runner.AirtableClient")
@patch("backend.services.integrity_runner.FirestoreClient")
def test_integrity_runner_fetch_error(mock_firestore_class, mock_airtable_class, mock_runtime_config):
    """Test runner handles fetch errors gracefully."""
    mock_airtable_instance = Mock()
    mock_airtable_instance.fetch_records = Mock(side_effect=Exception("Fetch failed"))
    mock_airtable_class.return_value = mock_airtable_instance
    
    mock_firestore_instance = Mock()
    mock_firestore_instance.record_run = Mock()
    mock_firestore_class.return_value = mock_firestore_instance
    
    runner = IntegrityRunner(runtime_config=mock_runtime_config)
    runner._airtable_client = mock_airtable_instance
    runner._firestore_client = mock_firestore_instance
    
    result = runner.run(mode="full", trigger="test")
    
    # Should record error status
    assert result["status"] == "error"
    # Called at start and at error
    assert mock_firestore_instance.record_run.call_count >= 1


@patch("backend.services.integrity_runner.AirtableClient")
@patch("backend.services.integrity_runner.FirestoreClient")
def test_integrity_runner_write_error(mock_firestore_class, mock_airtable_class, sample_records, mock_runtime_config):
    """Test runner handles write errors gracefully."""
    mock_airtable_instance = Mock()
    mock_airtable_instance.fetch_records = Mock(side_effect=lambda key, *args, **kwargs: sample_records.get(key, []))
    mock_airtable_class.return_value = mock_airtable_instance
    
    mock_firestore_instance = Mock()
    mock_firestore_instance.record_run = Mock(side_effect=Exception("Write failed"))
    mock_firestore_instance.record_issues = Mock()
    mock_firestore_class.return_value = mock_firestore_instance
    
    runner = IntegrityRunner(runtime_config=mock_runtime_config)
    runner._airtable_client = mock_airtable_instance
    runner._firestore_client = mock_firestore_instance
    
    result = runner.run(mode="full", trigger="test")
    
    # Should complete with success status (firestore write failure doesn't fail the run)
    assert result["status"] == "success"
