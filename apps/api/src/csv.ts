export function csv(columns: string[], rows: Record<string, unknown>[]) {
  const cell = (value: unknown) => {
    const text = value instanceof Date ? value.toISOString() : value === null || value === undefined ? '' : String(value);
    const safe = /^\s*[=+\-@]|^[\t\r\n]/.test(text) ? `'${text}` : text;
    return `"${safe.replaceAll('"', '""')}"`;
  };
  return [columns.map(cell).join(','), ...rows.map(row => columns.map(column => cell(row[column])).join(','))].join('\r\n');
}
