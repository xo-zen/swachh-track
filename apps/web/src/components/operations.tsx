'use client';
import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Download, Plus, RefreshCw, X } from 'lucide-react';
import { Badge, Button, EmptyState, ErrorState, LoadingState, Panel, Table, type Column } from '@swachh/ui';
import { api, errorMessage } from '@/lib/api';
import { at, date, display, endpoint, money, record, text, type Row } from '@/lib/data';
import { useI18n, type TranslationKey } from '@/lib/i18n';
import { useScope } from './providers';

export function Status({ value }: { value: unknown }) { const { t } = useI18n(); const label = text(value); return <Badge tone={['VERIFIED', 'PAID', 'ACTIVE', 'RESOLVED'].includes(label) ? 'good' : ['REJECTED', 'EXPIRED', 'BREACHED'].includes(label) ? 'bad' : ['NEEDS_REVIEW', 'OPEN', 'DRAFT', 'SELF_REPORTED', 'ESTIMATED'].includes(label) ? 'warning' : 'neutral'}>{t(label || 'NOT_MEASURED')}</Badge>; }
export function Notice({ children }: { children: ReactNode }) { return <div className="notice">{children}</div>; }
export function SectionHeading({ title, detail, actions }: { title: string; detail?: string; actions?: ReactNode }) { return <div className="section-heading"><div><h2>{title}</h2>{detail && <p className="muted">{detail}</p>}</div>{actions && <div className="button-row">{actions}</div>}</div>; }

export function ListFilter({ path, label, value, onChange }: { path: string; label: TranslationKey; value: string; onChange: (value: string) => void }) {
  const { t } = useI18n(); const { membership } = useScope();
  const query = useQuery({ queryKey: [membership?.id, 'options', path], queryFn: ({ signal }) => api.all(path, signal) });
  return <label>{t(label)}<select value={value} onChange={event => onChange(event.target.value)} disabled={query.isPending}><option value="">{t(query.isPending ? 'loading' : 'allRecords')}</option>{query.data?.map(row => <option key={text(row.id)} value={text(row.id)}>{text(row.name)}</option>)}</select>{query.error && <ErrorState message={errorMessage(query.error)} retry={() => void query.refetch()} retryLabel={t('retry')} />}</label>;
}

export function DownloadButton({ path, filename, label = 'download', signed = false }: { path: string; filename: string; label?: TranslationKey; signed?: boolean }) {
  const { t } = useI18n(); const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  return <span className="download-control"><Button variant="secondary" disabled={busy} onClick={async () => { setBusy(true); setError(''); try { await api.download(path, filename, signed); } catch (failure) { setError(errorMessage(failure)); } finally { setBusy(false); } }}><Download size={16} />{t(busy ? 'loading' : label)}</Button>{error && <span className="inline-error" role="alert">{error}</span>}</span>;
}

export interface Field { name: string; label: TranslationKey; type?: 'text' | 'number' | 'date' | 'time' | 'email' | 'textarea' | 'select' | 'checkbox' | 'file' | 'csv'; required?: boolean; options?: { value: string; label: string }[]; min?: number; max?: number; step?: string; accept?: string; hint?: TranslationKey; value?: string | number | boolean; purpose?: string; source?: string; optionLabel?: string; optionValue?: string }
export const field = (name: string, label: TranslationKey, options: Omit<Field, 'name' | 'label'> = {}): Field => ({ name, label, required: true, ...options });
export const streamOptions = ['WET', 'DRY', 'SANITARY', 'SPECIAL_CARE'].map(value => ({ value, label: value }));

function RemoteSelect({ item, value, busy }: { item: Field; value: unknown; busy: boolean }) {
  const { t } = useI18n(); const { membership } = useScope();
  const query = useQuery({ queryKey: [membership?.id, 'options', item.source], queryFn: ({ signal }) => api.all(item.source!, signal) });
  return <><select name={item.name} required={item.required} disabled={busy || query.isPending} defaultValue={text(value)}><option value="">{t(query.isPending ? 'loading' : 'selectRecord')}</option>{Array.from(new Map((query.data ?? []).map(row => [text(at(row, item.optionValue ?? 'id')), row])).entries()).map(([id, row]) => <option key={id} value={id}>{text(at(row, item.optionLabel ?? 'name')) || id}</option>)}</select>{query.error && <ErrorState message={errorMessage(query.error)} retry={() => void query.refetch()} retryLabel={t('retry')} />}{!query.isPending && !query.error && !query.data?.length && <span className="small muted">{t('empty')}</span>}</>;
}

function CsvInput({ item, busy }: { item: Field; busy: boolean }) {
  const { t } = useI18n(); const [csv, setCsv] = useState(''); const [error, setError] = useState('');
  return <><input type="file" aria-label={t('importCsv')} accept=".csv,text/csv" disabled={busy} onChange={async event => { const file = event.target.files?.[0]; if (!file) return; if (file.size > 1024 * 1024) { setError('CSV must be at most 1 MiB.'); return; } try { setCsv(await file.text()); setError(''); } catch (failure) { setError(errorMessage(failure)); } }} /><textarea name={item.name} aria-label={t('csv')} disabled={busy} required={item.required} value={csv} onChange={event => setCsv(event.target.value)} rows={8} />{error && <ErrorState message={error} />}</>;
}

export function Modal({ title, children, onClose, locked = false }: { title: string; children: ReactNode; onClose: () => void; locked?: boolean }) {
  const ref = useRef<HTMLDialogElement>(null); const id = useId(); const { t } = useI18n();
  useEffect(() => { const dialog = ref.current; dialog?.showModal(); return () => dialog?.close(); }, []);
  return <dialog ref={ref} className="modal" aria-labelledby={id} onCancel={event => { if (locked) event.preventDefault(); else onClose(); }}><div className="modal-heading"><h2 id={id}>{title}</h2><Button variant="quiet" aria-label={t('close')} disabled={locked} onClick={onClose}><X size={20} /></Button></div>{children}</dialog>;
}

export function ActionForm({ title, path, fields, method = 'POST', initial, body, transform, idempotent, onSuccess, description, variant = 'secondary' }: {
  title: TranslationKey; path: string | ((data: Row) => string); fields: Field[]; method?: string; initial?: Row; body?: Row; transform?: (data: Row) => Row; idempotent?: boolean; onSuccess?: (result: unknown) => void; description?: TranslationKey; variant?: 'primary' | 'secondary' | 'danger';
}) {
  const { t } = useI18n(); const client = useQueryClient(); const { membership } = useScope();
  const [open, setOpen] = useState(false); const [busy, setBusy] = useState(false); const [error, setError] = useState(''); const [success, setSuccess] = useState(false);
  const idempotency = useRef<string>(''); const submission = useRef<string>('');
  return <><Button variant={variant} onClick={() => { setOpen(true); setError(''); setSuccess(false); idempotency.current = ''; submission.current = ''; }}><Plus size={16} />{t(title)}</Button>{success && <span className="small success" role="status">{t('saved')}</span>}{open && <Modal title={t(title)} locked={busy} onClose={() => { if (!busy) setOpen(false); }}><form className="operation-form" onSubmit={async event => {
    event.preventDefault(); setBusy(true); setError('');
    try {
      const form = new FormData(event.currentTarget); let values: Row = { ...body };
      for (const item of fields) {
        const value = form.get(item.name);
        if (item.type === 'checkbox') values[item.name] = value === 'on';
        else if (item.type === 'file') { if (value instanceof File && value.size > 0) values[item.name] = await api.upload(value, item.purpose ?? 'DOCUMENT'); }
        else if (typeof value === 'string' && value.trim() !== '') values[item.name] = item.type === 'number' ? Number(value) : value.trim();
      }
      const target = typeof path === 'function' ? path(values) : path;
      if (transform) values = transform(values);
      const serialized = JSON.stringify({ target, values });
      if (serialized !== submission.current) { submission.current = serialized; idempotency.current = crypto.randomUUID(); }
      const result = await api.mutate(target, values, method, idempotent ? idempotency.current : undefined);
      await client.invalidateQueries({ queryKey: [membership?.id] }); onSuccess?.(result); setOpen(false); setSuccess(true);
    } catch (failure) { setError(errorMessage(failure)); } finally { setBusy(false); }
  }}>{description && <Notice>{t(description)}</Notice>}<div className="form-grid">{fields.map(item => {
    const value = initial?.[item.name] ?? item.value; const common = { name: item.name, required: item.required, disabled: busy };
    return <label key={item.name} className={['textarea', 'file', 'csv'].includes(item.type ?? '') ? 'full-width' : ''}>{t(item.label)}{
      item.source ? <RemoteSelect item={item} value={value} busy={busy} /> :
      item.type === 'csv' ? <CsvInput item={item} busy={busy} /> :
      item.type === 'textarea' ? <textarea {...common} defaultValue={text(value)} rows={5} /> :
      item.type === 'select' ? <select {...common} defaultValue={text(value)}>{!value && <option value="">—</option>}{item.options?.map(option => <option key={option.value} value={option.value}>{t(option.label)}</option>)}</select> :
      item.type === 'checkbox' ? <input name={item.name} disabled={busy} type="checkbox" defaultChecked={value === true} /> :
      item.type === 'file' ? <input {...common} type="file" accept={item.accept ?? 'image/jpeg,image/png,image/webp,application/pdf'} /> :
      <input {...common} type={item.type ?? 'text'} defaultValue={item.type === 'date' ? text(value).slice(0, 10) : text(value)} min={item.min} max={item.max} step={item.step ?? (item.type === 'number' ? 'any' : undefined)} />
    }{item.hint && <span className="small muted">{t(item.hint)}</span>}{item.type === 'file' && <span className="small muted">{t('uploadLimit')}</span>}</label>;
  })}</div>{error && <ErrorState message={error} />}<div className="form-footer"><Button type="button" variant="secondary" disabled={busy} onClick={() => setOpen(false)}>{t('cancel')}</Button><Button type="submit" disabled={busy}>{t(busy ? 'saving' : 'save')}</Button></div></form></Modal>}</>;
}

export interface DataColumn { key: string; label: TranslationKey; format?: 'date' | 'money' | 'status'; render?: (row: Row) => ReactNode }
export function DataTable({ path, title, columns, actions, filters = {}, searchable = false, rowActions }: { path: string; title: TranslationKey; columns: DataColumn[]; actions?: ReactNode; filters?: Record<string, string | undefined>; searchable?: boolean; rowActions?: (row: Row) => ReactNode }) {
  const { t } = useI18n(); const { membership } = useScope(); const [search, setSearch] = useState(''); const [appliedSearch, setAppliedSearch] = useState(''); const [cursors, setCursors] = useState<string[]>([]);
  const url = endpoint(path, { ...filters, search: appliedSearch, cursor: cursors.at(-1), limit: '25' });
  const query = useQuery({ queryKey: [membership?.id, url], queryFn: ({ signal }) => api.list(url, signal), enabled: Boolean(path) });
  const rendered: Column<Row>[] = columns.map(column => ({ key: column.key, label: t(column.label), render: row => column.render ? column.render(row) : column.format === 'date' ? date(at(row, column.key)) : column.format === 'money' ? money(at(row, column.key)) : column.format === 'status' ? <Status value={at(row, column.key)} /> : display(at(row, column.key)) }));
  if (rowActions) rendered.push({ key: 'actions', label: t('actions'), render: rowActions });
  return <Panel><div className="panel-toolbar"><h3>{t(title)}</h3><div className="button-row">{actions}<Button variant="quiet" aria-label={t('refresh')} onClick={() => void query.refetch()} disabled={query.isFetching}><RefreshCw size={18} /></Button></div></div>{searchable && <form className="search-bar" onSubmit={event => { event.preventDefault(); setCursors([]); setAppliedSearch(search); }}><input aria-label={t('search')} placeholder={t('search')} value={search} onChange={event => setSearch(event.target.value)} /><Button variant="secondary">{t('search')}</Button></form>}{query.isPending ? <LoadingState label={t('loading')} /> : query.error ? <ErrorState message={errorMessage(query.error)} retry={() => void query.refetch()} retryLabel={t('retry')} /> : !Array.isArray(query.data?.items) ? <ErrorState message="Invalid API list response: expected {items, nextCursor}." /> : query.data.items.length ? <Table columns={rendered} rows={query.data.items} rowKey={row => text(row.id) || JSON.stringify(row)} caption={t(title)} /> : <EmptyState title={t('empty')} detail={t('emptyDetail')} />}<div className="table-footer"><span className="small muted">{t('liveData')}</span><div className="button-row"><Button variant="quiet" disabled={!cursors.length || query.isFetching} onClick={() => setCursors(current => current.slice(0, -1))}>{t('previous')}</Button><Button variant="quiet" disabled={!query.data?.nextCursor || query.isFetching} onClick={() => { if (query.data?.nextCursor) setCursors(current => [...current, query.data.nextCursor as string]); }}>{t('next')}</Button></div></div></Panel>;
}

export function RecordView({ value }: { value: unknown }) {
  const { t } = useI18n();
  return <dl className="record-grid">{Object.entries(record(value)).map(([key, item]) => <div key={key}><dt>{t(key)}</dt><dd>{display(item)}</dd></div>)}</dl>;
}

export function QueryRecord({ path, children }: { path: string; children?: (data: Row) => ReactNode }) {
  const { t } = useI18n(); const { membership } = useScope();
  const query = useQuery({ queryKey: [membership?.id, path], queryFn: ({ signal }) => api.json<Row>(path, { signal }), enabled: Boolean(path) });
  if (!path) return <Notice>{t('missingScope')}</Notice>;
  if (query.isPending) return <LoadingState label={t('loading')} />;
  if (query.error) return <ErrorState message={errorMessage(query.error)} retry={() => void query.refetch()} retryLabel={t('retry')} />;
  return <><div className="record-actions"><Button variant="quiet" disabled={query.isFetching} onClick={() => void query.refetch()}><RefreshCw size={16} />{t('refresh')}</Button></div>{children ? children(record(query.data)) : <RecordView value={query.data} />}</>;
}
