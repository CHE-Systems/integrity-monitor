# Cloud Run Performance Fix: Background Thread CPU Throttling

## The Problem

Integrity scans deployed to Google Cloud Run were taking 15+ minutes and frequently timing out, despite the same scans completing in under 5 minutes locally. The dataset is small (under 10k total records across 6 Airtable tables), so data volume was not the issue. The scan appeared to run at an extremely slow processing speed on Cloud Run — it wasn't stuck on any specific phase, everything was just slow. Fetching records that should take seconds per page would take minutes. Most scans never completed.

### Symptoms

- Scans complete in 3-5 minutes locally, but take 15+ minutes on Cloud Run (or never finish)
- No specific phase is the bottleneck — all operations (Airtable fetching, Firestore writes, data processing) are uniformly slow
- The scan usually fails/times out before completing all record fetches
- Small dataset (under 10k records total) — this is not a data volume problem
- Increasing memory, CPU, or timeout had no meaningful effect

## Root Cause: Cloud Run CPU Throttling on Background Threads

Cloud Run has a default behavior where **CPU is throttled to near-zero when no HTTP request is actively being processed**. This is the key architectural mismatch:

### How the scan works:

1. `POST /integrity/run` receives the request
2. A background thread is spawned via `threading.Thread(target=_run_integrity_background, daemon=True)`
3. The endpoint **immediately returns HTTP 202** with `{"status": "running", "run_id": "..."}`
4. The background thread does all the actual work (fetching from Airtable, running checks, writing to Firestore)

### What Cloud Run does:

Once the HTTP 202 response is sent, Cloud Run considers the request **complete**. With the default CPU allocation setting, it throttles CPU allocation to near-zero. The background thread is still alive and running, but it has almost no CPU available to:

- Parse JSON responses from Airtable
- Process and transform records
- Execute integrity check logic
- Serialize data for Firestore writes

Network I/O (HTTP requests to Airtable, Firestore API calls) still completes, but any CPU work between I/O operations crawls to a near halt. This is why everything appears uniformly slow rather than stuck on one specific operation.

### Why it works locally:

Your local machine doesn't throttle CPU. The background thread gets full access to your CPU cores, so everything runs at normal speed.

## The Fix

Add `--no-cpu-throttling` to the `gcloud run deploy` command:

```bash
gcloud run deploy integrity-runner \
  --no-cpu-throttling \
  # ... other flags
```

This single flag tells Cloud Run: **keep CPU allocated even when no HTTP request is being processed**. This is specifically designed for services that do background work after responding to requests.

### Result

Scans went from 15+ minutes (usually timing out) to **under 30 seconds** after adding this flag. No code changes were needed.

## What Was Tried Before (And Why It Didn't Work)

These optimizations were all implemented over time but none addressed the root cause:

### 1. Parallel fetching with ThreadPoolExecutor (didn't help)
Fetching entities in parallel (`max_workers=4`) is a good optimization, but when CPU is throttled, parallel threads all compete for near-zero CPU. More threads didn't help because CPU was the bottleneck, not I/O concurrency.

### 2. AsyncLogBuffer for non-blocking Firestore writes (didn't help)
Buffering Firestore log writes to avoid blocking the fetch thread is sensible, but the real bottleneck was CPU throttling, not synchronous Firestore calls.

### 3. Airtable rate limiting tuning (didn't help)
The `MIN_REQUEST_INTERVAL` (0.05s / 20 req/s) was already reasonable. The slowness wasn't caused by rate limiting — it was CPU starvation between requests.

### 4. Increased memory (4GB) and CPU (2 vCPU) (didn't help)
More resources don't help when Cloud Run throttles CPU to near-zero. You can allocate 8 vCPUs, but if the CPU throttling policy is active, your background thread still gets nothing.

### 5. Socket timeout configuration (didn't help)
Setting `REQUEST_TIMEOUT_SECONDS = 300` (5 minutes) prevents hanging on network issues, but the problem wasn't network timeouts — it was CPU starvation making everything slow.

### 6. Retry logic with exponential backoff (didn't help)
The `tenacity` retry configuration handles transient Airtable errors well, but retrying doesn't fix slow processing when the CPU is throttled.

### 7. Progress logging and timing instrumentation (didn't help)
Extensive `[TIMING]` logs were added throughout the codebase to diagnose where time was being spent. These showed that everything was uniformly slow, which is the signature of CPU throttling — not a specific bottleneck.

## Key Takeaway

**If you are running background work on Cloud Run after returning an HTTP response, you MUST use `--no-cpu-throttling`.** This is not an edge case — it's a fundamental architectural requirement for the fire-and-forget pattern (return 202, process in background).

Without this flag, Cloud Run's default behavior will starve your background threads of CPU, making them run 10-100x slower than expected. No amount of code optimization, parallelization, or resource scaling will fix this because the problem is at the infrastructure level, not the application level.

### Cloud Run deploy flags for this pattern:

```bash
gcloud run deploy SERVICE_NAME \
  --no-cpu-throttling \  # CRITICAL: keeps CPU alive for background threads
  --memory 2Gi \
  --cpu 2 \
  --timeout 30m \
  --concurrency 5 \      # Low concurrency since scans are resource-intensive
  --min-instances 0 \
  --max-instances 10
```

### Cost implication:

`--no-cpu-throttling` means you pay for CPU time while background work is running (not just during HTTP request processing). For a service that runs occasional scans, this cost increase is minimal and well worth the 30x performance improvement.
