import { useEffect, useState } from "react";
import {
  collection,
  query,
  orderBy,
  where,
  onSnapshot,
  addDoc,
  updateDoc,
  deleteDoc,
  doc,
  Timestamp,
} from "firebase/firestore";
import { db } from "../config/firebase";
import { useAuth } from "./useAuth";

export interface ScheduleRunConfig {
  entities?: string[];
  rules?: {
    duplicates?: Record<string, string[]>;  // entity -> rule_ids[]
    relationships?: Record<string, string[]>;  // entity -> rule_ids[]
    required_fields?: Record<string, string[]>;  // entity -> rule_ids[]
    attendance_rules?: boolean;  // true/false (not per-entity)
  };
}

export interface Schedule {
  id: string;
  group_id: string;
  name: string;
  enabled: boolean;
  timezone: string;
  frequency: "daily" | "weekly" | "hourly" | "custom_times";
  time_of_day: string;
  days_of_week?: number[];
  interval_minutes?: number; // for hourly frequency
  times_of_day?: string[]; // for custom_times frequency
  run_config: ScheduleRunConfig;
  notify_slack?: boolean; // Optional: send Slack notification on completion
  next_run_at: Timestamp;
  last_run_at?: Timestamp;
  last_run_id?: string;
  stop_at?: Timestamp; // Stop scheduling after this time
  max_runs?: number; // Stop after this many runs
  run_count?: number; // Track number of runs
  lock?: {
    locked_at: Timestamp;
    locked_by: string;
  };
  created_at: Timestamp;
  updated_at: Timestamp;
  created_by: string;
  updated_by: string;
}

export function useFirestoreSchedules(groupId?: string) {
  const [schedules, setSchedules] = useState<Schedule[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const { user } = useAuth();

  useEffect(() => {
    const schedulesRef = collection(db, "schedules");
    let q = query(schedulesRef, orderBy("created_at", "desc"));

    if (groupId) {
      q = query(
        schedulesRef,
        where("group_id", "==", groupId),
        orderBy("created_at", "desc")
      );
    }

    const unsubscribe = onSnapshot(
      q,
      (snapshot) => {
        try {
          const transformed: Schedule[] = snapshot.docs.map((doc) => ({
            id: doc.id,
            ...doc.data(),
          })) as Schedule[];
          setSchedules(transformed);
          setLoading(false);
          setError(null);
        } catch (err) {
          const errorMsg =
            err instanceof Error ? err.message : "Failed to process schedules";
          console.error("Error processing schedules:", errorMsg, err);
          setError(errorMsg);
          setLoading(false);
        }
      },
      (err) => {
        console.error("Firestore subscription error:", err);
        setError(err.message);
        setLoading(false);
      }
    );

    return () => unsubscribe();
  }, [groupId]);

  const createSchedule = async (scheduleData: {
    group_id: string;
    name: string;
    enabled: boolean;
    timezone: string;
    frequency: "daily" | "weekly" | "hourly" | "custom_times";
    time_of_day: string;
    days_of_week?: number[];
    interval_minutes?: number;
    times_of_day?: string[];
    run_config: ScheduleRunConfig;
    notify_slack?: boolean;
    next_run_at: Timestamp;
    stop_at?: Timestamp;
    max_runs?: number;
    run_count?: number;
  }) => {
    if (!user) throw new Error("User not authenticated");

    const now = Timestamp.now();
    const schedule = {
      ...scheduleData,
      created_at: now,
      updated_at: now,
      created_by: user.uid,
      updated_by: user.uid,
    };

    const docRef = await addDoc(collection(db, "schedules"), schedule);
    return docRef.id;
  };

  const updateSchedule = async (
    scheduleId: string,
    updates: Partial<
      Pick<
        Schedule,
        | "name"
        | "enabled"
        | "timezone"
        | "frequency"
        | "time_of_day"
        | "days_of_week"
        | "interval_minutes"
        | "times_of_day"
        | "run_config"
        | "notify_slack"
        | "next_run_at"
        | "stop_at"
        | "max_runs"
        | "run_count"
      >
    >
  ) => {
    if (!user) throw new Error("User not authenticated");

    const scheduleRef = doc(db, "schedules", scheduleId);
    await updateDoc(scheduleRef, {
      ...updates,
      updated_at: Timestamp.now(),
      updated_by: user.uid,
    });
  };

  const deleteSchedule = async (scheduleId: string) => {
    const scheduleRef = doc(db, "schedules", scheduleId);
    await deleteDoc(scheduleRef);
  };

  return {
    data: schedules,
    loading,
    error,
    createSchedule,
    updateSchedule,
    deleteSchedule,
  };
}
