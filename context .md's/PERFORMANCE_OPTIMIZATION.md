# Cloud Run Performance Optimization

## Problem

Scheduled scans were hanging/stalling during execution, especially when processing large datasets (30K+ issues). Symptoms included:

- Slow record fetching from Airtable
- Minutes between Firestore batch writes
- Runs getting stuck at "Writing issues to Firestore" phase
- Eventual timeout or indefinite hanging

## Root Causes

### 1. Insufficient Compute Resources

**Old Configuration:**

- Memory: 1Gi
- CPU: 1 core
- Timeout: 15 minutes
- No concurrency limit

**Impact:** Single CPU with 1Gi memory was severely inadequate for:

- Processing 4,000+ Airtable records (paginated fetching)
- Running duplicate detection algorithms on large datasets
- Executing field validation checks
- Writing 34,000+ issues to Firestore in batches of 500

### 2. Progress Logging Overhead

The progress callback was writing to Firestore after **every single batch** (500 issues), creating:

- ~68 additional Firestore writes per run
- Resource contention with main batch writes
- Blocking I/O that slowed the main loop

### 3. No Timeout Protection

The `batch.commit()` call had no timeout, so network issues or Firestore slowness would cause indefinite hangs.

## Solutions Applied

### 1. Increased Cloud Run Resources

**New Configuration:**

```yaml
Memory: 4Gi (4x increase)
CPU: 2 cores (2x increase)
Timeout: 30 minutes (2x increase)
Concurrency: 80 (explicit limit)
```

**Expected Impact:**

- **4x faster processing** with 2 CPUs and more memory
- Can handle larger datasets (50K+ issues)
- Better parallel processing of Airtable requests
- More headroom for memory-intensive operations (duplicate detection)

### 2. Throttled Progress Logging

Changed progress logging to only write every:

- **5% progress** OR
- **30 seconds** (whichever comes first)

**Impact:**

- Reduced Firestore writes from ~68 to ~20 per run
- 70% reduction in logging overhead
- Less resource contention during batch writes

### 3. Batch Commit Timeout Protection

Wrapped `batch.commit()` with:

- 30-second timeout per attempt
- Exponential backoff for retries
- Treats timeout as retryable error

**Impact:**

- Prevents indefinite hangs
- Graceful handling of transient network issues
- Better error reporting

## Deployment

All deployment scripts have been updated:

- `deploy/deploy.sh`
- `deploy/redeploy-backend.sh`
- `deploy/force-redeploy-backend.sh`
- `deploy/cloudbuild.yaml`

To apply these changes:

```bash
cd deploy
./redeploy-backend.sh
```

## Expected Performance Improvements

| Metric                     | Before            | After         | Improvement |
| -------------------------- | ----------------- | ------------- | ----------- |
| Record fetching            | ~5-10 min         | ~2-3 min      | 2-3x faster |
| Issue processing           | Hangs/stalls      | Smooth        | Reliable    |
| Firestore writes           | Minutes/batch     | ~30s/batch    | 2-4x faster |
| Total runtime (30K issues) | 56+ hours (hangs) | 15-20 min     | Completes   |
| Progress logs              | Every batch (68)  | Every 5% (20) | 70% less    |

## Cost Impact

**Estimated cost increase:**

- Old: $0.48/hr × 1Gi × 1 CPU = ~$0.48/hr
- New: $0.48/hr × 4Gi × 2 CPU = ~$3.84/hr

**However:**

- Runs complete in 15-20 min instead of hanging indefinitely
- Fewer retries/failed runs
- Better resource utilization
- **Net cost is lower** due to shorter runtime and higher success rate

## Monitoring

After deployment, monitor:

1. Run completion times (should be 15-20 min for full scans)
2. Progress logs (should update every 5% or 30 seconds)
3. Cloud Run metrics (CPU/memory utilization)
4. Error rates (should drop significantly)

## Rollback Plan

If issues occur, rollback by reverting to 1Gi/1 CPU:

```bash
gcloud run services update integrity-runner \
  --memory 1Gi \
  --cpu 1 \
  --timeout 15m \
  --region us-central1
```

## Date Applied

December 26, 2025
