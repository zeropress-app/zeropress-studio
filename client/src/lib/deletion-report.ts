export function createDeletionReport(
  deletedRows: Record<string, number>,
): string {
  const entries = Object.entries(deletedRows);
  const totalRows = entries.reduce(
    (total, [, rows]) => total + rows,
    0,
  );
  const tableHeader = 'TABLE';
  const rowsHeader = 'DELETED ROWS';
  const totalLabel = 'TOTAL';
  const tableWidth = Math.max(
    tableHeader.length,
    totalLabel.length,
    ...entries.map(([table]) => table.length),
  );
  const rowsWidth = Math.max(
    rowsHeader.length,
    String(totalRows).length,
    ...entries.map(([, rows]) => String(rows).length),
  );
  const line = (table: string, rows: string) =>
    `${table.padEnd(tableWidth)}  ${rows.padStart(rowsWidth)}`;

  return [
    line(tableHeader, rowsHeader),
    ...entries.map(([table, rows]) => line(table, String(rows))),
    `${'-'.repeat(tableWidth)}  ${'-'.repeat(rowsWidth)}`,
    line(totalLabel, String(totalRows)),
  ].join('\n');
}
