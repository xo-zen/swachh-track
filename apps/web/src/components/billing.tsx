'use client';
import { useState } from 'react';
import { Button, Panel, Table } from '@swachh/ui';
import { display, money, rows, text } from '@/lib/data';
import { useI18n } from '@/lib/i18n';
import { useScope } from './providers';
import { ActionForm, DataTable, DownloadButton, Modal, Notice, QueryRecord, SectionHeading, Status, field } from './operations';

export function Invoices() {
  const { t } = useI18n(); const { society } = useScope(); const [selected, setSelected] = useState('');
  return <div className="section-stack">
    <SectionHeading title={t('invoices')} detail={t('billingNotice')} actions={<ActionForm title="generateInvoice" variant="primary" path={`${society}/invoices/generate`} idempotent fields={[
      field('periodStart', 'periodStart', { type: 'date' }), field('periodEnd', 'periodEnd', { type: 'date' }), field('dueDate', 'dueDate', { type: 'date' }),
    ]} />} />
    <DataTable path={`${society}/invoices`} title="invoices" columns={[
      { key: 'periodStart', label: 'periodStart', format: 'date' }, { key: 'periodEnd', label: 'periodEnd', format: 'date' },
      { key: 'status', label: 'status', format: 'status' }, { key: 'deductionsPaise', label: 'deductions', format: 'money' }, { key: 'totalPaise', label: 'total', format: 'money' },
    ]} rowActions={row => <div className="button-row">
      <Button variant="secondary" onClick={() => setSelected(text(row.id))}>{t('invoiceDetail')}</Button>
      <DownloadButton path={`${society}/invoices/${text(row.id)}.pdf`} filename={`invoice-${text(row.id)}.pdf`} label="invoicePdf" />
      {row.status === 'DRAFT' && <ActionForm title="issueInvoice" path={`${society}/invoices/${text(row.id)}/issue`} fields={[]} />}
      {row.status === 'ISSUED' && <ActionForm title="markPaid" path={`${society}/invoices/${text(row.id)}/mark-paid`} fields={[
        field('amountPaise', 'amount', { type: 'number', min: 1, step: '1' }), field('paidAt', 'paidAt', { type: 'date' }), field('reference', 'paymentReference'),
      ]} transform={values => ({ ...values, paidAt: new Date(`${text(values.paidAt)}T00:00:00+05:30`).toISOString() })} />}
    </div>} />
    {selected && <Modal title={t('invoiceDetail')} onClose={() => setSelected('')}>
      <QueryRecord path={`${society}/invoices/${selected}`}>{data => <div className="section-stack">
        <div className="button-row"><Status value={data.status} /><strong>{money(data.totalPaise)}</strong></div>
        <Table caption={t('invoiceDetail')} rows={rows(data.lines)} rowKey={row => text(row.id)} columns={[
          { key: 'description', label: t('description'), render: row => text(row.description) },
          { key: 'quantity', label: t('unit'), render: row => `${display(row.quantity)} ${text(row.unit)}` },
          { key: 'amount', label: t('total'), render: row => money(row.amountPaise) },
          { key: 'evidence', label: t('evidence'), render: row => <details><summary>{t('evidence')}</summary><pre className="json-detail">{JSON.stringify(row.evidence, null, 2)}</pre></details> },
          { key: 'actions', label: t('actions'), render: row => <ActionForm title="dispute" path={`${society}/invoices/${selected}/disputes`} body={{ lineId: row.id }} fields={[field('reason', 'note', { type: 'textarea' })]} /> },
        ]} />
        <Notice>{t('billingNotice')}</Notice>
      </div>}</QueryRecord>
    </Modal>}
    <Panel className="padded"><DownloadButton path={`${society}/invoices/export.csv`} filename="accounts.csv" label="exportCsv" /></Panel>
  </div>;
}
