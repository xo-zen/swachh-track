import type { ButtonHTMLAttributes, HTMLAttributes, ReactNode } from 'react';

export function Button({ className = '', variant = 'primary', ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'primary' | 'secondary' | 'danger' | 'quiet' }) {
  return <button className={`button button-${variant} ${className}`} {...props} />;
}

export function Badge({ children, tone = 'neutral' }: { children: ReactNode; tone?: 'neutral' | 'good' | 'warning' | 'bad' }) {
  return <span className={`badge badge-${tone}`}>{children}</span>;
}

export function Panel({ children, className = '', ...props }: HTMLAttributes<HTMLElement>) {
  return <section className={`panel ${className}`} {...props}>{children}</section>;
}

export function EmptyState({ title, detail, action }: { title: string; detail?: string; action?: ReactNode }) {
  return <div className="empty-state"><span className="empty-mark" aria-hidden="true">+</span><h3>{title}</h3>{detail && <p>{detail}</p>}{action}</div>;
}

export function ErrorState({ message, retry, retryLabel }: { message: string; retry?: () => void; retryLabel?: string }) {
  return <div className="error-state" role="alert"><p>{message}</p>{retry && <Button variant="secondary" onClick={retry}>{retryLabel}</Button>}</div>;
}

export function LoadingState({ label }: { label: string }) {
  return <div className="loading-state" role="status"><span className="spinner" aria-hidden="true" />{label}</div>;
}

export interface Column<T> { key: string; label: string; render: (row: T) => ReactNode }
export function Table<T>({ columns, rows, rowKey, caption }: { columns: Column<T>[]; rows: T[]; rowKey: (row: T) => string; caption: string }) {
  return <div className="table-scroll" role="region" aria-label={caption} tabIndex={0}><table><caption className="sr-only">{caption}</caption><thead><tr>{columns.map(column => <th key={column.key} scope="col">{column.label}</th>)}</tr></thead><tbody>{rows.map(row => <tr key={rowKey(row)}>{columns.map(column => <td key={column.key}>{column.render(row)}</td>)}</tr>)}</tbody></table></div>;
}
