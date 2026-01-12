import { useState, useEffect, useMemo } from "react";
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from "recharts";

// Custom dot component that appears progressively as line passes each point
// The line animation takes 800ms, dots appear at their position-based timing
const AnimatedDot = (props: any) => {
  const { cx, cy, fill, r = 4, index, totalPoints } = props;
  const lineAnimationDuration = 800; // ms
  const dotAnimationDuration = 0.3; // seconds

  // Calculate delay based on position: dot at index i appears at (i / N) * duration
  const delay =
    totalPoints > 0 ? (index / totalPoints) * lineAnimationDuration : 0;
  const delaySeconds = delay / 1000;

  return (
    <circle
      cx={cx}
      cy={cy}
      r={r}
      fill={fill}
      style={{
        opacity: 0,
        transform: "scale(0)",
        animation: `fadeInDot ${dotAnimationDuration}s ease-out ${delaySeconds}s forwards`,
      }}
    />
  );
};

type TrendDataItem = {
  day: string;
  [key: string]: string | number;
};

type IssueTrendChartProps = {
  data: TrendDataItem[];
  loading?: boolean;
  error?: string | null;
  height?: string;
};

export function IssueTrendChart({
  data,
  loading = false,
  error = null,
  height = "h-80",
}: IssueTrendChartProps) {
  // Extract all unique issue types from the trend data to create lines
  const issueTypes = useMemo(() => {
    const types = Array.from(
      new Set(
        data.flatMap((item) => Object.keys(item).filter((key) => key !== "day" && key !== "total"))
      )
    );
    return types;
  }, [data]);

  // State to track which issue types are enabled/disabled
  const [enabledTypes, setEnabledTypes] = useState<Set<string>>(() => {
    // All types enabled by default
    return new Set(issueTypes);
  });

  // Update enabled types when issueTypes change
  useEffect(() => {
    setEnabledTypes((prev) => {
      const newSet = new Set(prev);
      // Add any new types
      issueTypes.forEach((type) => newSet.add(type));
      // Remove types that no longer exist
      Array.from(newSet).forEach((type) => {
        if (!issueTypes.includes(type)) {
          newSet.delete(type);
        }
      });
      return newSet;
    });
  }, [issueTypes]);

  // State to track preserved Y-axis domain when last line is disabled
  const [preservedYDomain, setPreservedYDomain] = useState<
    [number, number] | null
  >(null);

  // Calculate Y-axis domain from visible enabled lines data
  const calculatedYDomain = useMemo(() => {
    if (data.length === 0 || enabledTypes.size === 0) {
      return null;
    }

    // Find max value across all enabled types
    let maxValue = 0;
    data.forEach((item) => {
      enabledTypes.forEach((type) => {
        const value = item[type];
        if (typeof value === "number" && value > maxValue) {
          maxValue = value;
        }
      });
    });

    // Return domain with 5% padding: [0, maxValue * 1.05]
    if (maxValue > 0) {
      return [0, maxValue * 1.05] as [number, number];
    }

    return null;
  }, [data, enabledTypes]);

  // Preserve domain when last line is disabled, clear when re-enabled
  useEffect(() => {
    if (enabledTypes.size === 0) {
      // Last line disabled: preserve the last calculated domain
      if (calculatedYDomain) {
        setPreservedYDomain(calculatedYDomain);
      }
      // If no calculated domain exists, keep the current preserved domain
    } else {
      // Lines are enabled: use calculated domain, clear preservation
      if (calculatedYDomain) {
        setPreservedYDomain(null);
      }
    }
  }, [enabledTypes.size, calculatedYDomain]);

  // Severity-aware high contrast color map
  // Critical issues: reds, Warning issues: oranges/yellows, Info issues: blues
  const colorMap: Record<string, string> = {
    // Critical severity issues - high contrast reds
    duplicates: "#DC2626", // red-600
    duplicate: "#DC2626", // red-600
    missing_link: "#B91C1C", // red-700
    links: "#B91C1C", // red-700

    // Warning severity issues - oranges/yellows
    attendance: "#F59E0B", // amber-500
    missing_field: "#D97706", // amber-600
    required_fields: "#D97706", // amber-600

    // Info severity issues - blues
    orphaned_link: "#3B82F6", // blue-500
  };

  // Function to get color for a type (fallback to high contrast color for unknown types)
  const getColor = (type: string): string => {
    if (colorMap[type]) return colorMap[type];
    // Generate a high contrast color for unknown types
    let hash = 0;
    for (let i = 0; i < type.length; i++) {
      hash = type.charCodeAt(i) + ((hash << 5) - hash);
    }
    // Use a more vibrant color palette (avoiding grays and low contrast)
    const hue = Math.abs(hash) % 360;
    // Prefer saturated colors (avoid pastels)
    return `hsl(${hue}, 70%, 45%)`;
  };

  // Toggle issue type visibility
  const toggleType = (type: string) => {
    setEnabledTypes((prev) => {
      const newSet = new Set(prev);
      if (newSet.has(type)) {
        newSet.delete(type);
      } else {
        newSet.add(type);
      }
      return newSet;
    });
  };

  // Function to format issue type name for display
  const formatIssueTypeName = (type: string): string => {
    const nameMap: Record<string, string> = {
      duplicates: "Duplicates",
      duplicate: "Duplicates",
      missing_link: "Missing Links",
      links: "Missing Links",
      attendance: "Attendance",
      missing_field: "Missing Fields",
      required_fields: "Missing Fields",
    };
    return (
      nameMap[type] ||
      type.replace(/_/g, " ").replace(/\b\w/g, (l) => l.toUpperCase())
    );
  };

  return (
    <>
      <style>{`
        @keyframes fadeInDot {
          from {
            opacity: 0;
            transform: scale(0);
          }
          to {
            opacity: 1;
            transform: scale(1);
          }
        }
      `}</style>
      <div className={`${height} w-full`}>
        {loading ? (
          <div className="h-full flex items-center justify-center">
            <div className="text-sm text-[var(--text-muted)]">
              Loading trend data...
            </div>
          </div>
        ) : error ? (
          <div className="h-full flex items-center justify-center text-red-500">
            Error loading trend data: {error}
          </div>
        ) : data.length === 0 ? (
          <div className="h-full flex items-center justify-center">
            <div className="text-sm text-[var(--text-muted)]">
              No trend data available yet
            </div>
          </div>
        ) : (
          <ResponsiveContainer width="100%" height="100%">
            <LineChart
              data={data}
              margin={{ top: 10, right: 30, left: 20, bottom: 5 }}
            >
              <CartesianGrid
                strokeDasharray="3 3"
                vertical={false}
                stroke="var(--border)"
              />
              <XAxis
                dataKey="day"
                stroke="var(--text-muted)"
                style={{ fontSize: "12px" }}
              />
              <YAxis
                stroke="var(--text-muted)"
                style={{ fontSize: "12px" }}
                domain={
                  preservedYDomain
                    ? preservedYDomain
                    : calculatedYDomain
                    ? calculatedYDomain
                    : undefined
                }
                tickFormatter={(value) => Math.round(value).toString()}
              />
              <Tooltip
                contentStyle={{
                  backgroundColor: "white",
                  border: "1px solid var(--border)",
                  borderRadius: "0.5rem",
                  boxShadow:
                    "0 4px 6px -1px rgba(0, 0, 0, 0.1), 0 2px 4px -1px rgba(0, 0, 0, 0.06)",
                  color: "var(--text-main)",
                }}
                labelStyle={{ color: "var(--text-main)" }}
              />
              {issueTypes.map((type) => {
                const isEnabled = enabledTypes.has(type);
                const color = getColor(type);
                const totalPoints = data.length;
                // Create dot render function that receives props with index
                const createDotRenderer = (
                  totalPoints: number,
                  color: string,
                  type: string
                ) => {
                  return (props: any) => {
                    // Check if the value is valid (not null, undefined, or negative)
                    const value = props.value ?? props.payload?.[type];
                    if (
                      value === null ||
                      value === undefined ||
                      typeof value !== "number" ||
                      value < 0
                    ) {
                      // Don't render dot for invalid values - return invisible circle
                      return (
                        <circle
                          cx={props.cx}
                          cy={props.cy}
                          r={0}
                          style={{ display: "none" }}
                        />
                      );
                    }

                    // Recharts may pass index in props.index, or we can find it from payload
                    let index = props.index;
                    if (index === undefined && props.payload) {
                      // Fallback: find index by matching the day value
                      index = data.findIndex(
                        (item) => item.day === props.payload.day
                      );
                    }
                    index = index >= 0 ? index : 0;
                    // Destructure key from props to avoid React warning about spreading key prop
                    const { key, ...dotProps } = props;
                    return (
                      <AnimatedDot
                        key={`dot-${type}-${index}`}
                        {...dotProps}
                        fill={color}
                        r={4}
                        index={index}
                        totalPoints={totalPoints}
                      />
                    );
                  };
                };
                // Use stable key based only on type, not isEnabled state
                return (
                  <Line
                    key={`line-${type}`}
                    type="monotone"
                    dataKey={type}
                    name={formatIssueTypeName(type)}
                    stroke={color}
                    strokeWidth={2}
                    dot={
                      isEnabled
                        ? createDotRenderer(totalPoints, color, type)
                        : false
                    }
                    activeDot={{ r: 6, fill: color }}
                    hide={!isEnabled}
                    isAnimationActive={isEnabled}
                    animationDuration={800}
                    animationEasing="ease-out"
                    connectNulls={false}
                  />
                );
              })}
            </LineChart>
          </ResponsiveContainer>
        )}
      </div>
      {/* Custom clickable legend */}
      {!loading && !error && data.length > 0 && (
        <div className="mt-4 flex flex-wrap gap-3">
          {issueTypes.map((type) => {
            const isEnabled = enabledTypes.has(type);
            const color = getColor(type);
            return (
              <button
                key={type}
                onClick={() => toggleType(type)}
                className="flex items-center gap-2 px-3 py-1.5 rounded-lg border border-[var(--border)] bg-white hover:bg-[var(--bg-mid)]/50 transition-colors cursor-pointer"
                style={{
                  opacity: isEnabled ? 1 : 0.4,
                }}
              >
                <div
                  className="w-3 h-3 rounded-full"
                  style={{
                    backgroundColor: color,
                    opacity: isEnabled ? 1 : 0.3,
                  }}
                />
                <span
                  className="text-sm font-medium"
                  style={{
                    color: isEnabled ? "var(--text-main)" : "var(--text-muted)",
                  }}
                >
                  {formatIssueTypeName(type)}
                </span>
              </button>
            );
          })}
        </div>
      )}
    </>
  );
}
