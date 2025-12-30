import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from "recharts";

type TrendDataItem = {
  day: string;
  total: number;
  date: Date;
};

type LeadershipTrendChartProps = {
  data: TrendDataItem[];
  loading?: boolean;
  error?: string | null;
};

function CustomTooltip({ active, payload, label }: any) {
  if (active && payload && payload.length) {
    const value = payload[0].value;
    return (
      <div className="bg-white border border-[var(--border)] rounded-xl px-4 py-3 shadow-lg">
        <p className="text-sm font-medium text-[var(--text-main)]">{label}</p>
        <p className="text-2xl font-semibold text-[var(--text-main)] mt-1" style={{ fontFamily: "Outfit" }}>
          {value}
        </p>
        <p className="text-xs text-[var(--text-muted)]">
          {value === 1 ? "item" : "items"} to review
        </p>
      </div>
    );
  }
  return null;
}

export function LeadershipTrendChart({
  data,
  loading = false,
  error = null,
}: LeadershipTrendChartProps) {
  // Calculate trend direction for display
  const trendInfo = (() => {
    if (data.length < 2) return null;

    const recent = data.slice(-7); // Last week
    const earlier = data.slice(0, 7); // First week of the month

    if (recent.length === 0 || earlier.length === 0) return null;

    const recentAvg = recent.reduce((sum, d) => sum + d.total, 0) / recent.length;
    const earlierAvg = earlier.reduce((sum, d) => sum + d.total, 0) / earlier.length;

    if (earlierAvg === 0 && recentAvg === 0) return { direction: "stable", change: 0 };
    if (earlierAvg === 0) return { direction: "up", change: 100 };

    const percentChange = ((recentAvg - earlierAvg) / earlierAvg) * 100;

    if (Math.abs(percentChange) < 5) {
      return { direction: "stable", change: 0 };
    }

    return {
      direction: percentChange < 0 ? "down" : "up",
      change: Math.abs(Math.round(percentChange)),
    };
  })();

  if (loading) {
    return (
      <div className="h-64 flex items-center justify-center">
        <div className="text-sm text-[var(--text-muted)]">Loading trend data...</div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="h-64 flex items-center justify-center text-red-500">
        Unable to load trend data
      </div>
    );
  }

  if (data.length === 0) {
    return (
      <div className="h-64 flex items-center justify-center">
        <div className="text-sm text-[var(--text-muted)]">
          Not enough data yet. Trends will appear after a few scans.
        </div>
      </div>
    );
  }

  // Find max for Y-axis domain
  const maxValue = Math.max(...data.map((d) => d.total), 1);
  const yDomain = [0, Math.ceil(maxValue * 1.1)];

  // Determine gradient colors based on trend
  const gradientId = "leadershipTrendGradient";
  const lineColor = trendInfo?.direction === "down"
    ? "#10B981" // emerald-500 (improving)
    : trendInfo?.direction === "up"
    ? "#F59E0B" // amber-500 (worsening)
    : "#3B82F6"; // blue-500 (stable)

  return (
    <div className="space-y-4">
      {/* Trend summary */}
      {trendInfo && (
        <div className="flex items-center gap-2">
          {trendInfo.direction === "down" ? (
            <div className="flex items-center gap-1.5 text-emerald-600">
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M13 17h8m0 0v-8m0 8l-8-8-4 4-6-6" />
              </svg>
              <span className="text-sm font-medium">
                {trendInfo.change > 0 ? `${trendInfo.change}% fewer issues` : "Improving"}
              </span>
            </div>
          ) : trendInfo.direction === "up" ? (
            <div className="flex items-center gap-1.5 text-amber-600">
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M13 7h8m0 0v8m0-8l-8 8-4-4-6 6" />
              </svg>
              <span className="text-sm font-medium">
                {trendInfo.change > 0 ? `${trendInfo.change}% more issues` : "Needs attention"}
              </span>
            </div>
          ) : (
            <div className="flex items-center gap-1.5 text-slate-500">
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M5 12h14" />
              </svg>
              <span className="text-sm font-medium">Holding steady</span>
            </div>
          )}
        </div>
      )}

      {/* Chart */}
      <div className="h-56">
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart
            data={data}
            margin={{ top: 10, right: 10, left: -10, bottom: 0 }}
          >
            <defs>
              <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={lineColor} stopOpacity={0.2} />
                <stop offset="100%" stopColor={lineColor} stopOpacity={0.02} />
              </linearGradient>
            </defs>
            <CartesianGrid
              strokeDasharray="3 3"
              vertical={false}
              stroke="var(--border)"
              strokeOpacity={0.5}
            />
            <XAxis
              dataKey="day"
              stroke="var(--text-muted)"
              style={{ fontSize: "11px" }}
              tickLine={false}
              axisLine={false}
              interval="preserveStartEnd"
              tickMargin={8}
            />
            <YAxis
              stroke="var(--text-muted)"
              style={{ fontSize: "11px" }}
              domain={yDomain}
              tickLine={false}
              axisLine={false}
              tickFormatter={(value) => Math.round(value).toString()}
              width={30}
            />
            <Tooltip content={<CustomTooltip />} />
            <Area
              type="monotone"
              dataKey="total"
              stroke={lineColor}
              strokeWidth={2.5}
              fill={`url(#${gradientId})`}
              animationDuration={1000}
              animationEasing="ease-out"
            />
          </AreaChart>
        </ResponsiveContainer>
      </div>

      {/* Legend */}
      <p className="text-xs text-center text-[var(--text-muted)]">
        Total items to review over the past 30 days
      </p>
    </div>
  );
}
