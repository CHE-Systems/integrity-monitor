interface PaginationProps {
  currentPage: number;
  totalPages: number;
  totalItems: number;
  itemsPerPage: number;
  startIndex: number;
  endIndex: number;
  onPageChange: (page: number) => void;
  itemLabel?: string;
  alwaysShow?: boolean;
}

export function Pagination({
  currentPage,
  totalPages,
  totalItems,
  itemsPerPage,
  startIndex,
  endIndex,
  onPageChange,
  itemLabel = "items",
  alwaysShow = false,
}: PaginationProps) {
  if (!alwaysShow && totalPages <= 1) {
    return null;
  }

  return (
    <div className="bg-white border border-[var(--border)] rounded-xl p-4">
      <div className="flex items-center justify-between">
        <div className="text-sm text-[var(--text-muted)]">
          Showing {startIndex + 1}-{Math.min(endIndex, totalItems)} of{" "}
          {totalItems} {totalItems === 1 ? itemLabel.slice(0, -1) : itemLabel}
        </div>
        {totalPages > 1 && (
          <div className="flex items-center gap-2">
            <button
              onClick={() => onPageChange(1)}
              disabled={currentPage === 1}
              className="px-3 py-1.5 text-sm font-medium text-[var(--text-main)] border border-[var(--border)] rounded-lg hover:bg-[var(--bg-mid)] transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              First
            </button>
            <button
              onClick={() => onPageChange(Math.max(1, currentPage - 1))}
              disabled={currentPage === 1}
              className="px-3 py-1.5 text-sm font-medium text-[var(--text-main)] border border-[var(--border)] rounded-lg hover:bg-[var(--bg-mid)] transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              Previous
            </button>
            <div className="flex items-center gap-2 px-3">
              <span className="text-sm text-[var(--text-main)]">
                Page{" "}
                <input
                  type="number"
                  min={1}
                  max={totalPages}
                  value={currentPage}
                  onChange={(e) => {
                    const page = parseInt(e.target.value, 10);
                    if (page >= 1 && page <= totalPages) {
                      onPageChange(page);
                    }
                  }}
                  className="w-16 px-2 py-1 text-center border border-[var(--border)] rounded-lg text-sm text-[var(--text-main)]"
                />{" "}
                of {totalPages}
              </span>
            </div>
            <button
              onClick={() => onPageChange(Math.min(totalPages, currentPage + 1))}
              disabled={currentPage === totalPages}
              className="px-3 py-1.5 text-sm font-medium text-[var(--text-main)] border border-[var(--border)] rounded-lg hover:bg-[var(--bg-mid)] transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              Next
            </button>
            <button
              onClick={() => onPageChange(totalPages)}
              disabled={currentPage === totalPages}
              className="px-3 py-1.5 text-sm font-medium text-[var(--text-main)] border border-[var(--border)] rounded-lg hover:bg-[var(--bg-mid)] transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              Last
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
