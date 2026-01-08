const { initializeApp } = require("firebase-admin/app");
const { getAuth } = require("firebase-admin/auth");
const { getFirestore, Timestamp } = require("firebase-admin/firestore");
const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { onSchedule } = require("firebase-functions/v2/scheduler");
const { onDocumentUpdated } = require("firebase-functions/v2/firestore");
const { setGlobalOptions } = require("firebase-functions");
const { defineSecret } = require("firebase-functions/params");
const logger = require("firebase-functions/logger");
const { DateTime } = require("luxon");

initializeApp();
const db = getFirestore();

setGlobalOptions({ maxInstances: 10 });

// Define secrets from Firebase Secret Manager
const apiAuthToken = defineSecret("API_AUTH_TOKEN");
const integrityRunnerUrl = defineSecret("INTEGRITY_RUNNER_URL");

/**
 * Grant admin access to a user by email address.
 * Creates or updates the user document in Firestore with isAdmin: true.
 */
exports.grantAdminAccess = onCall(async (request) => {
  const email = request.data.email;

  if (!email || typeof email !== "string") {
    throw new HttpsError("invalid-argument", "Email is required and must be a string");
  }

  try {
    const auth = getAuth();
    let user;

    try {
      user = await auth.getUserByEmail(email);
    } catch (error) {
      if (error.code === "auth/user-not-found") {
        throw new HttpsError("not-found", `User with email ${email} not found. User must sign in first.`);
      }
      throw error;
    }

    const userRef = db.collection("users").doc(user.uid);
    await userRef.set({ isAdmin: true, email: email }, { merge: true });

    logger.info(`Granted admin access to ${email}`, { uid: user.uid, email: email });

    return { success: true, message: `Admin access granted to ${email}`, uid: user.uid };
  } catch (error) {
    logger.error("Error granting admin access", { error: error.message, email: email });
    if (error instanceof HttpsError) {
      throw error;
    }
    throw new HttpsError("internal", `Failed to grant admin access: ${error.message}`);
  }
});

/**
 * Scheduled function that runs every minute to check for due schedules
 * and trigger integrity runs.
 */
exports.runScheduledScans = onSchedule(
  {
    schedule: "every 1 minutes",
    timeZone: "UTC",
    memory: "256MiB",
    timeoutSeconds: 540,
    secrets: [apiAuthToken, integrityRunnerUrl], // Access secrets from Secret Manager
  },
  async (event) => {
    // Get secrets from Secret Manager
    const INTEGRITY_RUNNER_URL = integrityRunnerUrl.value();
    const API_AUTH_TOKEN = apiAuthToken.value();

    if (!INTEGRITY_RUNNER_URL) {
      logger.error("INTEGRITY_RUNNER_URL secret not available from Secret Manager. Set it using: firebase functions:secrets:set INTEGRITY_RUNNER_URL");
      return;
    }

    if (!API_AUTH_TOKEN) {
      logger.error("API_AUTH_TOKEN secret not available from Secret Manager. Set it using: firebase functions:secrets:set API_AUTH_TOKEN");
      return;
    }

    const now = Timestamp.now();
    logger.info("Checking for due schedules", { timestamp: now.toDate().toISOString() });

    try {
      // Query for due schedules
      const schedulesRef = db.collection("schedules");
      const dueSchedulesQuery = schedulesRef
        .where("enabled", "==", true)
        .where("next_run_at", "<=", now)
        .orderBy("next_run_at")
        .limit(10);

      const snapshot = await dueSchedulesQuery.get();

      if (snapshot.empty) {
        logger.info("No due schedules found");
        return;
      }

      logger.info(`Found ${snapshot.size} due schedule(s)`);

      // Process each schedule
      for (const scheduleDoc of snapshot.docs) {
        const scheduleId = scheduleDoc.id;
        const schedule = scheduleDoc.data();

        try {
          // Create execution ID before transaction
          const executionId = db.collection("schedule_executions").doc().id;
          let executionCreated = false;
          let nextRunTimestamp = null;
          let scheduledFor = null;
          let runConfig = null;
          let notifySlack = false;

          // Claim the schedule in a transaction
          await db.runTransaction(async (transaction) => {
            const scheduleRef = db.collection("schedules").doc(scheduleId);
            const currentSchedule = await transaction.get(scheduleRef);

            if (!currentSchedule.exists) {
              logger.warn(`Schedule ${scheduleId} no longer exists`);
              return;
            }

            const currentData = currentSchedule.data();

            // Re-check conditions
            if (!currentData.enabled) {
              logger.info(`Schedule ${scheduleId} is disabled, skipping`);
              return;
            }

            const nextRunAt = currentData.next_run_at;
            if (!nextRunAt || nextRunAt.toMillis() > now.toMillis()) {
              logger.info(`Schedule ${scheduleId} is not due yet`);
              return;
            }

            // Check if locked recently (within last 5 minutes)
            if (currentData.lock && currentData.lock.locked_at) {
              const lockTime = currentData.lock.locked_at.toMillis();
              const fiveMinutesAgo = now.toMillis() - 5 * 60 * 1000;
              if (lockTime > fiveMinutesAgo) {
                logger.warn(`Schedule ${scheduleId} is locked, skipping`);
                return;
              }
            }

            // Check stop conditions
            const runCount = currentData.run_count || 0;
            const maxRuns = currentData.max_runs;
            const stopAt = currentData.stop_at;

            // Check if max_runs condition is met
            if (maxRuns !== undefined && runCount >= maxRuns) {
              logger.info(`Schedule ${scheduleId} has reached max_runs (${runCount}/${maxRuns}), disabling`);
              transaction.update(scheduleRef, {
                enabled: false,
                lock: null,
              });
              return;
            }

            // Check if stop_at condition is met
            if (stopAt && stopAt.toMillis() <= now.toMillis()) {
              logger.info(`Schedule ${scheduleId} has reached stop_at time, disabling`);
              transaction.update(scheduleRef, {
                enabled: false,
                lock: null,
              });
              return;
            }

            // Claim the schedule
            transaction.update(scheduleRef, {
              lock: {
                locked_at: now,
                locked_by: "scheduler",
              },
            });

            // Compute next run time (pass previous next_run_at for interval-based frequencies)
            // Log schedule config for debugging
            if (currentData.frequency === "hourly") {
              logger.info(`Computing next run for hourly schedule ${scheduleId}`, {
                frequency: currentData.frequency,
                interval_minutes: currentData.interval_minutes,
                previousNextRunAt: nextRunAt?.toDate().toISOString(),
              });
            }
            nextRunTimestamp = computeNextRunAt(
              currentData.frequency,
              currentData.time_of_day,
              currentData.timezone,
              currentData.days_of_week,
              currentData.interval_minutes,
              currentData.times_of_day,
              nextRunAt // Pass previous next_run_at for incrementing intervals
            );

            // Store values for use outside transaction
            scheduledFor = nextRunAt;
            runConfig = currentData.run_config;
            notifySlack = currentData.notify_slack || false;

            // Create execution record
            const executionRef = db.collection("schedule_executions").doc(executionId);
            transaction.set(executionRef, {
              schedule_id: scheduleId,
              group_id: currentData.group_id,
              scheduled_for: nextRunAt,
              started_at: now,
              status: "started",
              run_config: currentData.run_config,
            });

            // Increment run_count and update schedule with next run time
            const newRunCount = (currentData.run_count || 0) + 1;
            const updateData = {
              next_run_at: nextRunTimestamp,
              run_count: newRunCount,
            };

            // Check if we've reached max_runs after incrementing
            if (maxRuns !== undefined && newRunCount >= maxRuns) {
              updateData.enabled = false;
              logger.info(`Schedule ${scheduleId} will reach max_runs after this run, will disable`);
            }

            transaction.update(scheduleRef, updateData);

            executionCreated = true;
          });

          if (!executionCreated) {
            continue; // Schedule was not claimed, skip to next
          }

          logger.info(`Claimed schedule ${scheduleId}`, {
            nextRunAt: nextRunTimestamp.toDate().toISOString(),
            executionId: executionId,
            has_run_config: !!runConfig,
            run_config_keys: runConfig ? Object.keys(runConfig) : [],
          });

          // Trigger the backend run
          // Safely extract entities and rules with null checks
          const entities = (runConfig && runConfig.entities) || [];
          const rules = (runConfig && runConfig.rules) || null;

          // Log what we're about to send
          logger.info(`Preparing run request for schedule ${scheduleId}`, {
            entities_count: entities.length,
            entities: entities,
            has_rules: !!rules,
            rules_keys: rules ? Object.keys(rules) : [],
            rules_content: rules ? JSON.stringify(rules) : null,
          });

          const params = new URLSearchParams({
            trigger: "schedule",
          });

          // Build request body with run_config
          const requestBody = {};
          if (entities.length > 0) {
            requestBody.entities = entities;
            // Also add to query params for backward compatibility
            entities.forEach((entity) => {
              params.append("entities", entity);
            });
          }
          
          // Only include rules if they exist and have content
          if (rules && typeof rules === 'object' && Object.keys(rules).length > 0) {
            requestBody.rules = rules;

            // Build checks object based on which rule categories have selections
            // This enables the backend to know which check types to run
            const checks = {};

            // Check if duplicates has any rules selected
            if (rules.duplicates && typeof rules.duplicates === 'object') {
              const hasSelectedDuplicates = Object.values(rules.duplicates).some(
                arr => Array.isArray(arr) && arr.length > 0
              );
              checks.duplicates = hasSelectedDuplicates;
            }

            // Check if relationships has any rules selected
            if (rules.relationships && typeof rules.relationships === 'object') {
              const hasSelectedRelationships = Object.values(rules.relationships).some(
                arr => Array.isArray(arr) && arr.length > 0
              );
              checks.links = hasSelectedRelationships;
            }

            // Check if required_fields has any rules selected
            if (rules.required_fields && typeof rules.required_fields === 'object') {
              const hasSelectedRequiredFields = Object.values(rules.required_fields).some(
                arr => Array.isArray(arr) && arr.length > 0
              );
              checks.required_fields = hasSelectedRequiredFields;
            }

            // Check if value_checks has any rules selected
            if (rules.value_checks && typeof rules.value_checks === 'object') {
              const hasSelectedValueChecks = Object.values(rules.value_checks).some(
                arr => Array.isArray(arr) && arr.length > 0
              );
              checks.value_checks = hasSelectedValueChecks;
            }

            // Check if attendance_rules is enabled
            if (rules.attendance_rules === true) {
              checks.attendance = true;
            }

            // Only add checks if at least one is enabled
            if (Object.keys(checks).length > 0) {
              requestBody.checks = checks;
            }
          }
          // Include notify_slack if enabled on the schedule
          if (notifySlack) {
            requestBody.notify_slack = true;
          }

          const url = `${INTEGRITY_RUNNER_URL}/integrity/run?${params.toString()}`;
          logger.info(`Triggering run for schedule ${scheduleId}`, {
            url,
            entities,
            entities_count: entities.length,
            has_rules: !!rules,
            rules_structure: rules ? {
              has_duplicates: !!(rules.duplicates && Object.keys(rules.duplicates).length > 0),
              has_relationships: !!(rules.relationships && Object.keys(rules.relationships).length > 0),
              has_required_fields: !!(rules.required_fields && Object.keys(rules.required_fields).length > 0),
              has_value_checks: !!(rules.value_checks && Object.keys(rules.value_checks).length > 0),
              has_attendance_rules: rules.attendance_rules === true,
            } : null,
            has_checks: !!requestBody.checks,
            checks: requestBody.checks,
            notify_slack: notifySlack,
            requestBody: JSON.stringify(requestBody),
            requestBody_keys: Object.keys(requestBody),
          });

          let runId = null;
          let timeoutId = null;
          try {
            // Add timeout to prevent hanging if backend is slow/unreachable
            const controller = new AbortController();
            timeoutId = setTimeout(() => controller.abort(), 30000); // 30 second timeout

            const response = await fetch(url, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${API_AUTH_TOKEN}`
              },
              body: Object.keys(requestBody).length > 0 ? JSON.stringify(requestBody) : undefined,
              signal: controller.signal,
            });

            clearTimeout(timeoutId);
            timeoutId = null;

            if (!response.ok) {
              const errorText = await response.text();
              throw new Error(`Backend returned ${response.status}: ${errorText}`);
            }

            const result = await response.json();
            runId = result.run_id;

            logger.info(`Run triggered successfully for schedule ${scheduleId}`, {
              runId,
            });

            // Update schedule and execution with run ID
            const executionRef = db
              .collection("schedule_executions")
              .doc(executionId);
            const scheduleRef = db.collection("schedules").doc(scheduleId);

            await db.runTransaction(async (transaction) => {
              transaction.update(scheduleRef, {
                last_run_at: now,
                last_run_id: runId,
                lock: null, // Clear lock on success
              });

              transaction.update(executionRef, {
                run_id: runId,
                status: "started",
              });
            });
          } catch (error) {
            // Clear timeout in case of error (if not already cleared)
            if (timeoutId !== null) {
              clearTimeout(timeoutId);
            }

            // Handle timeout errors specifically
            if (error.name === 'AbortError') {
              logger.error(`Request to backend timed out after 30 seconds for schedule ${scheduleId}`, {
                error: error.message,
                url,
              });
            } else {
              logger.error(`Failed to trigger run for schedule ${scheduleId}`, {
                error: error.message,
                stack: error.stack,
              });
            }

            // Update execution with error
            const executionRef = db
              .collection("schedule_executions")
              .doc(executionId);
            const scheduleRef = db.collection("schedules").doc(scheduleId);

            await db.runTransaction(async (transaction) => {
              transaction.update(executionRef, {
                status: "error",
                error: {
                  message: error.message,
                  code: error.code || "UNKNOWN",
                },
              });

              // Clear lock on error (allow retry on next cycle)
              transaction.update(scheduleRef, {
                lock: null,
              });
            });
          }
        } catch (error) {
          logger.error(`Error processing schedule ${scheduleId}`, {
            error: error.message,
            stack: error.stack,
          });
        }
      }
    } catch (error) {
      logger.error("Error in scheduled scan runner", {
        error: error.message,
        stack: error.stack,
      });
    }
  }
);

/**
 * Compute the next run timestamp based on schedule configuration.
 * @param {string} frequency - Schedule frequency (daily, weekly, hourly, custom_times)
 * @param {string} timeOfDay - Time of day in HH:mm format
 * @param {string} timezone - Timezone string
 * @param {number[]} daysOfWeek - Days of week (0-6) for weekly frequency
 * @param {number} intervalMinutes - Interval in minutes for hourly frequency
 * @param {string[]} timesOfDay - Array of times for custom_times frequency
 * @param {Timestamp} previousNextRunAt - Previous next_run_at timestamp (for incrementing intervals)
 */
function computeNextRunAt(frequency, timeOfDay, timezone, daysOfWeek, intervalMinutes, timesOfDay, previousNextRunAt) {
  // If previousNextRunAt is provided, use it as the base time (for incrementing)
  // Otherwise, use current time (for initial calculation)
  const tz = previousNextRunAt
    ? DateTime.fromJSDate(previousNextRunAt.toDate()).setZone(timezone)
    : DateTime.now().setZone(timezone);
  let nextRun;

  // For hourly frequency with interval, ensure intervalMinutes is valid
  if (frequency === "hourly") {
    if (intervalMinutes == null || intervalMinutes <= 0) {
      // Fallback: log warning and use default time_of_day
      logger.warn(`Hourly schedule missing or invalid interval_minutes (${intervalMinutes}), falling back to time_of_day`);
    }
  }

  if (frequency === "hourly" && intervalMinutes != null && intervalMinutes > 0) {
    if (previousNextRunAt) {
      // For subsequent runs, increment from previous time
      nextRun = tz.plus({ minutes: intervalMinutes });
    } else {
      // For initial calculation, use time_of_day as the starting point
      // Then calculate how many intervals have passed since that time today
      const [startHours, startMinutes] = timeOfDay.split(":").map(Number);
      const startTimeToday = tz.set({ hour: startHours, minute: startMinutes, second: 0, millisecond: 0 });

      // If start time hasn't passed today, use it
      if (startTimeToday > tz) {
        nextRun = startTimeToday;
      } else {
        // Start time has passed, calculate next interval
        // Find how many intervals have passed since start time
        const minutesSinceStart = tz.diff(startTimeToday, "minutes").minutes;
        const intervalsPassed = Math.floor(minutesSinceStart / intervalMinutes);

        // Next run is start time + (intervalsPassed + 1) * intervalMinutes
        nextRun = startTimeToday.plus({ minutes: (intervalsPassed + 1) * intervalMinutes });

        // Safety check: if next run is in the past (shouldn't happen, but just in case)
        if (nextRun <= tz) {
          nextRun = nextRun.plus({ minutes: intervalMinutes });
        }
      }
    }
  } else if (frequency === "custom_times" && timesOfDay && timesOfDay.length > 0) {
    // For custom_times, find the next time from the array that hasn't passed today
    const sortedTimes = [...timesOfDay].sort();
    const currentTimeStr = `${String(tz.hour).padStart(2, "0")}:${String(tz.minute).padStart(2, "0")}`;

    // Find next time today
    let nextTimeStr = sortedTimes.find((time) => time > currentTimeStr);

    if (!nextTimeStr) {
      // No more times today, use first time tomorrow
      nextTimeStr = sortedTimes[0];
      const [hours, minutes] = nextTimeStr.split(":").map(Number);
      nextRun = tz
        .plus({ days: 1 })
        .set({ hour: hours, minute: minutes, second: 0, millisecond: 0 });
    } else {
      // Use next time today
      const [hours, minutes] = nextTimeStr.split(":").map(Number);
      nextRun = tz.set({ hour: hours, minute: minutes, second: 0, millisecond: 0 });
    }
  } else {
    // For daily and weekly, use existing logic
    const [hours, minutes] = timeOfDay.split(":").map(Number);
    nextRun = tz.set({ hour: hours, minute: minutes, second: 0, millisecond: 0 });

    if (frequency === "daily") {
      // If the time has already passed today, schedule for tomorrow
      if (nextRun <= tz) {
        nextRun = nextRun.plus({ days: 1 });
      }
    } else if (frequency === "weekly" && daysOfWeek && daysOfWeek.length > 0) {
      // Find the next occurrence of one of the specified days
      const sortedDays = [...daysOfWeek].sort((a, b) => a - b);
      const currentDay = tz.weekday === 7 ? 0 : tz.weekday; // Luxon uses 1-7, we use 0-6

      // Find next day in the week
      let nextDay = sortedDays.find((d) => d > currentDay);

      if (!nextDay) {
        // Next occurrence is next week
        nextDay = sortedDays[0];
        const daysUntilNext = 7 - currentDay + nextDay;
        nextRun = nextRun.plus({ days: daysUntilNext });
      } else {
        // Next occurrence is this week
        const daysUntilNext = nextDay - currentDay;
        nextRun = nextRun.plus({ days: daysUntilNext });
      }

      // If we've already passed the time today and today is one of the scheduled days
      if (nextRun <= tz && sortedDays.includes(currentDay)) {
        // Move to next week
        nextRun = nextRun.plus({ days: 7 });
      }
    }
  }

  // Convert to Firestore Timestamp
  return Timestamp.fromDate(nextRun.toJSDate());
}

/**
 * Scheduled function that checks for completed runs and updates schedule_executions status.
 * Runs every 2 minutes to check for runs that have completed but executions are still "started".
 * This avoids needing Eventarc permissions for Firestore triggers.
 */
exports.updateScheduleExecutionStatus = onSchedule(
  {
    schedule: "every 2 minutes",
    timeZone: "UTC",
    memory: "128MiB",
    timeoutSeconds: 60,
  },
  async (event) => {
    const now = Timestamp.now();
    logger.info("Checking for completed runs to update execution status", {
      timestamp: now.toDate().toISOString(),
    });

    try {
      // Find executions with status "started" that have a run_id
      const executionsRef = db.collection("schedule_executions");
      const startedExecutionsQuery = executionsRef
        .where("status", "==", "started")
        .where("run_id", "!=", null)
        .limit(50);

      const executionsSnapshot = await startedExecutionsQuery.get();

      if (executionsSnapshot.empty) {
        logger.info("No started executions found to update");
        return;
      }

      logger.info(`Found ${executionsSnapshot.size} started execution(s) to check`);

      // Get all run_ids
      const runIds = executionsSnapshot.docs
        .map((doc) => doc.data().run_id)
        .filter((id) => id != null);

      if (runIds.length === 0) {
        return;
      }

      // Check each run's status
      const runsRef = db.collection("integrity_runs");
      const updates = [];

      for (const executionDoc of executionsSnapshot.docs) {
        const executionData = executionDoc.data();
        const runId = executionData.run_id;

        if (!runId) continue;

        try {
          const runDoc = await runsRef.doc(runId).get();

          if (!runDoc.exists) {
            logger.debug(`Run ${runId} not found, skipping`);
            continue;
          }

          const runData = runDoc.data();
          const runStatus = runData?.status;

          // Only update if run is no longer "running"
          if (runStatus && runStatus !== "running") {
            const updateData = {
              status:
                runStatus === "success" || runStatus === "healthy"
                  ? "completed"
                  : "error",
              completed_at: runData.ended_at || Timestamp.now(),
            };

            // Add error details if the run failed
            if (runStatus === "error" || runStatus === "failed") {
              updateData.error = {
                message: runData.error_message || "Run failed",
                code: "RUN_ERROR",
              };
            }

            updates.push({
              executionId: executionDoc.id,
              runId,
              updateData,
              runStatus,
            });
          }
        } catch (error) {
          logger.error(`Error checking run ${runId}`, {
            error: error.message,
            executionId: executionDoc.id,
          });
        }
      }

      // Batch update all executions
      if (updates.length > 0) {
        const batch = db.batch();

        for (const update of updates) {
          const executionRef = executionsRef.doc(update.executionId);
          batch.update(executionRef, update.updateData);
        }

        await batch.commit();

        logger.info(`Updated ${updates.length} execution(s)`, {
          updates: updates.map((u) => ({
            executionId: u.executionId,
            runId: u.runId,
            status: u.updateData.status,
          })),
        });
      } else {
        logger.info("No executions needed updating");
      }
    } catch (error) {
      logger.error("Error updating execution statuses", {
        error: error.message,
        stack: error.stack,
      });
    }
  }
);

/**
 * Scheduled function that runs every 10 minutes to detect and clean up hung runs.
 * Marks runs that have been in "running" status for more than 30 minutes as "timeout".
 */
exports.cleanupHungRuns = onSchedule(
  {
    schedule: "every 10 minutes",
    timeZone: "UTC",
    memory: "128MiB",
    timeoutSeconds: 120,
  },
  async () => {
    const HUNG_RUN_THRESHOLD_MINUTES = 30;
    const now = Timestamp.now();
    const cutoffTime = Timestamp.fromDate(
      new Date(Date.now() - HUNG_RUN_THRESHOLD_MINUTES * 60 * 1000)
    );

    logger.info("Checking for hung runs", {
      timestamp: now.toDate().toISOString(),
      cutoffTime: cutoffTime.toDate().toISOString(),
      thresholdMinutes: HUNG_RUN_THRESHOLD_MINUTES,
    });

    try {
      // Find runs that have been "running" for more than the threshold
      const runsRef = db.collection("integrity_runs");
      const hungRunsQuery = runsRef
        .where("status", "==", "running")
        .where("started_at", "<", cutoffTime)
        .limit(50);

      const hungRunsSnapshot = await hungRunsQuery.get();

      if (hungRunsSnapshot.empty) {
        logger.info("No hung runs found");
        return;
      }

      logger.info(`Found ${hungRunsSnapshot.size} hung run(s) to clean up`);

      // Update each hung run to "timeout" status
      const batch = db.batch();
      const updates = [];

      for (const runDoc of hungRunsSnapshot.docs) {
        const runData = runDoc.data();
        const runId = runDoc.id;
        const startedAt = runData.started_at?.toDate();
        const elapsedMinutes = startedAt
          ? Math.floor((Date.now() - startedAt.getTime()) / (1000 * 60))
          : null;

        const updateData = {
          status: "timeout",
          ended_at: now,
          error_message: `Run exceeded maximum duration (${HUNG_RUN_THRESHOLD_MINUTES} minutes) and was automatically terminated`,
        };

        batch.update(runDoc.ref, updateData);

        updates.push({
          runId,
          trigger: runData.trigger,
          elapsedMinutes,
          startedAt: startedAt?.toISOString(),
        });

        logger.info(`Marking hung run as timeout`, {
          runId,
          elapsedMinutes,
          trigger: runData.trigger,
        });
      }

      // Commit the batch update
      await batch.commit();

      logger.info(`Successfully cleaned up ${updates.length} hung run(s)`, {
        updates,
      });
    } catch (error) {
      logger.error("Error cleaning up hung runs", {
        error: error.message,
        stack: error.stack,
      });
    }
  }
);
