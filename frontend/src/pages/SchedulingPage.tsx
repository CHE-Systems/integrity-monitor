import { useState, useMemo, Fragment, useRef, useEffect } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { Timestamp, deleteField } from "firebase/firestore";
import { useFirestoreScheduleGroups } from "../hooks/useFirestoreScheduleGroups";
import { useFirestoreSchedules } from "../hooks/useFirestoreSchedules";
import { useFirestoreScheduleExecutions } from "../hooks/useFirestoreScheduleExecutions";
import { useAuth } from "../hooks/useAuth";
import { useRunStatus } from "../hooks/useRunStatus";
import { useRules } from "../hooks/useRules";
import ConfirmModal from "../components/ConfirmModal";
import { RuleSelectionPanel } from "../components/RuleSelectionPanel";
import type { AirtableSchema, AirtableTable } from "../utils/airtable";
import { API_BASE } from "../config/api";
import { ACTIVE_ENTITIES, ENTITY_TABLE_MAPPING, TABLE_ENTITY_MAPPING } from "../config/entities";
import arrowLeftIcon from "../assets/keyboard_arrow_left.svg";
import arrowRightIcon from "../assets/keyboard_arrow_right.svg";
import doubleArrowLeftIcon from "../assets/keyboard_double_arrow_left.svg";
import doubleArrowRightIcon from "../assets/keyboard_double_arrow_right.svg";

const TIMEZONES = [
  { value: "America/Denver", label: "Mountain Time (MT)" },
  { value: "UTC", label: "UTC" },
];

const DAYS_OF_WEEK = [
  { value: 0, label: "Sunday" },
  { value: 1, label: "Monday" },
  { value: 2, label: "Tuesday" },
  { value: 3, label: "Wednesday" },
  { value: 4, label: "Thursday" },
  { value: 5, label: "Friday" },
  { value: 6, label: "Saturday" },
];

function computeNextRunAt(
  frequency: "daily" | "weekly" | "hourly" | "custom_times",
  timeOfDay: string,
  timezone: string,
  daysOfWeek?: number[],
  intervalMinutes?: number,
  timesOfDay?: string[],
  baseDate?: Date
): Timestamp {
  const [hours, minutes] = timeOfDay.split(":").map(Number);
  const now = baseDate || new Date();

  // Get today's date in target timezone (accounts for DST automatically)
  const todayParts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);

  const today: Record<string, string> = {};
  todayParts.forEach((part) => {
    today[part.type] = part.value;
  });

  const year = parseInt(today.year);
  const month = parseInt(today.month) - 1; // 0-indexed
  const day = parseInt(today.day);

  // Create a date string for "today at HH:mm" in the target timezone
  // Format: "YYYY-MM-DDTHH:mm:ss" - we'll use this to create a date
  const dateStr = `${year}-${String(month + 1).padStart(2, "0")}-${String(
    day
  ).padStart(2, "0")}T${String(hours).padStart(2, "0")}:${String(
    minutes
  ).padStart(2, "0")}:00`;

  // To convert a time in a specific timezone to UTC, we need to:
  // 1. Get what "now" is in the target timezone
  // 2. Calculate the offset
  // 3. Apply that offset to our target time

  // Get current time in target timezone
  const nowTzParts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(now);

  const nowTz: Record<string, string> = {};
  nowTzParts.forEach((part) => {
    nowTz[part.type] = part.value;
  });

  // Create a local Date representing "now" in target timezone
  const nowTzLocal = new Date(
    parseInt(nowTz.year),
    parseInt(nowTz.month) - 1,
    parseInt(nowTz.day),
    parseInt(nowTz.hour),
    parseInt(nowTz.minute),
    parseInt(nowTz.second)
  );

  // Calculate offset: difference between UTC "now" and TZ "now" as local
  // This offset accounts for both timezone and DST
  const offset = now.getTime() - nowTzLocal.getTime();

  // Create local date for target time today
  const targetTzLocal = new Date(year, month, day, hours, minutes, 0);

  // Convert to UTC by adding the offset
  let nextRun = new Date(targetTzLocal.getTime() + offset);

  if (frequency === "hourly" && intervalMinutes) {
    // For hourly, calculate next run as now + intervalMinutes (rounded up to next interval)
    // Get current time in target timezone
    const currentMinutes = parseInt(nowTz.minute);
    const currentSeconds = parseInt(nowTz.second);
    const totalCurrentSeconds = currentMinutes * 60 + currentSeconds;

    // Calculate how many intervals have passed
    const intervalsPassed = Math.floor(
      totalCurrentSeconds / (intervalMinutes * 60)
    );

    // Next interval is (intervalsPassed + 1) * intervalMinutes minutes
    // If baseDate is provided, we want the next interval after the base date
    const nextIntervalMinutes = baseDate
      ? (intervalsPassed + 1) * intervalMinutes
      : (intervalsPassed + 1) * intervalMinutes;

    // Create date for next interval in target timezone
    let nextIntervalLocal: Date;
    if (nextIntervalMinutes >= 60) {
      // Next interval is in the next hour
      const nextHour = parseInt(nowTz.hour) + 1;
      const minutesInNextHour = nextIntervalMinutes - 60;
      nextIntervalLocal = new Date(
        parseInt(nowTz.year),
        parseInt(nowTz.month) - 1,
        parseInt(nowTz.day),
        nextHour,
        minutesInNextHour,
        0
      );
    } else {
      // Next interval is in current hour
      nextIntervalLocal = new Date(
        parseInt(nowTz.year),
        parseInt(nowTz.month) - 1,
        parseInt(nowTz.day),
        parseInt(nowTz.hour),
        nextIntervalMinutes,
        0
      );
    }

    // Convert to UTC
    nextRun = new Date(nextIntervalLocal.getTime() + offset);

    // Safety check: if next run is in the past (or same as base), add one more interval
    if (nextRun <= now) {
      nextRun = new Date(nextRun.getTime() + intervalMinutes * 60 * 1000);
    }
  } else if (
    frequency === "custom_times" &&
    timesOfDay &&
    timesOfDay.length > 0
  ) {
    // For custom_times, find the next time from the array that hasn't passed
    const sortedTimes = [...timesOfDay].sort();
    const nowInTz = new Date(now.getTime() - offset);
    const currentTimeStr = `${String(nowInTz.getHours()).padStart(
      2,
      "0"
    )}:${String(nowInTz.getMinutes()).padStart(2, "0")}`;

    // Find next time today (or same day if baseDate is provided)
    let nextTimeStr = sortedTimes.find((time) => time > currentTimeStr);

    if (!nextTimeStr) {
      // No more times today, use first time tomorrow
      nextTimeStr = sortedTimes[0];
      const tomorrowLocal = new Date(
        parseInt(nowTz.year),
        parseInt(nowTz.month) - 1,
        parseInt(nowTz.day) + 1,
        0,
        0,
        0
      );
      const [hours, minutes] = nextTimeStr.split(":").map(Number);
      const targetLocal = new Date(
        tomorrowLocal.getFullYear(),
        tomorrowLocal.getMonth(),
        tomorrowLocal.getDate(),
        hours,
        minutes,
        0
      );
      nextRun = new Date(targetLocal.getTime() + offset);
    } else {
      // Use next time today
      const [hours, minutes] = nextTimeStr.split(":").map(Number);
      const targetLocal = new Date(
        parseInt(nowTz.year),
        parseInt(nowTz.month) - 1,
        parseInt(nowTz.day),
        hours,
        minutes,
        0
      );
      nextRun = new Date(targetLocal.getTime() + offset);
    }

    // If baseDate is provided and next run is same as or before base, get next occurrence
    if (baseDate && nextRun <= baseDate) {
      // Find the next time after the base date
      const baseInTz = new Date(baseDate.getTime() - offset);
      const baseTimeStr = `${String(baseInTz.getHours()).padStart(
        2,
        "0"
      )}:${String(baseInTz.getMinutes()).padStart(2, "0")}`;
      nextTimeStr = sortedTimes.find((time) => time > baseTimeStr);

      if (!nextTimeStr) {
        // Next day
        nextTimeStr = sortedTimes[0];
        const nextDayLocal = new Date(
          parseInt(nowTz.year),
          parseInt(nowTz.month) - 1,
          parseInt(nowTz.day) + 1,
          0,
          0,
          0
        );
        const [hours, minutes] = nextTimeStr.split(":").map(Number);
        const targetLocal = new Date(
          nextDayLocal.getFullYear(),
          nextDayLocal.getMonth(),
          nextDayLocal.getDate(),
          hours,
          minutes,
          0
        );
        nextRun = new Date(targetLocal.getTime() + offset);
      } else {
        const [hours, minutes] = nextTimeStr.split(":").map(Number);
        const targetLocal = new Date(
          parseInt(nowTz.year),
          parseInt(nowTz.month) - 1,
          parseInt(nowTz.day),
          hours,
          minutes,
          0
        );
        nextRun = new Date(targetLocal.getTime() + offset);
      }
    }
  } else if (frequency === "daily") {
    // Check if the calculated time has already passed
    if (nextRun <= now) {
      // Time has passed - schedule for tomorrow
      nextRun = new Date(nextRun.getTime() + 24 * 60 * 60 * 1000);
    }
    // Note: The Cloud Function will recompute next_run_at correctly using luxon
    // This frontend calculation is just an initial estimate
  } else if (frequency === "weekly" && daysOfWeek && daysOfWeek.length > 0) {
    const tzDayName = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      weekday: "long",
    }).format(now);
    const dayMap: Record<string, number> = {
      Sunday: 0,
      Monday: 1,
      Tuesday: 2,
      Wednesday: 3,
      Thursday: 4,
      Friday: 5,
      Saturday: 6,
    };
    const currentDay = dayMap[tzDayName] ?? 0;
    const sortedDays = [...daysOfWeek].sort((a, b) => a - b);
    let nextDay = sortedDays.find((d) => d > currentDay);

    if (!nextDay) {
      nextDay = sortedDays[0];
      const daysToAdd = 7 - currentDay + nextDay;
      nextRun = new Date(nextRun.getTime() + daysToAdd * 24 * 60 * 60 * 1000);
    } else {
      const daysToAdd = nextDay - currentDay;
      nextRun = new Date(nextRun.getTime() + daysToAdd * 24 * 60 * 60 * 1000);
    }

    if (nextRun <= now && nextDay === currentDay) {
      nextRun = new Date(nextRun.getTime() + 7 * 24 * 60 * 60 * 1000);
    }
  }

  return Timestamp.fromDate(nextRun);
}

function computeNextRuns(
  schedule: {
    frequency: "daily" | "weekly" | "hourly" | "custom_times";
    time_of_day: string;
    timezone: string;
    days_of_week?: number[];
    interval_minutes?: number;
    times_of_day?: string[];
    next_run_at?: Timestamp;
  },
  count: number = 10
): Date[] {
  const runs: Date[] = [];
  let currentBase: Date | undefined = schedule.next_run_at?.toDate();

  for (let i = 0; i < count; i++) {
    try {
      const nextRunTimestamp = computeNextRunAt(
        schedule.frequency,
        schedule.time_of_day,
        schedule.timezone,
        schedule.days_of_week,
        schedule.interval_minutes,
        schedule.times_of_day,
        currentBase
      );
      const nextRunDate = nextRunTimestamp.toDate();
      runs.push(nextRunDate);
      // For next iteration, use the calculated date as base
      // Add a small offset to ensure we get the next occurrence
      currentBase = new Date(nextRunDate.getTime() + 1000);
    } catch (error) {
      console.error("Error computing next run:", error);
      break;
    }
  }

  return runs;
}

function NextRunTooltip({
  schedule,
  children,
}: {
  schedule: {
    frequency: "daily" | "weekly" | "hourly" | "custom_times";
    time_of_day: string;
    timezone: string;
    days_of_week?: number[];
    interval_minutes?: number;
    times_of_day?: string[];
    next_run_at?: Timestamp;
  };
  children: React.ReactNode;
}) {
  const [isHovered, setIsHovered] = useState(false);
  const [futureRuns, setFutureRuns] = useState<Date[]>([]);
  const [mousePosition, setMousePosition] = useState<{
    x: number;
    y: number;
  } | null>(null);
  const [tooltipPosition, setTooltipPosition] = useState<{
    top?: number;
    bottom?: number;
    left?: number;
  }>({});
  const tooltipRef = useRef<HTMLDivElement>(null);

  // Track mouse position
  const handleMouseMove = (e: React.MouseEvent) => {
    setMousePosition({ x: e.clientX, y: e.clientY });
  };

  useEffect(() => {
    if (isHovered && schedule.next_run_at) {
      try {
        const runs = computeNextRuns(schedule, 10);
        setFutureRuns(runs);
      } catch (error) {
        console.error("Error computing future runs:", error);
        setFutureRuns([]);
      }
    }
  }, [isHovered, schedule]);

  useEffect(() => {
    if (isHovered && mousePosition && tooltipRef.current) {
      requestAnimationFrame(() => {
        if (!tooltipRef.current || !mousePosition) return;

        const tooltipRect = tooltipRef.current.getBoundingClientRect();
        const viewportHeight = window.innerHeight;
        const viewportWidth = window.innerWidth;
        const padding = 8;
        const cursorOffset = 12;

        // Default: position above cursor
        let top: number | undefined;
        let bottom: number | undefined =
          viewportHeight - mousePosition.y + cursorOffset;
        let left: number | undefined = mousePosition.x;

        // Check if tooltip would go above viewport
        if (bottom + tooltipRect.height > viewportHeight - padding) {
          // Position below cursor instead
          bottom = undefined;
          top = mousePosition.y + cursorOffset;
        }

        // Check if tooltip would go right of viewport
        if (left + tooltipRect.width > viewportWidth - padding) {
          left = viewportWidth - tooltipRect.width - padding;
        }

        // Ensure it doesn't go left of viewport
        if (left < padding) {
          left = padding;
        }

        setTooltipPosition({
          ...(top !== undefined && { top }),
          ...(bottom !== undefined && { bottom }),
          ...(left !== undefined && { left }),
        });
      });
    } else {
      setTooltipPosition({});
      setMousePosition(null);
    }
  }, [isHovered, mousePosition]);

  const displayTimezone =
    schedule.timezone === "America/Los_Angeles"
      ? "America/Denver"
      : schedule.timezone;

  return (
    <div
      className="relative inline-block"
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => {
        setIsHovered(false);
        setMousePosition(null);
      }}
      onMouseMove={handleMouseMove}
    >
      <span className="cursor-help underline decoration-dotted">
        {children}
      </span>
      {isHovered && futureRuns.length > 0 && (
        <div
          ref={tooltipRef}
          className="fixed z-[200] w-64 bg-white border border-[var(--border)] rounded-lg shadow-xl p-3 max-h-96 overflow-y-auto"
          style={{
            top: tooltipPosition.top,
            bottom: tooltipPosition.bottom,
            left: tooltipPosition.left,
          }}
        >
          <div className="text-xs font-semibold text-[var(--text-main)] mb-2 pb-2 border-b border-[var(--border)]">
            Next 10 Runs
          </div>
          <div className="space-y-1.5">
            {futureRuns.map((runDate, index) => (
              <div
                key={index}
                className="text-xs text-[var(--text-muted)] py-1"
              >
                {runDate.toLocaleString("en-US", {
                  timeZone: displayTimezone,
                  year: "numeric",
                  month: "short",
                  day: "numeric",
                  hour: "numeric",
                  minute: "2-digit",
                  hour12: true,
                  timeZoneName: "short",
                })}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

export function SchedulingPage() {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const { user } = useAuth();
  const {
    data: groups,
    loading: groupsLoading,
    createGroup,
    updateGroup,
    deleteGroup,
  } = useFirestoreScheduleGroups();
  const {
    data: schedules,
    loading: schedulesLoading,
    createSchedule,
    updateSchedule,
    deleteSchedule,
  } = useFirestoreSchedules();

  const [selectedGroupId, setSelectedGroupId] = useState<string | null>(null);
  const [showGroupModal, setShowGroupModal] = useState(false);
  const [showScheduleModal, setShowScheduleModal] = useState(false);
  const [editingGroup, setEditingGroup] = useState<string | null>(null);
  const [editingSchedule, setEditingSchedule] = useState<string | null>(null);
  const [expandedSchedule, setExpandedSchedule] = useState<string | null>(null);
  const [highlightedScheduleId, setHighlightedScheduleId] = useState<
    string | null
  >(null);
  const scheduleRefs = useRef<Record<string, HTMLDivElement | null>>({});
  const [deletingGroupId, setDeletingGroupId] = useState<string | null>(null);
  const [deletingScheduleId, setDeletingScheduleId] = useState<string | null>(
    null
  );

  const [groupForm, setGroupForm] = useState({ name: "", description: "" });
  const [scheduleForm, setScheduleForm] = useState({
    group_id: "",
    name: "",
    enabled: true,
    timezone: "America/Denver",
    frequency: "daily" as "daily" | "weekly" | "hourly" | "custom_times",
    time_of_day: "14:00",
    days_of_week: [] as number[],
    interval_minutes: undefined as number | undefined,
    times_of_day: undefined as string[] | undefined,
    entities: [] as string[],
    rules: undefined as
      | {
          duplicates?: Record<string, string[]>;
          relationships?: Record<string, string[]>;
          required_fields?: Record<string, string[]>;
          attendance_rules?: boolean;
        }
      | undefined,
    stop_condition_type: "none" as "none" | "max_runs" | "stop_at",
    max_runs: undefined as number | undefined,
    stop_at: undefined as string | undefined,
  });

  const filteredSchedules = useMemo(() => {
    if (!selectedGroupId) return schedules;
    return schedules.filter((s) => s.group_id === selectedGroupId);
  }, [schedules, selectedGroupId]);

  // Handle scheduleId query parameter
  useEffect(() => {
    const scheduleId = searchParams.get("scheduleId");
    if (scheduleId && schedules.length > 0) {
      const schedule = schedules.find((s) => s.id === scheduleId);
      if (schedule) {
        // Set the group filter to show this schedule
        setSelectedGroupId(schedule.group_id);
        // Expand the schedule
        setExpandedSchedule(scheduleId);
        // Highlight it
        setHighlightedScheduleId(scheduleId);
        // Scroll to it after a brief delay to allow rendering
        setTimeout(() => {
          const ref = scheduleRefs.current[scheduleId];
          if (ref) {
            ref.scrollIntoView({ behavior: "smooth", block: "center" });
            // Remove highlight after 3 seconds
            setTimeout(() => {
              setHighlightedScheduleId(null);
              // Remove query parameter
              searchParams.delete("scheduleId");
              setSearchParams(searchParams, { replace: true });
            }, 3000);
          }
        }, 100);
      }
    }
  }, [searchParams, schedules, setSearchParams]);

  const handleCreateGroup = async () => {
    try {
      await createGroup(groupForm.name, groupForm.description);
      setShowGroupModal(false);
      setGroupForm({ name: "", description: "" });
    } catch (error) {
      console.error("Failed to create group:", error);
      alert("Failed to create group");
    }
  };

  const handleUpdateGroup = async (groupId: string) => {
    try {
      await updateGroup(groupId, {
        name: groupForm.name,
        description: groupForm.description,
      });
      setEditingGroup(null);
      setGroupForm({ name: "", description: "" });
    } catch (error) {
      console.error("Failed to update group:", error);
      alert("Failed to update group");
    }
  };

  const handleCreateSchedule = async () => {
    try {
      const nextRunAt = computeNextRunAt(
        scheduleForm.frequency,
        scheduleForm.time_of_day,
        scheduleForm.timezone,
        scheduleForm.frequency === "weekly"
          ? scheduleForm.days_of_week
          : undefined,
        scheduleForm.frequency === "hourly"
          ? scheduleForm.interval_minutes
          : undefined,
        scheduleForm.frequency === "custom_times"
          ? scheduleForm.times_of_day
          : undefined
      );

      const scheduleData: any = {
        group_id: scheduleForm.group_id,
        name: scheduleForm.name,
        enabled: scheduleForm.enabled,
        timezone: scheduleForm.timezone,
        frequency: scheduleForm.frequency,
        time_of_day: scheduleForm.time_of_day,
        run_config: {},
        next_run_at: nextRunAt,
      };

      // Only include frequency-specific fields based on frequency type
      if (scheduleForm.frequency === "weekly") {
        scheduleData.days_of_week = scheduleForm.days_of_week;
      } else if (scheduleForm.frequency === "hourly") {
        scheduleData.interval_minutes = scheduleForm.interval_minutes;
      } else if (scheduleForm.frequency === "custom_times") {
        scheduleData.times_of_day = scheduleForm.times_of_day;
      }

      // Only include entities if any are selected
      if (scheduleForm.entities.length > 0) {
        scheduleData.run_config.entities = scheduleForm.entities;
      }

      // Include rules if specified
      if (scheduleForm.rules) {
        scheduleData.run_config.rules = scheduleForm.rules;
      }

      // Include stop condition fields if set
      if (
        scheduleForm.stop_condition_type === "max_runs" &&
        scheduleForm.max_runs
      ) {
        scheduleData.max_runs = scheduleForm.max_runs;
        scheduleData.run_count = 0; // Initialize run count
      } else if (
        scheduleForm.stop_condition_type === "stop_at" &&
        scheduleForm.stop_at
      ) {
        // Convert datetime-local string to Timestamp
        const stopAtDate = new Date(scheduleForm.stop_at);
        scheduleData.stop_at = Timestamp.fromDate(stopAtDate);
      }

      await createSchedule(scheduleData);

      setShowScheduleModal(false);
      setScheduleForm({
        group_id: "",
        name: "",
        enabled: true,
        timezone: "America/Denver",
        frequency: "daily",
        time_of_day: "14:00",
        days_of_week: [],
        interval_minutes: undefined,
        times_of_day: undefined,
        entities: [],
        rules: undefined,
        stop_condition_type: "none",
        max_runs: undefined,
        stop_at: undefined,
      });
    } catch (error) {
      console.error("Failed to create schedule:", error);
      alert("Failed to create schedule");
    }
  };

  const handleUpdateSchedule = async (scheduleId: string) => {
    try {
      const schedule = schedules.find((s) => s.id === scheduleId);
      if (!schedule) return;

      const nextRunAt = computeNextRunAt(
        scheduleForm.frequency,
        scheduleForm.time_of_day,
        scheduleForm.timezone,
        scheduleForm.frequency === "weekly"
          ? scheduleForm.days_of_week
          : undefined,
        scheduleForm.frequency === "hourly"
          ? scheduleForm.interval_minutes
          : undefined,
        scheduleForm.frequency === "custom_times"
          ? scheduleForm.times_of_day
          : undefined
      );

      const updateData: any = {
        name: scheduleForm.name,
        enabled: scheduleForm.enabled,
        timezone: scheduleForm.timezone,
        frequency: scheduleForm.frequency,
        time_of_day: scheduleForm.time_of_day,
        run_config: {},
        next_run_at: nextRunAt,
      };

      // Only include frequency-specific fields based on frequency type
      // Remove fields that don't apply to the current frequency
      if (scheduleForm.frequency === "weekly") {
        updateData.days_of_week = scheduleForm.days_of_week;
        updateData.interval_minutes = deleteField();
        updateData.times_of_day = deleteField();
      } else if (scheduleForm.frequency === "hourly") {
        updateData.interval_minutes = scheduleForm.interval_minutes;
        updateData.days_of_week = deleteField();
        updateData.times_of_day = deleteField();
      } else if (scheduleForm.frequency === "custom_times") {
        updateData.times_of_day = scheduleForm.times_of_day;
        updateData.days_of_week = deleteField();
        updateData.interval_minutes = deleteField();
      } else {
        // daily frequency
        updateData.days_of_week = deleteField();
        updateData.interval_minutes = deleteField();
        updateData.times_of_day = deleteField();
      }

      // Only include entities if any are selected
      if (scheduleForm.entities.length > 0) {
        updateData.run_config.entities = scheduleForm.entities;
      }

      // Include rules if specified
      if (scheduleForm.rules) {
        updateData.run_config.rules = scheduleForm.rules;
      }

      // Handle stop condition fields
      if (
        scheduleForm.stop_condition_type === "max_runs" &&
        scheduleForm.max_runs
      ) {
        updateData.max_runs = scheduleForm.max_runs;
      } else if (
        scheduleForm.stop_condition_type === "stop_at" &&
        scheduleForm.stop_at
      ) {
        // Convert datetime-local string to Timestamp
        const stopAtDate = new Date(scheduleForm.stop_at);
        updateData.stop_at = Timestamp.fromDate(stopAtDate);
      } else {
        // Clear stop condition fields if "none" is selected
        updateData.stop_at = deleteField();
        updateData.max_runs = deleteField();
      }

      await updateSchedule(scheduleId, updateData);

      setEditingSchedule(null);
      setScheduleForm({
        group_id: "",
        name: "",
        enabled: true,
        timezone: "America/Denver",
        frequency: "daily",
        time_of_day: "14:00",
        days_of_week: [],
        interval_minutes: undefined,
        times_of_day: undefined,
        entities: [],
        rules: undefined,
        stop_condition_type: "none",
        max_runs: undefined,
        stop_at: undefined,
      });
    } catch (error) {
      console.error("Failed to update schedule:", error);
      alert("Failed to update schedule");
    }
  };

  const handleDeleteGroup = async (groupId: string) => {
    try {
      await deleteGroup(groupId);
      setDeletingGroupId(null);
      if (selectedGroupId === groupId) {
        setSelectedGroupId(null);
      }
    } catch (error) {
      console.error("Failed to delete group:", error);
      alert("Failed to delete group");
      setDeletingGroupId(null);
    }
  };

  const handleDeleteSchedule = async (scheduleId: string) => {
    try {
      await deleteSchedule(scheduleId);
      setDeletingScheduleId(null);
    } catch (error) {
      console.error("Failed to delete schedule:", error);
      alert("Failed to delete schedule");
      setDeletingScheduleId(null);
    }
  };

  const openEditGroup = (group: (typeof groups)[0]) => {
    setEditingGroup(group.id);
    setGroupForm({ name: group.name, description: group.description || "" });
    setShowGroupModal(true);
  };

  const openEditSchedule = (schedule: (typeof schedules)[0]) => {
    setEditingSchedule(schedule.id);
    // Convert old Los Angeles timezone to Denver if needed
    const timezone =
      schedule.timezone === "America/Los_Angeles"
        ? "America/Denver"
        : schedule.timezone;

    // Determine stop condition type and values
    let stopConditionType: "none" | "max_runs" | "stop_at" = "none";
    let maxRuns: number | undefined = undefined;
    let stopAt: string | undefined = undefined;

    if (schedule.max_runs !== undefined) {
      stopConditionType = "max_runs";
      maxRuns = schedule.max_runs;
    } else if (schedule.stop_at) {
      stopConditionType = "stop_at";
      // Convert Timestamp to datetime-local string format
      const stopAtDate = schedule.stop_at.toDate();
      const year = stopAtDate.getFullYear();
      const month = String(stopAtDate.getMonth() + 1).padStart(2, "0");
      const day = String(stopAtDate.getDate()).padStart(2, "0");
      const hours = String(stopAtDate.getHours()).padStart(2, "0");
      const minutes = String(stopAtDate.getMinutes()).padStart(2, "0");
      stopAt = `${year}-${month}-${day}T${hours}:${minutes}`;
    }

    setScheduleForm({
      group_id: schedule.group_id,
      name: schedule.name,
      enabled: schedule.enabled,
      timezone: timezone,
      frequency: schedule.frequency,
      time_of_day: schedule.time_of_day,
      days_of_week: schedule.days_of_week || [],
      interval_minutes: schedule.interval_minutes,
      times_of_day: schedule.times_of_day,
      entities: schedule.run_config.entities || [],
      rules: schedule.run_config.rules,
      stop_condition_type: stopConditionType,
      max_runs: maxRuns,
      stop_at: stopAt,
    });
    setShowScheduleModal(true);
  };

  return (
    <div className="space-y-8">
      <div className="flex items-center justify-between">
        <h1
          className="text-3xl font-semibold text-[var(--text-main)]"
          style={{ fontFamily: "Outfit" }}
        >
          Scheduling
        </h1>
      </div>

      {/* Schedule Groups Section */}
      <section className="bg-white border border-[var(--border)] rounded-xl p-6">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-xl font-semibold text-[var(--text-main)]">
            Schedule Groups
          </h2>
          <button
            onClick={() => {
              setEditingGroup(null);
              setGroupForm({ name: "", description: "" });
              setShowGroupModal(true);
            }}
            className="px-4 py-2 text-sm font-medium text-white bg-[var(--brand)] hover:bg-[var(--brand)]/90 rounded-lg transition-colors"
          >
            Create Group
          </button>
        </div>

        {groupsLoading ? (
          <div className="text-[var(--text-muted)] py-4">Loading groups...</div>
        ) : groups.length === 0 ? (
          <div className="text-[var(--text-muted)] py-4">
            No schedule groups yet. Create one to get started.
          </div>
        ) : (
          <div className="space-y-2">
            {groups.map((group) => (
              <div
                key={group.id}
                className="flex items-center justify-between p-4 border border-[var(--border)] rounded-lg hover:bg-[var(--bg-mid)]/50 transition-colors"
              >
                <div className="flex-1">
                  <div className="font-medium text-[var(--text-main)]">
                    {group.name}
                    {!group.enabled && (
                      <span className="ml-2 text-sm text-[var(--text-muted)]">
                        (disabled)
                      </span>
                    )}
                  </div>
                  {group.description && (
                    <div className="text-sm text-[var(--text-muted)] mt-1">
                      {group.description}
                    </div>
                  )}
                </div>
                <div className="flex gap-2">
                  <button
                    onClick={() => openEditGroup(group)}
                    className="px-3 py-1.5 text-sm font-medium text-[var(--brand)] hover:bg-[var(--brand)]/5 rounded-lg transition-colors"
                  >
                    Edit
                  </button>
                  <button
                    onClick={() => setDeletingGroupId(group.id)}
                    className="px-3 py-1.5 text-sm font-medium text-red-600 hover:bg-red-50 rounded-lg transition-colors"
                  >
                    Delete
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* Schedules Section */}
      <section className="bg-white border border-[var(--border)] rounded-xl p-6">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-xl font-semibold text-[var(--text-main)]">
            Schedules
          </h2>
          <div className="flex gap-3">
            <select
              value={selectedGroupId || ""}
              onChange={(e) => setSelectedGroupId(e.target.value || null)}
              className="px-3 py-2 text-sm border border-[var(--border)] rounded-lg bg-white text-[var(--text-main)]"
            >
              <option value="">All Groups</option>
              {groups.map((group) => (
                <option key={group.id} value={group.id}>
                  {group.name}
                </option>
              ))}
            </select>
            <button
              onClick={() => {
                if (groups.length === 0) {
                  alert("Please create a schedule group first");
                  return;
                }
                setEditingSchedule(null);
                setScheduleForm({
                  group_id: groups[0].id,
                  name: "",
                  enabled: true,
                  timezone: "America/Denver",
                  frequency: "daily",
                  time_of_day: "14:00",
                  days_of_week: [],
                  interval_minutes: undefined,
                  times_of_day: undefined,
                  entities: [],
                  rules: undefined,
                  stop_condition_type: "none",
                  max_runs: undefined,
                  stop_at: undefined,
                });
                setShowScheduleModal(true);
              }}
              className="px-4 py-2 text-sm font-medium text-white bg-[var(--brand)] hover:bg-[var(--brand)]/90 rounded-lg transition-colors"
            >
              Create Schedule
            </button>
          </div>
        </div>

        {schedulesLoading ? (
          <div className="text-[var(--text-muted)] py-4">
            Loading schedules...
          </div>
        ) : filteredSchedules.length === 0 ? (
          <div className="text-[var(--text-muted)] py-4">
            No schedules found. Create one to get started.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="border-b border-[var(--border)]">
                  <th className="text-left py-3 px-4 text-sm font-semibold text-[var(--text-main)]">
                    Name
                  </th>
                  <th className="text-left py-3 px-4 text-sm font-semibold text-[var(--text-main)]">
                    Status
                  </th>
                  <th className="text-left py-3 px-4 text-sm font-semibold text-[var(--text-main)]">
                    Frequency
                  </th>
                  <th className="text-left py-3 px-4 text-sm font-semibold text-[var(--text-main)]">
                    Next Run
                  </th>
                  <th className="text-left py-3 px-4 text-sm font-semibold text-[var(--text-main)]">
                    Run Type
                  </th>
                  <th className="text-left py-3 px-4 text-sm font-semibold text-[var(--text-main)]">
                    Actions
                  </th>
                </tr>
              </thead>
              <tbody>
                {filteredSchedules.map((schedule) => (
                  <Fragment key={schedule.id}>
                    <tr
                      ref={(el) => {
                        scheduleRefs.current[schedule.id] = el;
                      }}
                      className={`border-b border-[var(--border)] hover:bg-[var(--bg-mid)]/30 transition-colors ${
                        highlightedScheduleId === schedule.id
                          ? "bg-[var(--cta-blue)]/10 border-l-4 border-[var(--cta-blue)]"
                          : ""
                      }`}
                    >
                      <td className="py-3 px-4">
                        <div className="font-medium text-[var(--text-main)]">
                          {schedule.name}
                        </div>
                        <div className="text-xs text-[var(--text-muted)] mt-1">
                          {groups.find((g) => g.id === schedule.group_id)
                            ?.name || "Unknown Group"}
                        </div>
                      </td>
                      <td className="py-3 px-4">
                        <span
                          className={`inline-block px-2 py-1 text-xs font-medium rounded-full ${
                            schedule.enabled
                              ? "bg-green-100 text-green-700"
                              : "bg-gray-100 text-gray-700"
                          }`}
                        >
                          {schedule.enabled ? "Enabled" : "Disabled"}
                        </span>
                      </td>
                      <td className="py-3 px-4 text-sm text-[var(--text-main)]">
                        {schedule.frequency === "daily"
                          ? "Daily"
                          : schedule.frequency === "weekly"
                          ? schedule.days_of_week
                            ? schedule.days_of_week
                                .map((d) => DAYS_OF_WEEK[d].label.slice(0, 3))
                                .join(", ")
                            : "Weekly"
                          : schedule.frequency === "hourly"
                          ? `Every ${schedule.interval_minutes || 60} minutes`
                          : schedule.frequency === "custom_times"
                          ? `${schedule.times_of_day?.length || 0} times/day`
                          : "Unknown"}
                      </td>
                      <td className="py-3 px-4 text-sm text-[var(--text-main)]">
                        {schedule.next_run_at ? (
                          <NextRunTooltip schedule={schedule}>
                            {(() => {
                              // Use the Firebase value directly - convert Timestamp to Date
                              const nextRunDate = schedule.next_run_at.toDate();
                              // Display in the schedule's configured timezone
                              // If timezone is incorrectly stored as Los Angeles, use Denver instead
                              const displayTimezone =
                                schedule.timezone === "America/Los_Angeles"
                                  ? "America/Denver"
                                  : schedule.timezone;
                              return nextRunDate.toLocaleString("en-US", {
                                timeZone: displayTimezone,
                                year: "numeric",
                                month: "short",
                                day: "numeric",
                                hour: "numeric",
                                minute: "2-digit",
                                hour12: true,
                                timeZoneName: "short",
                              });
                            })()}
                          </NextRunTooltip>
                        ) : (
                          "N/A"
                        )}
                      </td>
                      <td className="py-3 px-4 text-sm text-[var(--text-main)]">
                        {schedule.run_config.entities &&
                          schedule.run_config.entities.length > 0 && (
                            <div className="text-xs text-[var(--text-muted)] mt-1">
                              {schedule.run_config.entities.length}{" "}
                              {schedule.run_config.entities.length === 1
                                ? "entity"
                                : "entities"}
                            </div>
                          )}
                      </td>
                      <td className="py-3 px-4">
                        <div className="flex gap-2">
                          <button
                            onClick={() => openEditSchedule(schedule)}
                            className="px-3 py-1.5 text-sm font-medium text-[var(--brand)] hover:bg-[var(--brand)]/5 rounded-lg transition-colors"
                          >
                            Edit
                          </button>
                          <button
                            onClick={() => {
                              const newEnabled = !schedule.enabled;
                              const updates: any = { enabled: newEnabled };

                              // If re-enabling, recalculate next_run_at based on current time
                              if (newEnabled) {
                                updates.next_run_at = computeNextRunAt(
                                  schedule.frequency,
                                  schedule.time_of_day,
                                  schedule.timezone,
                                  schedule.frequency === "weekly"
                                    ? schedule.days_of_week
                                    : undefined,
                                  schedule.frequency === "hourly"
                                    ? schedule.interval_minutes
                                    : undefined,
                                  schedule.frequency === "custom_times"
                                    ? schedule.times_of_day
                                    : undefined
                                );
                              }

                              updateSchedule(schedule.id, updates);
                            }}
                            className="px-3 py-1.5 text-sm font-medium text-[var(--text-muted)] hover:bg-[var(--bg-mid)] rounded-lg transition-colors"
                          >
                            {schedule.enabled ? "Disable" : "Enable"}
                          </button>
                          <button
                            onClick={() => setDeletingScheduleId(schedule.id)}
                            className="px-3 py-1.5 text-sm font-medium text-red-600 hover:bg-red-50 rounded-lg transition-colors"
                          >
                            Delete
                          </button>
                          <button
                            onClick={() =>
                              setExpandedSchedule(
                                expandedSchedule === schedule.id
                                  ? null
                                  : schedule.id
                              )
                            }
                            className="px-3 py-1.5 text-sm font-medium text-[var(--text-muted)] hover:bg-[var(--bg-mid)] rounded-lg transition-colors"
                          >
                            {expandedSchedule === schedule.id ? "Hide" : "View"}{" "}
                            Executions
                          </button>
                        </div>
                      </td>
                    </tr>
                    {expandedSchedule === schedule.id && (
                      <tr>
                        <td colSpan={6} className="px-4 py-4">
                          <ScheduleExecutions scheduleId={schedule.id} />
                        </td>
                      </tr>
                    )}
                  </Fragment>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* Create/Edit Group Modal */}
      {showGroupModal && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center p-4 sm:p-0">
          <div
            className="fixed inset-0 bg-neutral-900/50 backdrop-blur-sm transition-opacity"
            onClick={() => {
              setShowGroupModal(false);
              setEditingGroup(null);
              setGroupForm({ name: "", description: "" });
            }}
            aria-hidden="true"
          />
          <div className="relative bg-white border border-[var(--border)] rounded-xl shadow-xl w-full max-w-md transform transition-all p-6">
            <h3 className="text-xl font-semibold text-[var(--text-main)] mb-4">
              {editingGroup ? "Edit Group" : "Create Schedule Group"}
            </h3>
            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-[var(--text-main)] mb-2">
                  Name
                </label>
                <input
                  type="text"
                  value={groupForm.name}
                  onChange={(e) =>
                    setGroupForm({ ...groupForm, name: e.target.value })
                  }
                  className="w-full px-3 py-2 border border-[var(--border)] rounded-lg bg-white text-[var(--text-main)]"
                  placeholder="e.g., Nightly Scans"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-[var(--text-main)] mb-2">
                  Description (optional)
                </label>
                <textarea
                  value={groupForm.description}
                  onChange={(e) =>
                    setGroupForm({ ...groupForm, description: e.target.value })
                  }
                  className="w-full px-3 py-2 border border-[var(--border)] rounded-lg bg-white text-[var(--text-main)]"
                  rows={3}
                  placeholder="Optional description for this group"
                />
              </div>
            </div>
            <div className="flex justify-end space-x-3 mt-6">
              <button
                onClick={() => {
                  setShowGroupModal(false);
                  setEditingGroup(null);
                  setGroupForm({ name: "", description: "" });
                }}
                className="px-4 py-2 text-sm font-medium text-[var(--text-muted)] hover:text-[var(--text-main)] bg-[var(--bg-mid)]/50 hover:bg-[var(--bg-mid)] rounded-lg transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={() =>
                  editingGroup
                    ? handleUpdateGroup(editingGroup)
                    : handleCreateGroup()
                }
                disabled={!groupForm.name.trim()}
                className="px-4 py-2 text-sm font-medium text-white rounded-lg transition-colors shadow-sm bg-[var(--brand)] hover:bg-[var(--brand)]/90 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {editingGroup ? "Update" : "Create"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Create/Edit Schedule Modal */}
      {showScheduleModal && (
        <CreateScheduleModal
          isOpen={showScheduleModal}
          groups={groups}
          form={scheduleForm}
          setForm={setScheduleForm}
          onConfirm={() =>
            editingSchedule
              ? handleUpdateSchedule(editingSchedule)
              : handleCreateSchedule()
          }
          onCancel={() => {
            setShowScheduleModal(false);
            setEditingSchedule(null);
            setScheduleForm({
              group_id: "",
              name: "",
              enabled: true,
              timezone: "America/Denver",
              frequency: "daily",
              time_of_day: "14:00",
              days_of_week: [],
              interval_minutes: undefined,
              times_of_day: undefined,
              entities: [],
              rules: undefined,
              stop_condition_type: "none",
              max_runs: undefined,
              stop_at: undefined,
            });
          }}
          isEditing={!!editingSchedule}
        />
      )}

      {/* Delete Confirmations */}
      {deletingGroupId && (
        <ConfirmModal
          isOpen={!!deletingGroupId}
          title="Delete Schedule Group"
          message="Are you sure you want to delete this schedule group? This will not delete the schedules in the group, but they will be orphaned."
          confirmLabel="Delete"
          cancelLabel="Cancel"
          isDestructive
          onConfirm={() => handleDeleteGroup(deletingGroupId)}
          onCancel={() => setDeletingGroupId(null)}
        />
      )}

      {deletingScheduleId && (
        <ConfirmModal
          isOpen={!!deletingScheduleId}
          title="Delete Schedule"
          message="Are you sure you want to delete this schedule? This action cannot be undone."
          confirmLabel="Delete"
          cancelLabel="Cancel"
          isDestructive
          onConfirm={() => handleDeleteSchedule(deletingScheduleId)}
          onCancel={() => setDeletingScheduleId(null)}
        />
      )}
    </div>
  );
}

function ScheduleExecutions({ scheduleId }: { scheduleId: string }) {
  const {
    data: executions,
    loading,
    error,
    hasMore,
    hasPrev,
    currentPage,
    nextPage,
    prevPage,
    goToPage,
    goToLastPage,
    totalCount,
    totalPages,
  } = useFirestoreScheduleExecutions(scheduleId);
  const navigate = useNavigate();
  const [pageInput, setPageInput] = useState("");

  if (loading && executions.length === 0) {
    return (
      <div className="text-[var(--text-muted)] py-2">Loading executions...</div>
    );
  }

  if (error) {
    return (
      <div className="text-red-600 py-2">Error loading executions: {error}</div>
    );
  }

  if (executions.length === 0) {
    return (
      <div className="text-[var(--text-muted)] py-2">
        No executions yet. This schedule hasn't run.
      </div>
    );
  }

  return (
    <div className="mt-2">
      <div className="flex items-center justify-between mb-2">
        <h4 className="text-sm font-semibold text-[var(--text-main)]">
          Executions
        </h4>
        {totalCount !== null && (
          <div className="text-xs text-[var(--text-muted)]">
            {executions.length} shown · {totalCount} total
          </div>
        )}
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-[var(--border)]">
              <th className="text-left py-2 px-3 text-xs font-semibold text-[var(--text-muted)]">
                Started
              </th>
              <th className="text-left py-2 px-3 text-xs font-semibold text-[var(--text-muted)]">
                Status
              </th>
              <th className="text-left py-2 px-3 text-xs font-semibold text-[var(--text-muted)]">
                Actions
              </th>
            </tr>
          </thead>
          <tbody>
            {executions.map((exec) => (
              <ExecutionRow
                key={exec.id}
                execution={exec}
                navigate={navigate}
              />
            ))}
          </tbody>
        </table>
      </div>
      {/* Pagination Controls */}
      {!loading && executions.length > 0 && (
        <div className="flex items-center justify-end gap-1 mt-3 pt-3 border-t border-[var(--border)]">
          <button
            onClick={() => goToPage(1)}
            disabled={currentPage === 1 || loading}
            className={`rounded-lg border border-[var(--text-main)] p-1.5 hover:bg-[var(--bg-mid)] ${
              currentPage === 1 || loading
                ? "cursor-not-allowed opacity-40"
                : ""
            }`}
            title="First page"
          >
            <img
              src={doubleArrowLeftIcon}
              alt="First"
              className="w-5 h-5"
              style={{
                filter:
                  "brightness(0) saturate(100%) invert(12%) sepia(30%) saturate(1200%) hue-rotate(140deg) brightness(0.31) contrast(1.2)",
              }}
            />
          </button>
          <button
            onClick={prevPage}
            disabled={!hasPrev || loading}
            className={`rounded-lg border border-[var(--text-main)] p-1.5 hover:bg-[var(--bg-mid)] ${
              !hasPrev || loading ? "cursor-not-allowed opacity-40" : ""
            }`}
            title="Previous page"
          >
            <img
              src={arrowLeftIcon}
              alt="Previous"
              className="w-5 h-5"
              style={{
                filter:
                  "brightness(0) saturate(100%) invert(12%) sepia(30%) saturate(1200%) hue-rotate(140deg) brightness(0.31) contrast(1.2)",
              }}
            />
          </button>
          <div className="flex items-center gap-1 mx-1">
            <span className="text-[var(--text-muted)] text-xs">Page</span>
            <input
              type="number"
              min={1}
              max={totalPages || undefined}
              value={pageInput !== "" ? pageInput : currentPage}
              onChange={(e) => setPageInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  const page = parseInt(pageInput, 10);
                  if (
                    !isNaN(page) &&
                    page >= 1 &&
                    (totalPages === null || page <= totalPages)
                  ) {
                    goToPage(page, totalPages || undefined);
                    setPageInput("");
                  }
                }
              }}
              onBlur={() => setPageInput("")}
              className="w-14 rounded-lg border border-[var(--text-main)] px-2 py-1 text-sm text-center text-[var(--text-main)]"
            />
            {totalPages !== null && (
              <span className="text-[var(--text-muted)] text-xs">
                of {totalPages}
              </span>
            )}
          </div>
          <button
            onClick={nextPage}
            disabled={!hasMore || loading}
            className={`rounded-lg border border-[var(--text-main)] p-1.5 hover:bg-[var(--bg-mid)] ${
              !hasMore || loading ? "cursor-not-allowed opacity-40" : ""
            }`}
            title="Next page"
          >
            <img
              src={arrowRightIcon}
              alt="Next"
              className="w-5 h-5"
              style={{
                filter:
                  "brightness(0) saturate(100%) invert(12%) sepia(30%) saturate(1200%) hue-rotate(140deg) brightness(0.31) contrast(1.2)",
              }}
            />
          </button>
          {totalPages !== null && (
            <button
              onClick={() => goToLastPage(totalPages)}
              disabled={currentPage === totalPages || !hasMore || loading}
              className={`rounded-lg border border-[var(--text-main)] p-1.5 hover:bg-[var(--bg-mid)] ${
                currentPage === totalPages || !hasMore || loading
                  ? "cursor-not-allowed opacity-40"
                  : ""
              }`}
              title="Last page"
            >
              <img
                src={doubleArrowRightIcon}
                alt="Last"
                className="w-5 h-5"
                style={{
                  filter:
                    "brightness(0) saturate(100%) invert(12%) sepia(30%) saturate(1200%) hue-rotate(140deg) brightness(0.31) contrast(1.2)",
                }}
              />
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function ExecutionRow({
  execution,
  navigate,
}: {
  execution: ReturnType<typeof useFirestoreScheduleExecutions>["data"][0];
  navigate: ReturnType<typeof useNavigate>;
}) {
  const { runStatus, loading: runStatusLoading } = useRunStatus(
    execution.run_id || null
  );

  // Determine display status - directly reflect the run status
  let displayStatus: string;
  let statusColor: string;

  if (execution.status === "error" || execution.error) {
    displayStatus = "Error";
    statusColor = "text-red-600";
  } else if (runStatusLoading && execution.run_id) {
    displayStatus = "Loading...";
    statusColor = "text-[var(--text-muted)]";
  } else if (runStatus) {
    // Use the actual run status from the integrity run
    // Map "success" to "Healthy" since success means completed with no issues
    const actualStatus =
      runStatus.status === "success" ? "healthy" : runStatus.status;

    // Display the status with proper capitalization
    displayStatus =
      actualStatus.charAt(0).toUpperCase() + actualStatus.slice(1);

    // Color based on status - these are the health statuses when run completes
    if (actualStatus === "running") {
      statusColor = "text-blue-600";
    } else if (actualStatus === "healthy") {
      statusColor = "text-green-600";
    } else if (actualStatus === "warning") {
      statusColor = "text-yellow-600";
    } else if (
      actualStatus === "critical" ||
      actualStatus === "failed" ||
      actualStatus === "error"
    ) {
      statusColor = "text-red-600";
    } else if (actualStatus === "cancelled") {
      statusColor = "text-gray-600";
    } else {
      statusColor = "text-[var(--text-muted)]";
    }
  } else if (execution.status === "started") {
    displayStatus = "Started";
    statusColor = "text-blue-600";
  } else {
    displayStatus = "Unknown";
    statusColor = "text-[var(--text-muted)]";
  }

  return (
    <tr className="border-b border-[var(--border)] hover:bg-[var(--bg-mid)]/30">
      <td className="py-2 px-3 text-[var(--text-main)]">
        {execution.started_at.toDate().toLocaleString("en-US", {
          month: "short",
          day: "numeric",
          year: "numeric",
          hour: "numeric",
          minute: "2-digit",
          hour12: true,
        })}
      </td>
      <td className="py-2 px-3">
        <div className="flex items-center gap-2">
          <span className={statusColor}>{displayStatus}</span>
          {execution.error && (
            <span
              className="text-xs text-red-600"
              title={execution.error.message}
            >
              (
              {execution.error.message.length > 30
                ? execution.error.message.substring(0, 30) + "..."
                : execution.error.message}
              )
            </span>
          )}
        </div>
      </td>
      <td className="py-2 px-3">
        {execution.run_id ? (
          <button
            onClick={() => navigate(`/run/${execution.run_id}`)}
            className="text-[var(--brand)] hover:underline text-sm"
          >
            View Run
          </button>
        ) : (
          <span className="text-[var(--text-muted)] text-xs">—</span>
        )}
      </td>
    </tr>
  );
}

function CreateScheduleModal({
  isOpen,
  groups,
  form,
  setForm,
  onConfirm,
  onCancel,
  isEditing,
}: {
  isOpen: boolean;
  groups: ReturnType<typeof useFirestoreScheduleGroups>["data"];
  form: {
    group_id: string;
    name: string;
    enabled: boolean;
    timezone: string;
    frequency: "daily" | "weekly" | "hourly" | "custom_times";
    time_of_day: string;
    days_of_week: number[];
    interval_minutes?: number;
    times_of_day?: string[];
    entities: string[];
    rules?: {
      duplicates?: Record<string, string[]>;
      relationships?: Record<string, string[]>;
      required_fields?: Record<string, string[]>;
      attendance_rules?: boolean;
    };
    stop_condition_type: "none" | "max_runs" | "stop_at";
    max_runs?: number;
    stop_at?: string;
  };
  setForm: (form: typeof form) => void;
  onConfirm: () => void;
  onCancel: () => void;
  isEditing: boolean;
}) {
  const [selectedEntities, setSelectedEntities] = useState<Set<string>>(
    new Set(
      form.entities.length > 0
        ? form.entities
        : Object.keys(ENTITY_TABLE_MAPPING)
    )
  );
  const [schema, setSchema] = useState<AirtableSchema | null>(null);
  const [schemaLoading, setSchemaLoading] = useState(false);
  const [rules, setRules] = useState<any>(null);
  const [expandedTables, setExpandedTables] = useState<Set<string>>(
    new Set() // Start empty, expand as tables are selected
  );
  const { loadRules, loading: rulesLoading } = useRules();
  const { getToken, loading: authLoading, user: authUser } = useAuth();

  // Fetch schema when modal opens - load from local JSON first for instant display
  useEffect(() => {
    if (!isOpen) return;

    const loadSchema = async () => {
      setSchemaLoading(true);
      try {
        // Try local schema first (instant, no network request)
        const localResponse = await fetch("/airtable-schema.json", {
          cache: "no-store",
        });
        if (localResponse.ok) {
          const localData = await localResponse.json();
          setSchema(localData);
          setSchemaLoading(false);

          // Only refresh from API if auth is ready
          if (!authLoading && authUser) {
            try {
              const token = await getToken();
              const apiResponse = await fetch(`${API_BASE}/airtable/schema`, {
                headers: token ? { Authorization: `Bearer ${token}` } : {},
              });
              if (apiResponse.ok) {
                const apiData = await apiResponse.json();
                setSchema(apiData); // Update with fresh data if available
              }
            } catch (apiError) {
              // Silently fail - we already have local schema
              console.debug("Failed to refresh schema from API:", apiError);
            }
          }
        } else {
          // Fallback to API if local schema not available (wait for auth)
          if (!authLoading && authUser) {
            const token = await getToken();
            const response = await fetch(`${API_BASE}/airtable/schema`, {
              headers: token ? { Authorization: `Bearer ${token}` } : {},
            });
            if (response.ok) {
              const data = await response.json();
              setSchema(data);
            }
          }
          setSchemaLoading(false);
        }
      } catch (error) {
        console.error("Failed to load schema:", error);
        setSchemaLoading(false);
      }
    };

    loadSchema();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, authLoading, authUser]);

  // Validate and clean up rules to remove any that no longer exist
  const validateAndCleanRules = (
    formRules: NonNullable<typeof form.rules>,
    currentRules: any
  ): typeof form.rules => {
    const cleaned: typeof formRules = {};
    let hasChanges = false;

    // Validate duplicates
    if (formRules.duplicates) {
      cleaned.duplicates = {};
      for (const [entity, ruleIds] of Object.entries(formRules.duplicates)) {
        const entityRules = currentRules.duplicates?.[entity];
        if (entityRules) {
          const allRuleIds = new Set<string>();
          // Collect all rule IDs from likely and possible
          if (entityRules.likely) {
            entityRules.likely.forEach((r: any) => allRuleIds.add(r.rule_id));
          }
          if (entityRules.possible) {
            entityRules.possible.forEach((r: any) => allRuleIds.add(r.rule_id));
          }

          const validRuleIds = ruleIds.filter((id) => allRuleIds.has(id));
          if (validRuleIds.length > 0) {
            cleaned.duplicates[entity] = validRuleIds;
          }
          if (validRuleIds.length !== ruleIds.length) {
            hasChanges = true;
          }
        } else {
          hasChanges = true;
        }
      }
      if (Object.keys(cleaned.duplicates).length === 0) {
        delete cleaned.duplicates;
      }
    }

    // Validate relationships
    if (formRules.relationships) {
      cleaned.relationships = {};
      for (const [entity, ruleIds] of Object.entries(formRules.relationships)) {
        const entityRules = currentRules.relationships?.[entity];
        if (entityRules) {
          const existingKeys = new Set(Object.keys(entityRules));
          const validRuleIds = ruleIds.filter((id) => existingKeys.has(id));
          if (validRuleIds.length > 0) {
            cleaned.relationships[entity] = validRuleIds;
          }
          if (validRuleIds.length !== ruleIds.length) {
            hasChanges = true;
          }
        } else {
          hasChanges = true;
        }
      }
      if (Object.keys(cleaned.relationships).length === 0) {
        delete cleaned.relationships;
      }
    }

    // Validate required_fields
    if (formRules.required_fields) {
      cleaned.required_fields = {};
      for (const [entity, ruleIds] of Object.entries(
        formRules.required_fields
      )) {
        const entityRules = currentRules.required_fields?.[entity];
        if (entityRules && Array.isArray(entityRules)) {
          const existingIds = new Set<string>();
          entityRules.forEach((r: any) => {
            existingIds.add(r.field);
            existingIds.add(`required.${entity}.${r.field}`);
            if (r.rule_id) existingIds.add(r.rule_id);
          });

          const validRuleIds = ruleIds.filter((id) => existingIds.has(id));
          if (validRuleIds.length > 0) {
            cleaned.required_fields[entity] = validRuleIds;
          }
          if (validRuleIds.length !== ruleIds.length) {
            hasChanges = true;
          }
        } else {
          hasChanges = true;
        }
      }
      if (Object.keys(cleaned.required_fields).length === 0) {
        delete cleaned.required_fields;
      }
    }

    // Copy attendance_rules as-is (it's just a boolean)
    if (formRules.attendance_rules !== undefined) {
      cleaned.attendance_rules = formRules.attendance_rules;
    }

    // Return cleaned rules or undefined if empty
    if (Object.keys(cleaned).length === 0) {
      return undefined;
    }

    return cleaned;
  };

  // Load rules when modal opens (wait for auth to be ready)
  useEffect(() => {
    // Don't load if modal isn't open, auth is loading, or user isn't authenticated
    if (!isOpen || authLoading || !authUser) return;

    const loadRulesData = async () => {
      try {
        const rulesData = await loadRules();
        setRules(rulesData);

        // Validate and clean up form rules against current rules
        if (rulesData && form.rules) {
          const cleanedRules = validateAndCleanRules(form.rules, rulesData);
          if (cleanedRules !== form.rules) {
            setForm({ ...form, rules: cleanedRules });
          }
        }
      } catch (error) {
        console.error("Failed to load rules:", error);
      }
    };

    loadRulesData();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, authLoading, authUser, loadRules]);

  // Map tables to entities
  const entityTableMap = useMemo(() => {
    if (!schema) return new Map<string, AirtableTable>();

    const map = new Map<string, AirtableTable>();
    for (const table of schema.tables || []) {
      const entity = TABLE_ENTITY_MAPPING[table.name];
      if (entity) {
        map.set(entity, table);
      }
    }
    return map;
  }, [schema]);

  // Get available entities (all active entities that exist in schema, regardless of rules)
  const availableEntities = useMemo(() => {
    const entitiesFromSchema = Array.from(entityTableMap.keys());
    
    // Show all active entities that exist in schema, regardless of rules
    // This ensures entities don't disappear when rules load and allows
    // users to see and select entities even before rules are created
    const activeEntitiesSet = new Set(ACTIVE_ENTITIES);
    return entitiesFromSchema
      .filter((entity) => activeEntitiesSet.has(entity))
      .sort();
  }, [entityTableMap]);

  // Initialize selected entities when schema loads or form changes
  useEffect(() => {
    if (form.entities.length > 0) {
      setSelectedEntities(new Set(form.entities));
    } else if (availableEntities.length > 0 && selectedEntities.size === 0) {
      // Auto-select all if no entities were previously selected
      setSelectedEntities(new Set(availableEntities));
      setForm({ ...form, entities: availableEntities });
    }
  }, [form.entities, availableEntities]);

  // Get all rule IDs for an entity in a category
  const getAllRuleIds = (
    category: "duplicates" | "relationships" | "required_fields",
    entityName: string
  ): string[] => {
    if (!rules) return [];
    const categoryRules = rules[category]?.[entityName];
    if (!categoryRules) return [];

    if (category === "duplicates") {
      const dupDef = categoryRules as { likely?: any[]; possible?: any[] };
      const likelyIds = (dupDef.likely || []).map((r: any) => r.rule_id);
      const possibleIds = (dupDef.possible || []).map((r: any) => r.rule_id);
      return [...likelyIds, ...possibleIds];
    } else if (category === "relationships") {
      return Object.keys(categoryRules);
    } else if (category === "required_fields") {
      return (categoryRules as any[]).map(
        (r: any) => r.rule_id || r.field || `required.${entityName}.${r.field}`
      );
    }
    return [];
  };

  // Check if all rules are selected for a check type across all entities
  const areAllRulesSelectedForCheckType = (
    checkType: "duplicates" | "links" | "required_fields" | "attendance"
  ): boolean => {
    if (checkType === "attendance") {
      return form.rules?.attendance_rules === true;
    }

    const category =
      checkType === "duplicates"
        ? "duplicates"
        : checkType === "links"
        ? "relationships"
        : "required_fields";

    if (selectedEntities.size === 0) return false;
    if (!rules) return false;

    // Check if all entities have all their rules selected
    const allSelected = Array.from(selectedEntities).every((entity) => {
      const allIds = getAllRuleIds(category, entity);
      if (allIds.length === 0) return true; // No rules means "all selected"
      const selectedIds = form.rules?.[category]?.[entity] || [];
      return (
        selectedIds.length === allIds.length &&
        allIds.every((id) => selectedIds.includes(id))
      );
    });

    return allSelected;
  };

  // Check if any rules are selected for a check type (for indeterminate state)
  const areAnyRulesSelectedForCheckType = (
    checkType: "duplicates" | "links" | "required_fields" | "attendance"
  ): boolean => {
    if (checkType === "attendance") {
      return form.rules?.attendance_rules === true;
    }

    const category =
      checkType === "duplicates"
        ? "duplicates"
        : checkType === "links"
        ? "relationships"
        : "required_fields";

    if (selectedEntities.size === 0) return false;
    if (!rules) return false;

    // Check if any entity has any rules selected
    return Array.from(selectedEntities).some((entity) => {
      const selectedIds = form.rules?.[category]?.[entity] || [];
      return selectedIds.length > 0;
    });
  };

  // Check if all rules are selected for a specific table and rule type
  const areAllRulesSelectedForTable = (
    entity: string,
    category: "duplicates" | "relationships" | "required_fields"
  ): boolean => {
    if (!rules) return false;
    const allIds = getAllRuleIds(category, entity);
    if (allIds.length === 0) return true; // No rules means "all selected"
    const selectedIds = form.rules?.[category]?.[entity] || [];
    return (
      selectedIds.length === allIds.length &&
      allIds.every((id) => selectedIds.includes(id))
    );
  };

  // Toggle all rules for a specific table and rule type
  const toggleTableRuleType = (
    entity: string,
    category: "duplicates" | "relationships" | "required_fields"
  ) => {
    const allSelected = areAllRulesSelectedForTable(entity, category);
    const allIds = getAllRuleIds(category, entity);
    const nextRules = { ...form.rules };

    if (allSelected) {
      // Deselect all
      if (nextRules[category]) {
        delete nextRules[category]![entity];
      }
    } else {
      // Select all
      if (!nextRules[category]) {
        nextRules[category] = {};
      }
      nextRules[category]![entity] = allIds;
    }

    setForm({ ...form, rules: nextRules });
  };

  const toggleTableExpansion = (entity: string) => {
    setExpandedTables((prev) => {
      const next = new Set(prev);
      if (next.has(entity)) {
        next.delete(entity);
      } else {
        next.add(entity);
      }
      return next;
    });
  };

  const toggleCheckType = (
    checkName: "duplicates" | "links" | "required_fields" | "attendance"
  ) => {
    const allSelected = areAllRulesSelectedForCheckType(checkName);
    const newValue = !allSelected;

    const nextRules = { ...form.rules };

    // When toggling a check type, select/deselect all its rules
    if (newValue) {
      // Select all rules for this check type
      if (checkName === "duplicates") {
        selectedEntities.forEach((entity) => {
          const ruleIds = getAllRuleIds("duplicates", entity);
          if (ruleIds.length > 0) {
            if (!nextRules.duplicates) nextRules.duplicates = {};
            nextRules.duplicates[entity] = ruleIds;
          }
        });
      } else if (checkName === "links") {
        selectedEntities.forEach((entity) => {
          const ruleIds = getAllRuleIds("relationships", entity);
          if (ruleIds.length > 0) {
            if (!nextRules.relationships) nextRules.relationships = {};
            nextRules.relationships[entity] = ruleIds;
          }
        });
      } else if (checkName === "required_fields") {
        selectedEntities.forEach((entity) => {
          const ruleIds = getAllRuleIds("required_fields", entity);
          if (ruleIds.length > 0) {
            if (!nextRules.required_fields) nextRules.required_fields = {};
            nextRules.required_fields[entity] = ruleIds;
          }
        });
      } else if (checkName === "attendance") {
        nextRules.attendance_rules = true;
      }
    } else {
      // Deselect all rules for this check type
      if (checkName === "duplicates") {
        selectedEntities.forEach((entity) => {
          if (nextRules.duplicates) {
            delete nextRules.duplicates[entity];
          }
        });
      } else if (checkName === "links") {
        selectedEntities.forEach((entity) => {
          if (nextRules.relationships) {
            delete nextRules.relationships[entity];
          }
        });
      } else if (checkName === "required_fields") {
        selectedEntities.forEach((entity) => {
          if (nextRules.required_fields) {
            delete nextRules.required_fields[entity];
          }
        });
      } else if (checkName === "attendance") {
        nextRules.attendance_rules = false;
      }
    }

    setForm({ ...form, rules: nextRules });
  };

  const handleSelectAllCheckTypes = () => {
    const allSelected =
      areAllRulesSelectedForCheckType("duplicates") &&
      areAllRulesSelectedForCheckType("links") &&
      areAllRulesSelectedForCheckType("required_fields") &&
      areAllRulesSelectedForCheckType("attendance");

    if (allSelected) {
      // Deselect all
      toggleCheckType("duplicates");
      toggleCheckType("links");
      toggleCheckType("required_fields");
      toggleCheckType("attendance");
    } else {
      // Select all
      if (!areAllRulesSelectedForCheckType("duplicates")) {
        toggleCheckType("duplicates");
      }
      if (!areAllRulesSelectedForCheckType("links")) {
        toggleCheckType("links");
      }
      if (!areAllRulesSelectedForCheckType("required_fields")) {
        toggleCheckType("required_fields");
      }
      if (!areAllRulesSelectedForCheckType("attendance")) {
        toggleCheckType("attendance");
      }
    }
  };

  // Initialize rules for an entity (select all by default)
  const initializeRulesForEntity = (entity: string) => {
    if (!rules) return;

    setForm({
      ...form,
      rules: {
        ...form.rules,
        duplicates: {
          ...form.rules?.duplicates,
          [entity]: getAllRuleIds("duplicates", entity),
        },
        relationships: {
          ...form.rules?.relationships,
          [entity]: getAllRuleIds("relationships", entity),
        },
        required_fields: {
          ...form.rules?.required_fields,
          [entity]: getAllRuleIds("required_fields", entity),
        },
      },
    });
  };

  // Remove rules for an entity
  const removeRulesForEntity = (entity: string) => {
    const nextRules = { ...form.rules };
    if (nextRules?.duplicates) {
      delete nextRules.duplicates[entity];
    }
    if (nextRules?.relationships) {
      delete nextRules.relationships[entity];
    }
    if (nextRules?.required_fields) {
      delete nextRules.required_fields[entity];
    }
    setForm({ ...form, rules: nextRules });
  };

  if (!isOpen) return null;

  const handleEntityToggle = (entity: string) => {
    const next = new Set(selectedEntities);
    if (next.has(entity)) {
      next.delete(entity);
      removeRulesForEntity(entity);
      setExpandedTables((prevTables) => {
        const nextTables = new Set(prevTables);
        nextTables.delete(entity);
        return nextTables;
      });
    } else {
      next.add(entity);
      initializeRulesForEntity(entity);
      // Auto-expand when table is selected
      setExpandedTables((prevTables) => {
        const nextTables = new Set(prevTables);
        nextTables.add(entity);
        return nextTables;
      });
    }
    setSelectedEntities(next);
    setForm({ ...form, entities: Array.from(next) });
  };

  const handleRulesChange = (
    category:
      | "duplicates"
      | "relationships"
      | "required_fields"
      | "attendance_rules",
    entity: string,
    ruleIds: string[] | boolean
  ) => {
    const nextRules = { ...form.rules };
    if (category === "attendance_rules") {
      nextRules.attendance_rules = ruleIds as boolean;
    } else {
      if (!nextRules[category]) {
        nextRules[category] = {};
      }
      nextRules[category]![entity] = ruleIds as string[];
    }
    setForm({ ...form, rules: nextRules });
  };

  const handleSelectAllEntities = () => {
    if (selectedEntities.size === availableEntities.length) {
      setSelectedEntities(new Set());
      setForm({ ...form, entities: [] });
    } else {
      setSelectedEntities(new Set(availableEntities));
      setForm({ ...form, entities: availableEntities });
    }
  };

  // Check if at least one rule is selected (not all rules, just at least one)
  const hasAtLeastOneCheck = (() => {
    if (form.rules?.attendance_rules === true) return true;

    // Check if any entity has any rules selected for any category
    if (form.rules?.duplicates) {
      for (const entity in form.rules.duplicates) {
        if (form.rules.duplicates?.[entity]?.length > 0) return true;
      }
    }
    if (form.rules?.relationships) {
      for (const entity in form.rules.relationships) {
        if (form.rules.relationships?.[entity]?.length > 0) return true;
      }
    }
    if (form.rules?.required_fields) {
      for (const entity in form.rules.required_fields) {
        if (form.rules.required_fields?.[entity]?.length > 0) return true;
      }
    }
    return false;
  })();

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center p-4 sm:p-0">
      <div
        className="fixed inset-0 bg-neutral-900/50 backdrop-blur-sm transition-opacity"
        onClick={onCancel}
        aria-hidden="true"
      />
      <div className="relative bg-white border border-[var(--border)] rounded-xl shadow-xl w-full max-w-5xl transform transition-all p-6 max-h-[90vh] overflow-y-auto">
        <h3 className="text-xl font-semibold text-[var(--text-main)] mb-4">
          {isEditing ? "Edit Schedule" : "Create Schedule"}
        </h3>

        {/* Schedule Settings Section */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6 mb-6 pb-6 border-b border-[var(--border)]">
          {/* Left Column: Group & Schedule Info */}
          <div className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-[var(--text-main)] mb-2">
                Group
              </label>
              <select
                value={form.group_id}
                onChange={(e) => setForm({ ...form, group_id: e.target.value })}
                className="w-full px-3 py-2 border border-[var(--border)] rounded-lg bg-white text-[var(--text-main)]"
                required
              >
                <option value="">Select a group</option>
                {groups.map((group) => (
                  <option key={group.id} value={group.id}>
                    {group.name}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label className="block text-sm font-medium text-[var(--text-main)] mb-2">
                Name
              </label>
              <input
                type="text"
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
                className="w-full px-3 py-2 border border-[var(--border)] rounded-lg bg-white text-[var(--text-main)]"
                placeholder="e.g., Nightly Scan"
                required
              />
            </div>

            <div>
              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={form.enabled}
                  onChange={(e) =>
                    setForm({ ...form, enabled: e.target.checked })
                  }
                  className="w-4 h-4"
                />
                <span className="text-sm font-medium text-[var(--text-main)]">
                  Enabled
                </span>
              </label>
            </div>
          </div>

          {/* Right Column: Frequency, Time, Timezone */}
          <div className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-[var(--text-main)] mb-2">
                Frequency
              </label>
              <select
                value={form.frequency}
                onChange={(e) => {
                  const newFreq = e.target.value as typeof form.frequency;

                  // Get current time in the form's timezone for frequencies that need time_of_day
                  const getCurrentTime = () => {
                    const now = new Date();
                    const parts = new Intl.DateTimeFormat("en-US", {
                      timeZone: form.timezone,
                      hour12: false,
                      hour: "2-digit",
                      minute: "2-digit",
                    }).formatToParts(now);

                    const hour =
                      parts.find((p) => p.type === "hour")?.value || "00";
                    const minute =
                      parts.find((p) => p.type === "minute")?.value || "00";
                    return `${hour}:${minute}`;
                  };

                  // Auto-set time_of_day for frequencies that use it
                  const needsTimeOfDay =
                    newFreq === "daily" ||
                    newFreq === "weekly" ||
                    newFreq === "custom_times";
                  const newTimeOfDay = needsTimeOfDay
                    ? getCurrentTime()
                    : form.time_of_day;

                  setForm({
                    ...form,
                    frequency: newFreq,
                    time_of_day: newTimeOfDay,
                    // Reset frequency-specific fields when changing
                    days_of_week: newFreq === "weekly" ? form.days_of_week : [],
                    interval_minutes:
                      newFreq === "hourly" ? form.interval_minutes : undefined,
                    times_of_day:
                      newFreq === "custom_times"
                        ? form.times_of_day
                        : undefined,
                  });
                }}
                className="w-full px-3 py-2 border border-[var(--border)] rounded-lg bg-white text-[var(--text-main)]"
              >
                <option value="daily">Daily</option>
                <option value="weekly">Weekly</option>
                <option value="hourly">Hourly (Every X minutes)</option>
                <option value="custom_times">
                  Custom Times (Multiple times per day)
                </option>
              </select>
            </div>

            {form.frequency === "weekly" && (
              <div>
                <label className="block text-sm font-medium text-[var(--text-main)] mb-2">
                  Days of Week
                </label>
                <div className="space-y-2 border border-[var(--border)] rounded-lg p-3 max-h-48 overflow-y-auto">
                  {DAYS_OF_WEEK.map((day) => (
                    <label
                      key={day.value}
                      className="flex items-center gap-2 cursor-pointer hover:bg-[var(--bg-mid)]/50 p-2 rounded"
                    >
                      <input
                        type="checkbox"
                        checked={form.days_of_week.includes(day.value)}
                        onChange={(e) => {
                          const next = e.target.checked
                            ? [...form.days_of_week, day.value]
                            : form.days_of_week.filter((d) => d !== day.value);
                          setForm({ ...form, days_of_week: next });
                        }}
                        className="w-4 h-4"
                      />
                      <span className="text-sm text-[var(--text-main)]">
                        {day.label}
                      </span>
                    </label>
                  ))}
                </div>
              </div>
            )}

            {form.frequency === "hourly" && (
              <div>
                <label className="block text-sm font-medium text-[var(--text-main)] mb-2">
                  Interval (minutes)
                </label>
                <input
                  type="number"
                  min="1"
                  max="1440"
                  value={form.interval_minutes ?? ""}
                  onChange={(e) => {
                    const value = e.target.value;
                    setForm({
                      ...form,
                      interval_minutes:
                        value === "" ? undefined : parseInt(value) || undefined,
                    });
                  }}
                  className="w-full px-3 py-2 border border-[var(--border)] rounded-lg bg-white text-[var(--text-main)]"
                  required
                />
                <p className="text-xs text-[var(--text-muted)] mt-1">
                  Run every X minutes (e.g., 15, 30, 60)
                </p>
              </div>
            )}

            {form.frequency === "custom_times" && (
              <div>
                <label className="block text-sm font-medium text-[var(--text-main)] mb-2">
                  Times of Day
                </label>
                <div className="space-y-2">
                  {form.times_of_day?.map((time, idx) => (
                    <div
                      key={idx}
                      className="flex items-center gap-2 p-2 border border-[var(--border)] rounded-lg"
                    >
                      <input
                        type="time"
                        value={time}
                        onChange={(e) => {
                          const newTimes = [...(form.times_of_day || [])];
                          newTimes[idx] = e.target.value;
                          setForm({ ...form, times_of_day: newTimes });
                        }}
                        className="flex-1 px-3 py-2 border border-[var(--border)] rounded-lg bg-white text-[var(--text-main)]"
                      />
                      <button
                        type="button"
                        onClick={() => {
                          const newTimes = form.times_of_day?.filter(
                            (_, i) => i !== idx
                          );
                          setForm({ ...form, times_of_day: newTimes || [] });
                        }}
                        className="px-3 py-2 text-sm font-medium text-red-600 hover:bg-red-50 rounded-lg transition-colors"
                      >
                        Remove
                      </button>
                    </div>
                  ))}
                  <button
                    type="button"
                    onClick={() => {
                      setForm({
                        ...form,
                        times_of_day: [...(form.times_of_day || []), "14:00"],
                      });
                    }}
                    className="w-full px-3 py-2 text-sm font-medium text-[var(--brand)] border border-[var(--brand)] rounded-lg hover:bg-[var(--brand)]/5 transition-colors"
                  >
                    Add Time
                  </button>
                </div>
              </div>
            )}

            {form.frequency === "daily" && (
              <div>
                <label className="block text-sm font-medium text-[var(--text-main)] mb-2">
                  Time of Day
                </label>
                <input
                  type="time"
                  value={form.time_of_day}
                  onChange={(e) =>
                    setForm({ ...form, time_of_day: e.target.value })
                  }
                  className="w-full px-3 py-2 border border-[var(--border)] rounded-lg bg-white text-[var(--text-main)]"
                  required
                />
              </div>
            )}

            <div>
              <label className="block text-sm font-medium text-[var(--text-main)] mb-2">
                Timezone
              </label>
              <select
                value={form.timezone}
                onChange={(e) => setForm({ ...form, timezone: e.target.value })}
                className="w-full px-3 py-2 border border-[var(--border)] rounded-lg bg-white text-[var(--text-main)]"
              >
                {TIMEZONES.map((tz) => (
                  <option key={tz.value} value={tz.value}>
                    {tz.label}
                  </option>
                ))}
              </select>
            </div>

            {(form.frequency === "hourly" ||
              form.frequency === "custom_times") && (
              <div>
                <label className="block text-sm font-medium text-[var(--text-main)] mb-2">
                  Stop Condition
                </label>
                <div className="space-y-3">
                  <label className="flex items-center gap-2 cursor-pointer">
                    <input
                      type="radio"
                      name="stop_condition"
                      checked={form.stop_condition_type === "none"}
                      onChange={() =>
                        setForm({ ...form, stop_condition_type: "none" })
                      }
                      className="w-4 h-4"
                    />
                    <span className="text-sm text-[var(--text-main)]">
                      No stop condition
                    </span>
                  </label>
                  <label className="flex items-center gap-2 cursor-pointer">
                    <input
                      type="radio"
                      name="stop_condition"
                      checked={form.stop_condition_type === "max_runs"}
                      onChange={() =>
                        setForm({ ...form, stop_condition_type: "max_runs" })
                      }
                      className="w-4 h-4"
                    />
                    <span className="text-sm text-[var(--text-main)]">
                      Stop after X runs
                    </span>
                  </label>
                  {form.stop_condition_type === "max_runs" && (
                    <div className="ml-6">
                      <input
                        type="number"
                        min="1"
                        value={form.max_runs ?? ""}
                        onChange={(e) => {
                          const value = e.target.value;
                          setForm({
                            ...form,
                            max_runs:
                              value === ""
                                ? undefined
                                : parseInt(value) || undefined,
                          });
                        }}
                        className="w-full px-3 py-2 border border-[var(--border)] rounded-lg bg-white text-[var(--text-main)]"
                        placeholder="Number of runs"
                      />
                    </div>
                  )}
                  <label className="flex items-center gap-2 cursor-pointer">
                    <input
                      type="radio"
                      name="stop_condition"
                      checked={form.stop_condition_type === "stop_at"}
                      onChange={() =>
                        setForm({ ...form, stop_condition_type: "stop_at" })
                      }
                      className="w-4 h-4"
                    />
                    <span className="text-sm text-[var(--text-main)]">
                      Stop at time
                    </span>
                  </label>
                  {form.stop_condition_type === "stop_at" && (
                    <div className="ml-6">
                      <input
                        type="datetime-local"
                        value={form.stop_at ?? ""}
                        onChange={(e) =>
                          setForm({ ...form, stop_at: e.target.value })
                        }
                        className="w-full px-3 py-2 border border-[var(--border)] rounded-lg bg-white text-[var(--text-main)]"
                      />
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Scan Configuration Section */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          {/* Left Column - Table/Entity Selection */}
          <div>
            <div>
              <div className="flex items-center justify-between mb-3">
                <label className="block text-sm font-medium text-[var(--text-main)]">
                  Select Tables ({selectedEntities.size} of{" "}
                  {availableEntities.length})
                </label>
                {availableEntities.length > 0 && (
                  <button
                    onClick={handleSelectAllEntities}
                    className="text-sm text-[var(--brand)] hover:underline"
                    type="button"
                  >
                    {selectedEntities.size === availableEntities.length
                      ? "Deselect All"
                      : "Select All"}
                  </button>
                )}
              </div>
              {schemaLoading ? (
                <div className="text-sm text-[var(--text-muted)] py-4 text-center">
                  Loading tables...
                </div>
              ) : availableEntities.length === 0 ? (
                <div className="text-sm text-[var(--text-muted)] py-4 text-center">
                  No tables found. Please check your schema configuration.
                </div>
              ) : (
                <div className="max-h-[600px] overflow-y-auto space-y-2 border border-[var(--border)] rounded-lg p-3">
                  {availableEntities.map((entity) => {
                    const table = entityTableMap.get(entity);
                    return (
                      <label
                        key={entity}
                        className="flex items-center gap-3 p-2 rounded-lg hover:bg-[var(--bg-mid)]/50 cursor-pointer"
                      >
                        <input
                          type="checkbox"
                          checked={selectedEntities.has(entity)}
                          onChange={() => handleEntityToggle(entity)}
                          className="w-4 h-4"
                        />
                        <div className="flex-1 min-w-0">
                          <div className="font-medium text-sm text-[var(--text-main)]">
                            {ENTITY_TABLE_MAPPING[entity] || entity}
                          </div>
                          <div className="text-xs text-[var(--text-muted)]">
                            {entity} • {table?.recordCount ?? 0} records •{" "}
                            {table?.fieldCount ?? 0} fields
                          </div>
                        </div>
                      </label>
                    );
                  })}
                </div>
              )}
              {selectedEntities.size === 0 && (
                <p className="mt-2 text-sm text-red-600">
                  Please select at least one table
                </p>
              )}
            </div>
          </div>

          {/* Right Column - Tables with Nested Rules */}
          <div className="space-y-6">
            <div>
              <div className="flex items-center justify-between mb-3">
                <label className="block text-sm font-medium text-[var(--text-main)]">
                  Rules by Table
                </label>
                {selectedEntities.size > 0 && rules && (
                  <button
                    onClick={handleSelectAllCheckTypes}
                    className="text-sm text-[var(--brand)] hover:underline"
                    type="button"
                  >
                    {areAllRulesSelectedForCheckType("duplicates") &&
                    areAllRulesSelectedForCheckType("links") &&
                    areAllRulesSelectedForCheckType("required_fields") &&
                    areAllRulesSelectedForCheckType("attendance")
                      ? "Deselect All"
                      : "Select All"}
                  </button>
                )}
              </div>
              {selectedEntities.size === 0 ? (
                <div className="text-sm text-[var(--text-muted)] py-8 text-center border border-[var(--border)] rounded-lg">
                  Please select a table to see available rules
                </div>
              ) : !rules ? (
                <div className="text-sm text-[var(--text-muted)] py-8 text-center border border-[var(--border)] rounded-lg">
                  Loading rules...
                </div>
              ) : (
                <div className="space-y-4 max-h-[600px] overflow-y-auto">
                  {Array.from(selectedEntities).map((entity) => {
                    const table = entityTableMap.get(entity);
                    const isExpanded = expandedTables.has(entity);

                    return (
                      <div
                        key={entity}
                        className="border border-[var(--border)] rounded-lg"
                      >
                        {/* Table Header */}
                        <div className="flex items-center p-3 hover:bg-[var(--bg-mid)]/50 transition-colors">
                          <button
                            type="button"
                            onClick={() => toggleTableExpansion(entity)}
                            className="mr-2 px-2 py-1 text-sm font-medium text-[var(--text-muted)] hover:text-[var(--text-main)] hover:bg-[var(--bg-mid)]/30 rounded transition-colors"
                            aria-label={
                              isExpanded ? "Collapse table" : "Expand table"
                            }
                          >
                            {isExpanded ? "▼" : "▶"}
                          </button>
                          <div className="flex-1">
                            <div className="font-medium text-[var(--text-main)]">
                              {ENTITY_TABLE_MAPPING[entity] || entity}
                            </div>
                            <div className="text-xs text-[var(--text-muted)]">
                              {table?.recordCount ?? 0} records •{" "}
                              {table?.fieldCount ?? 0} fields
                            </div>
                          </div>
                        </div>

                        {isExpanded && (
                          <div className="px-3 pb-3 pt-2 space-y-4 border-t border-[var(--border)] bg-[var(--bg-mid)]/20">
                            {/* Duplicate Detection Rules */}
                            {(() => {
                              const dupDef = rules?.duplicates?.[entity] as
                                | { likely?: any[]; possible?: any[] }
                                | undefined;
                              if (!dupDef) return null;

                              const likelyRules = dupDef.likely || [];
                              const possibleRules = dupDef.possible || [];
                              const allRuleIds = getAllRuleIds(
                                "duplicates",
                                entity
                              );
                              const selectedIds =
                                form.rules?.duplicates?.[entity] || [];

                              if (allRuleIds.length === 0) return null;

                              return (
                                <div className="space-y-2">
                                  <div className="flex items-center justify-between">
                                    <div className="text-sm font-medium text-[var(--text-main)]">
                                      Duplicate Detection
                                    </div>
                                    <button
                                      type="button"
                                      onClick={() =>
                                        toggleTableRuleType(
                                          entity,
                                          "duplicates"
                                        )
                                      }
                                      className="text-xs text-[var(--brand)] hover:underline"
                                    >
                                      {areAllRulesSelectedForTable(
                                        entity,
                                        "duplicates"
                                      )
                                        ? "Deselect All"
                                        : "Select All"}
                                    </button>
                                  </div>
                                  {likelyRules.length > 0 && (
                                    <div className="ml-2 space-y-1">
                                      <div className="text-xs font-medium text-[var(--text-muted)] mb-1.5">
                                        Likely
                                      </div>
                                      {likelyRules.map((rule: any) => (
                                        <label
                                          key={rule.rule_id}
                                          className="flex items-center gap-2 p-2 rounded-md hover:bg-[var(--bg-mid)]/40 cursor-pointer transition-colors"
                                        >
                                          <input
                                            type="checkbox"
                                            checked={selectedIds.includes(
                                              rule.rule_id
                                            )}
                                            onChange={() =>
                                              handleRulesChange(
                                                "duplicates",
                                                entity,
                                                selectedIds.includes(
                                                  rule.rule_id
                                                )
                                                  ? selectedIds.filter(
                                                      (id) =>
                                                        id !== rule.rule_id
                                                    )
                                                  : [
                                                      ...selectedIds,
                                                      rule.rule_id,
                                                    ]
                                              )
                                            }
                                            className="w-3.5 h-3.5"
                                          />
                                          <div className="flex-1 min-w-0">
                                            <div className="text-xs font-medium text-[var(--text-main)]">
                                              {rule.rule_id}
                                            </div>
                                            <div className="text-xs text-[var(--text-muted)] truncate">
                                              {rule.description || ""}
                                            </div>
                                          </div>
                                        </label>
                                      ))}
                                    </div>
                                  )}
                                  {possibleRules.length > 0 && (
                                    <div className="ml-2 mt-3 space-y-1">
                                      <div className="text-xs font-medium text-[var(--text-muted)] mb-1.5">
                                        Possible
                                      </div>
                                      {possibleRules.map((rule: any) => (
                                        <label
                                          key={rule.rule_id}
                                          className="flex items-center gap-2 p-2 rounded-md hover:bg-[var(--bg-mid)]/40 cursor-pointer transition-colors"
                                        >
                                          <input
                                            type="checkbox"
                                            checked={selectedIds.includes(
                                              rule.rule_id
                                            )}
                                            onChange={() =>
                                              handleRulesChange(
                                                "duplicates",
                                                entity,
                                                selectedIds.includes(
                                                  rule.rule_id
                                                )
                                                  ? selectedIds.filter(
                                                      (id) =>
                                                        id !== rule.rule_id
                                                    )
                                                  : [
                                                      ...selectedIds,
                                                      rule.rule_id,
                                                    ]
                                              )
                                            }
                                            className="w-3.5 h-3.5"
                                          />
                                          <div className="flex-1 min-w-0">
                                            <div className="text-xs font-medium text-[var(--text-main)]">
                                              {rule.rule_id}
                                            </div>
                                            <div className="text-xs text-[var(--text-muted)] truncate">
                                              {rule.description || ""}
                                            </div>
                                          </div>
                                        </label>
                                      ))}
                                    </div>
                                  )}
                                </div>
                              );
                            })()}

                            {/* Relationship Rules */}
                            {(() => {
                              const relRules = rules?.relationships?.[entity];
                              if (
                                !relRules ||
                                Object.keys(relRules).length === 0
                              )
                                return null;

                              const selectedIds =
                                form.rules?.relationships?.[entity] || [];

                              return (
                                <div className="space-y-2">
                                  <div className="flex items-center justify-between">
                                    <div className="text-sm font-medium text-[var(--text-main)]">
                                      Relationship Rules
                                    </div>
                                    <button
                                      type="button"
                                      onClick={() =>
                                        toggleTableRuleType(
                                          entity,
                                          "relationships"
                                        )
                                      }
                                      className="text-xs text-[var(--brand)] hover:underline"
                                    >
                                      {areAllRulesSelectedForTable(
                                        entity,
                                        "relationships"
                                      )
                                        ? "Deselect All"
                                        : "Select All"}
                                    </button>
                                  </div>
                                  <div className="ml-2 space-y-1">
                                    {Object.entries(relRules).map(
                                      ([relKey, relRule]: [string, any]) => (
                                        <label
                                          key={relKey}
                                          className="flex items-center gap-2 p-2 rounded-md hover:bg-[var(--bg-mid)]/40 cursor-pointer transition-colors"
                                        >
                                          <input
                                            type="checkbox"
                                            checked={selectedIds.includes(
                                              relKey
                                            )}
                                            onChange={() =>
                                              handleRulesChange(
                                                "relationships",
                                                entity,
                                                selectedIds.includes(relKey)
                                                  ? selectedIds.filter(
                                                      (id) => id !== relKey
                                                    )
                                                  : [...selectedIds, relKey]
                                              )
                                            }
                                            className="w-3.5 h-3.5"
                                          />
                                          <div className="flex-1 min-w-0">
                                            <div className="text-xs font-medium text-[var(--text-main)]">
                                              {relKey}
                                            </div>
                                            <div className="text-xs text-[var(--text-muted)] truncate">
                                              {relRule.message || ""}
                                            </div>
                                          </div>
                                        </label>
                                      )
                                    )}
                                  </div>
                                </div>
                              );
                            })()}

                            {/* Required Field Rules */}
                            {(() => {
                              const reqFields =
                                rules?.required_fields?.[entity];
                              if (
                                !reqFields ||
                                !Array.isArray(reqFields) ||
                                reqFields.length === 0
                              )
                                return null;

                              const selectedIds =
                                form.rules?.required_fields?.[entity] || [];

                              return (
                                <div className="space-y-2">
                                  <div className="flex items-center justify-between">
                                    <div className="text-sm font-medium text-[var(--text-main)]">
                                      Required Field Rules
                                    </div>
                                    <button
                                      type="button"
                                      onClick={() =>
                                        toggleTableRuleType(
                                          entity,
                                          "required_fields"
                                        )
                                      }
                                      className="text-xs text-[var(--brand)] hover:underline"
                                    >
                                      {areAllRulesSelectedForTable(
                                        entity,
                                        "required_fields"
                                      )
                                        ? "Deselect All"
                                        : "Select All"}
                                    </button>
                                  </div>
                                  <div className="ml-2 space-y-1">
                                    {reqFields.map((field: any) => {
                                      const ruleId =
                                        field.rule_id ||
                                        field.field ||
                                        `required.${entity}.${field.field}`;
                                      return (
                                        <label
                                          key={ruleId}
                                          className="flex items-center gap-2 p-2 rounded-md hover:bg-[var(--bg-mid)]/40 cursor-pointer transition-colors"
                                        >
                                          <input
                                            type="checkbox"
                                            checked={selectedIds.includes(
                                              ruleId
                                            )}
                                            onChange={() =>
                                              handleRulesChange(
                                                "required_fields",
                                                entity,
                                                selectedIds.includes(ruleId)
                                                  ? selectedIds.filter(
                                                      (id) => id !== ruleId
                                                    )
                                                  : [...selectedIds, ruleId]
                                              )
                                            }
                                            className="w-3.5 h-3.5"
                                          />
                                          <div className="flex-1 min-w-0">
                                            <div className="text-xs font-medium text-[var(--text-main)]">
                                              {field.field || ruleId}
                                            </div>
                                            <div className="text-xs text-[var(--text-muted)] truncate">
                                              {field.message || ""}
                                            </div>
                                          </div>
                                        </label>
                                      );
                                    })}
                                  </div>
                                </div>
                              );
                            })()}

                            {/* Attendance Rules (only for attendance table) */}
                            {entity === "attendance" &&
                              selectedEntities.has("attendance") &&
                              rules?.attendance_rules && (
                                <div className="space-y-2">
                                  <div className="text-sm font-medium text-[var(--text-main)]">
                                    Attendance Rules
                                  </div>
                                  <label className="flex items-center gap-2 p-2 rounded-md hover:bg-[var(--bg-mid)]/40 cursor-pointer transition-colors">
                                    <input
                                      type="checkbox"
                                      checked={
                                        form.rules?.attendance_rules ?? false
                                      }
                                      onChange={(e) =>
                                        handleRulesChange(
                                          "attendance_rules",
                                          "",
                                          e.target.checked
                                        )
                                      }
                                      className="w-3.5 h-3.5"
                                    />
                                    <span className="text-xs font-medium text-[var(--text-main)]">
                                      Attendance Anomalies
                                    </span>
                                  </label>
                                </div>
                              )}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
              {selectedEntities.size > 0 && rules && !hasAtLeastOneCheck && (
                <p className="mt-2 text-sm text-red-600">
                  Please select at least one rule
                </p>
              )}
            </div>
          </div>
        </div>

        <div className="flex justify-end space-x-3 mt-6">
          <button
            onClick={onCancel}
            className="px-4 py-2 text-sm font-medium text-[var(--text-muted)] hover:text-[var(--text-main)] bg-[var(--bg-mid)]/50 hover:bg-[var(--bg-mid)] rounded-lg transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={onConfirm}
            disabled={
              !form.group_id ||
              !form.name.trim() ||
              (form.frequency === "weekly" && form.days_of_week.length === 0) ||
              (form.frequency === "hourly" &&
                (!form.interval_minutes || form.interval_minutes < 1)) ||
              (form.frequency === "custom_times" &&
                (!form.times_of_day || form.times_of_day.length === 0))
            }
            className="px-4 py-2 text-sm font-medium text-white rounded-lg transition-colors shadow-sm bg-[var(--brand)] hover:bg-[var(--brand)]/90 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {isEditing ? "Update" : "Create"}
          </button>
        </div>
      </div>
    </div>
  );
}
