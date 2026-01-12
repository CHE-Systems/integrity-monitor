import {
  useFirestoreIssues,
  type IssueFilters,
} from "../hooks/useFirestoreIssues";
import { formatLeadershipIssue } from "../utils/issueFormatter";

interface CategoryIssueListProps {
  filter: IssueFilters;
  totalCount?: number;
}

export function CategoryIssueList({
  filter,
  totalCount,
}: CategoryIssueListProps) {
  // Fetch all issues for this category (use a high limit to ensure we get everything)
  // Add buffer to account for the +1 used by the hook to check for more
  const limit =
    totalCount && totalCount > 0 ? Math.ceil(totalCount * 1.1) : 2000;
  const {
    data: issues,
    loading,
    error,
    hasMore,
  } = useFirestoreIssues(filter, limit);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-4">
        <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-[var(--brand)]"></div>
      </div>
    );
  }

  if (error) {
    return <div className="text-[10px] text-red-500 py-1 px-3">{error}</div>;
  }

  // Group issues by their human-readable labels
  const groupsMap = issues.reduce((acc, issue) => {
    const label = formatLeadershipIssue(issue);
    if (!acc[label]) {
      acc[label] = {
        label: label,
        entity: issue.entity,
        count: 0,
      };
    }
    acc[label].count += 1;
    return acc;
  }, {} as Record<string, { label: string; entity: string; count: number }>);

  const groups = Object.values(groupsMap).sort((a, b) => b.count - a.count);
  const displayedCount = issues.length;
  const totalGroupedCount = groups.reduce((sum, group) => sum + group.count, 0);
  const isTruncated = hasMore || (totalCount && displayedCount < totalCount);

  if (groups.length === 0) {
    return (
      <div className="text-[10px] text-[var(--text-muted)] py-2 px-3 text-center">
        No issues found
      </div>
    );
  }

  return (
    <div className="space-y-1">
      {groups.map((group, idx) => (
        <div
          key={`${group.label}-${idx}`}
          className="flex items-center gap-3 px-3 py-1.5 rounded-lg bg-white/40 border border-[var(--border)]/30 group"
        >
          <span className="text-[10px] font-bold uppercase tracking-wider text-[var(--text-muted)] bg-[var(--bg-mid)] px-1.5 py-0.5 rounded flex-shrink-0">
            {group.entity}
          </span>
          <p className="text-sm font-medium text-[var(--text-main)] truncate flex-1 leading-tight">
            {group.label}
          </p>
          <span className="text-xs font-bold text-[var(--brand)] bg-[var(--brand)]/10 px-2 py-0.5 rounded-full">
            {group.count}
          </span>
        </div>
      ))}
      {isTruncated && (
        <div className="text-[10px] text-[var(--text-muted)] py-2 px-3 text-center italic border-t border-[var(--border)]/30 pt-2 mt-1">
          Showing {displayedCount} of {totalCount || "many"} items.{" "}
          {totalCount &&
            totalGroupedCount < totalCount &&
            "Some items may not be shown due to the display limit."}
        </div>
      )}
      {!isTruncated && totalCount && totalGroupedCount < totalCount && (
        <div className="text-[10px] text-[var(--text-muted)] py-2 px-3 text-center italic border-t border-[var(--border)]/30 pt-2 mt-1">
          Note: Grouped items ({totalGroupedCount}) may not sum to total (
          {totalCount}) as some issues share the same description.
        </div>
      )}
    </div>
  );
}
