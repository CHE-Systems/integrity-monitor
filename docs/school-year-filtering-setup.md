# School Year Filtering Setup Guide

## Overview

The CHE Data Integrity Monitor now includes centralized school year filtering to automatically exclude outdated records from scans. This system:

- Fetches current and upcoming school years from an external API (toolkit.che.systems)
- Automatically determines which years are active based on transition periods
- Applies filtering transparently at the Airtable fetch layer
- Caches results in Firestore to minimize API calls

## Architecture

### Components

1. **SchoolYearService** (`backend/services/school_year_service.py`)
   - Fetches school year data from external API
   - Determines active years based on date
   - Manages Firestore cache (24-hour TTL)

2. **Configuration** (`backend/config/rules.yaml`)
   - Transition period dates (Feb 1 - Aug 5)
   - Per-entity field mappings with filter types

3. **Automatic Filtering** (`backend/fetchers/base.py`)
   - BaseFetcher applies filters transparently
   - No code changes needed for individual fetchers

### Transition Logic

**February 1 - August 5 (Transition Period)**
- Both current and upcoming school years are active
- Example: On March 15, 2026 → Fetch "2025-2026" OR "2026-2027" records

**August 6 - January 31 (Regular Period)**
- Only current school year is active
- Example: On September 10, 2025 → Fetch only "2025-2026" records

### Filter Types by Entity

| Entity | Field Name | Filter Type | Example Formula |
|--------|-----------|-------------|-----------------|
| students | "School Year Text" | exact | `{School Year Text}='2025-2026'` |
| parents | "School Year (from Student) text" | contains | `FIND('2025-2026', {School Year (from Student) text})` |
| contractors | "School Year (from Micro-Campus Data) text" | contains | `FIND('2025-2026', {School Year (from Micro-Campus Data) text})` |
| absent | "School Year (from Truth) (from Student) text" | contains | `FIND('2025-2026', {School Year (from Truth) (from Student) text})` |
| student_truth | "School Year" | exact | `{School Year}='2025-2026'` |
| classes | "School Year text" | exact | `{School Year text}='2025-2026'` |

**During Transition (e.g., March 2026):**
```
OR({School Year Text}='2025-2026', {School Year Text}='2026-2027')
```

## Setup Instructions

### 1. Create Google Cloud Secret

The system needs a `TOOLKIT_API_KEY` secret to access the external school year API:

```bash
# Create the secret in Google Cloud Secret Manager
gcloud secrets create TOOLKIT_API_KEY \
  --project=data-integrity-monitor \
  --replication-policy="automatic"

# Add the secret value
echo -n "YOUR_API_KEY_HERE" | gcloud secrets versions add TOOLKIT_API_KEY \
  --project=data-integrity-monitor \
  --data-file=-
```

**Replace `YOUR_API_KEY_HERE` with the actual API key for toolkit.che.systems.**

### 2. Grant Access to Service Account

For local development (using Application Default Credentials):

```bash
# Get your current user email
gcloud config get-value account

# Grant access to the secret
gcloud secrets add-iam-policy-binding TOOLKIT_API_KEY \
  --project=data-integrity-monitor \
  --member="user:YOUR_EMAIL@che.school" \
  --role="roles/secretmanager.secretAccessor"
```

For Cloud Run deployment:

```bash
# Grant access to the Cloud Run service account
gcloud secrets add-iam-policy-binding TOOLKIT_API_KEY \
  --project=data-integrity-monitor \
  --member="serviceAccount:PROJECT_NUMBER-compute@developer.gserviceaccount.com" \
  --role="roles/secretmanager.secretAccessor"
```

### 3. Verify Setup

Test that the secret can be accessed:

```bash
# Using gcloud
gcloud secrets versions access latest \
  --secret=TOOLKIT_API_KEY \
  --project=data-integrity-monitor

# Should output your API key
```

### 4. Test Locally

Start the backend and verify the school year service initializes:

```bash
cd backend
source .venv/bin/activate
PYTHONPATH=.. uvicorn backend.main:app --reload
```

Look for log messages like:
```
INFO - Initialized SchoolYearService for automatic school year filtering
```

### 5. Test API Endpoints

Once the backend is running, test the endpoints:

```bash
# Get current active school years
curl -H "Authorization: Bearer YOUR_FIREBASE_TOKEN" \
  http://localhost:8000/admin/school-years/current

# Response example:
{
  "active_years": ["2025-2026"],
  "current_year": "2025-2026",
  "upcoming_year": "2026-2027",
  "cached_at": "2026-01-07T20:30:07.164716+00:00",
  "in_transition_period": false,
  "field_mappings": { ... }
}

# Force refresh from external API
curl -X POST \
  -H "Authorization: Bearer YOUR_FIREBASE_TOKEN" \
  http://localhost:8000/admin/school-years/refresh
```

### 6. Verify Filtering in Scans

Run a scan and check the backend logs for filtering messages:

```
INFO - Applying school year filter to students: ['2025-2026']
INFO - Fetching Airtable records with filter: {School Year Text}='2025-2026'
INFO - Applying school year filter to parents: ['2025-2026']
INFO - Fetching Airtable records with filter: FIND('2025-2026', {School Year (from Student) text})
```

## Troubleshooting

### Error: "TOOLKIT_API_KEY not found in environment variables or Secret Manager"

**Cause**: The secret doesn't exist or you don't have permission to access it.

**Solutions**:
1. Verify the secret exists: `gcloud secrets list --project=data-integrity-monitor`
2. Check permissions: `gcloud secrets get-iam-policy TOOLKIT_API_KEY --project=data-integrity-monitor`
3. Ensure you're authenticated: `gcloud auth application-default login`

### Error: "Failed to fetch school year data from external API"

**Cause**: Invalid API key or network connectivity issues.

**Solutions**:
1. Verify API key is correct: `gcloud secrets versions access latest --secret=TOOLKIT_API_KEY`
2. Test API manually:
   ```bash
   curl -H "X-API-Key: YOUR_API_KEY" \
     https://toolkit.che.systems/api/secrets/yG1S06mVruhx933WDo8r
   ```
3. Check network connectivity to toolkit.che.systems

### No Filtering Applied

**Cause**: SchoolYearService failed to initialize.

**Solutions**:
1. Check backend logs for initialization errors
2. Verify `backend/config/rules.yaml` has `school_year` section
3. Ensure field names match your Airtable schema

## Configuration

### Updating Field Names

If Airtable field names change, update `backend/config/rules.yaml`:

```yaml
school_year:
  field_mappings:
    students:
      field_name: "School Year Text"  # Update this
      filter_type: "exact"
```

### Adjusting Transition Period

To change when the transition period occurs, update `backend/config/rules.yaml`:

```yaml
school_year:
  transition_start_month: 2  # February
  transition_start_day: 1
  transition_end_month: 8    # August
  transition_end_day: 5
```

### Changing Cache Duration

To adjust how long school year data is cached:

```yaml
school_year:
  cache_ttl_hours: 24  # Cache for 24 hours
```

## External API Details

The system fetches school year data from two endpoints:

**Current Year:**
- URL: `https://toolkit.che.systems/api/secrets/yG1S06mVruhx933WDo8r`
- Header: `X-API-Key: TOOLKIT_API_KEY`
- Response: `{"id": "...", "name": "CURRENT_SCHOOL_YEAR", "value": "2025-2026", ...}`

**Upcoming Year:**
- URL: `https://toolkit.che.systems/api/secrets/saysaEJZt2ywx9Gh5HeX`
- Header: `X-API-Key: TOOLKIT_API_KEY`
- Response: `{"id": "...", "name": "UPCOMING_SCHOOL_YEAR", "value": "2026-2027", ...}`

## Monitoring

### Check Active School Years

The active school years are logged on every scan:

```
INFO - Applying school year filter to students: ['2025-2026', '2026-2027']
```

### Check Cache Status

Use the API endpoint to see cache details:

```bash
curl -H "Authorization: Bearer TOKEN" \
  http://localhost:8000/admin/school-years/current
```

Includes `cached_at` timestamp and `in_transition_period` flag.

### Manual Refresh

Force a refresh from the external API:

```bash
curl -X POST \
  -H "Authorization: Bearer TOKEN" \
  http://localhost:8000/admin/school-years/refresh
```

## Production Deployment

### Cloud Run Environment

The secret will be automatically available via Google Cloud Secret Manager. No additional configuration needed if:

1. Secret `TOOLKIT_API_KEY` exists in the project
2. Cloud Run service account has `secretmanager.secretAccessor` role
3. Secret is mounted as environment variable or accessed via Secret Manager API

### Verifying in Production

After deployment:

1. Check Cloud Run logs for initialization message
2. Test the `/admin/school-years/current` endpoint
3. Verify filtering is applied by checking record counts in scan results

## Future Enhancements

Potential improvements for the school year filtering system:

1. **Frontend UI** - Add a dashboard widget to display active school years and manual refresh button
2. **Notifications** - Alert when transition period starts/ends
3. **Override Capability** - Admin ability to manually set active years (bypass external API)
4. **Audit Trail** - Log when school years change and what records were affected
5. **Year-specific Rules** - Different validation rules for different school years
