import * as React from 'react';
import {
  flexRender,
  getCoreRowModel,
  getSortedRowModel,
  type ColumnDef,
  type SortingState,
  useReactTable,
} from '@tanstack/react-table';
import { ArrowUpDown } from 'lucide-react';

import { cn } from '@/lib/utils';
import { Skeleton } from '@/components/ui/skeleton';

/**
 * Generic sortable table primitive. tanstack-table owns the sort state; rows
 * surface an optional onRowClick + an action cell defined by the consumer.
 *
 * Demo:
 *   <DataTable
 *     columns={[{ id: 'name', header: 'Name', accessorKey: 'name', cell: (r) => r.name }]}
 *     data={items}
 *     onRowClick={(row) => open(row)}
 *   />
 */
export interface DataTableProps<T> {
  columns: ColumnDef<T, unknown>[];
  data: T[];
  onRowClick?: (row: T) => void;
  isLoading?: boolean;
  emptyState?: React.ReactNode;
  /** Number of skeleton rows to render while isLoading. Default 5. */
  skeletonRows?: number;
  /** Class on the table container. */
  className?: string;
  /** A11y label for the table. */
  ariaLabel?: string;
}

export function DataTable<T>({
  columns,
  data,
  onRowClick,
  isLoading = false,
  emptyState,
  skeletonRows = 5,
  className,
  ariaLabel,
}: DataTableProps<T>) {
  const [sorting, setSorting] = React.useState<SortingState>([]);

  const table = useReactTable<T>({
    data,
    columns,
    state: { sorting },
    onSortingChange: setSorting,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getRowId: (row, index) => (row as unknown as { id?: unknown }).id?.toString() ?? `row-${index}`,
  });

  const colCount = table.getAllColumns().length;

  return (
    <div
      className={cn('overflow-hidden rounded-lg border bg-card text-card-foreground shadow-sm', className)}
      role="region"
    >
      <div className="overflow-x-auto">
        <table className="w-full min-w-[640px] text-left text-sm" aria-label={ariaLabel}>
          <thead className="border-b bg-muted/40 text-muted-foreground">
            {table.getHeaderGroups().map((hg) => (
              <tr key={hg.id}>
                {hg.headers.map((header) => {
                  const canSort = header.column.getCanSort();
                  const sorted = header.column.getIsSorted();
                  return (
                    <th
                      key={header.id}
                      scope="col"
                      className="px-4 py-2.5 text-xs font-medium uppercase tracking-wider"
                      style={{ width: header.getSize() }}
                    >
                      {header.isPlaceholder ? null : canSort ? (
                        <button
                          type="button"
                          onClick={header.column.getToggleSortingHandler()}
                          className="inline-flex items-center gap-1 rounded text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                        >
                          {flexRender(header.column.columnDef.header, header.getContext())}
                          <ArrowUpDown
                            className={cn(
                              'h-3.5 w-3.5 transition-opacity',
                              sorted ? 'opacity-100' : 'opacity-50',
                            )}
                          />
                        </button>
                      ) : (
                        <span>{flexRender(header.column.columnDef.header, header.getContext())}</span>
                      )}
                    </th>
                  );
                })}
              </tr>
            ))}
          </thead>
          <tbody>
            {isLoading ? (
              Array.from({ length: skeletonRows }).map((_, rowIdx) => (
                <tr key={`skel-${rowIdx}`} className="border-b last:border-0">
                  {Array.from({ length: colCount }).map((__, colIdx) => (
                    <td key={colIdx} className="px-4 py-3">
                      <Skeleton className="h-4 w-full max-w-[180px]" />
                    </td>
                  ))}
                </tr>
              ))
            ) : table.getRowModel().rows.length === 0 ? (
              <tr>
                <td colSpan={colCount} className="p-0">
                  {emptyState ?? <div className="p-6 text-sm text-muted-foreground">No data</div>}
                </td>
              </tr>
            ) : (
              table.getRowModel().rows.map((row) => {
                const interactive = !!onRowClick;
                return (
                  <tr
                    key={row.id}
                    data-testid={`row-${row.id}`}
                    onClick={interactive ? () => onRowClick!(row.original) : undefined}
                    onKeyDown={
                      interactive
                        ? (e) => {
                            if (e.key === 'Enter' || e.key === ' ') {
                              e.preventDefault();
                              onRowClick!(row.original);
                            }
                          }
                        : undefined
                    }
                    tabIndex={interactive ? 0 : undefined}
                    className={cn(
                      'border-b last:border-0',
                      interactive && 'cursor-pointer transition-colors hover:bg-muted/50 focus-visible:bg-muted/50 focus-visible:outline-none',
                    )}
                  >
                    {row.getVisibleCells().map((cell) => (
                      <td key={cell.id} className="px-4 py-3 align-middle">
                        {flexRender(cell.column.columnDef.cell, cell.getContext())}
                      </td>
                    ))}
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
