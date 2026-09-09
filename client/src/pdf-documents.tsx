/* eslint-disable react-refresh/only-export-components -- Lazily loaded PDF renderers intentionally export document factories and typed helpers. */
import { Document, Font, Page, StyleSheet, Text, View, pdf } from '@react-pdf/renderer'
import amiriBoldUrl from './assets/fonts/Amiri-Bold.ttf?url'
import amiriRegularUrl from './assets/fonts/Amiri-Regular.ttf?url'
import { movementSourceLabel } from './business-labels'
import { formatDecimal } from './money-display'
import type { SavedInvoice } from './components/InvoiceOutput'

export type PdfStatementEntry = {
  id: string
  date: string
  store_name: string
  source_type: string
  source_id: string | null
  description: string | null
  document_number: string | null
  project_name?: string | null
  check_number: string | null
  check_status: string | null
  payment_method: string | null
  debit: string
  credit: string
  running_balance: string
  purchase_items?: Array<{
    product: string
    quantity: string
    unit_price: string
    line_total: string
  }>
}

export type PdfAccountStatement = {
  kind: 'customer' | 'supplier'
  party: { id: string; name: string; phone: string | null; address: string | null }
  project: { id: string; name: string } | null
  from: string
  to: string
  opening_balance: string
  closing_balance: string
  entries: PdfStatementEntry[]
}

Font.register({
  family: 'Amiri',
  fonts: [
    { src: amiriRegularUrl, fontWeight: 400 },
    { src: amiriBoldUrl, fontWeight: 700 },
  ],
})

const colors = {
  ink: '#0f172a',
  muted: '#475569',
  line: '#cbd5e1',
  soft: '#f1f5f9',
}

const styles = StyleSheet.create({
  page: {
    backgroundColor: '#ffffff', color: colors.ink, direction: 'rtl',
    fontFamily: 'Amiri', fontSize: 9, padding: 28,
  },
  receiptPage: {
    backgroundColor: '#ffffff', color: colors.ink, direction: 'rtl',
    fontFamily: 'Amiri', fontSize: 8, padding: 9,
  },
  brand: { color: colors.muted, direction: 'rtl', fontSize: 9, fontWeight: 700, textAlign: 'right' },
  title: { direction: 'rtl', fontSize: 22, fontWeight: 700, textAlign: 'right' },
  receiptTitle: { direction: 'rtl', fontSize: 16, fontWeight: 700, textAlign: 'right' },
  metaGrid: { flexDirection: 'row-reverse', flexWrap: 'wrap', marginTop: 7 },
  meta: { direction: 'rtl', fontSize: 9, marginBottom: 3, paddingLeft: 8, textAlign: 'right', width: '50%' },
  rule: { borderBottomColor: colors.ink, borderBottomWidth: 1.5, marginTop: 7 },
  balance: {
    backgroundColor: colors.soft, borderRadius: 5, flexDirection: 'row-reverse',
    justifyContent: 'space-between', marginVertical: 9, paddingHorizontal: 8, paddingVertical: 6,
  },
  bold: { fontWeight: 700 },
  rtl: { direction: 'rtl', textAlign: 'right' },
  ltr: { direction: 'ltr', textAlign: 'left' },
  table: { borderColor: colors.line, borderLeftWidth: 1, borderTopWidth: 1 },
  tableRow: { flexDirection: 'row-reverse', minHeight: 31 },
  tableHeader: { backgroundColor: colors.soft, flexDirection: 'row-reverse', minHeight: 25 },
  cell: {
    borderBottomColor: colors.line, borderBottomWidth: 1,
    borderRightColor: colors.line, borderRightWidth: 1,
    direction: 'rtl', justifyContent: 'center', paddingHorizontal: 4,
    paddingVertical: 4, textAlign: 'right',
  },
  cellText: { direction: 'rtl', fontSize: 8, textAlign: 'right' },
  cellSmall: { color: colors.muted, direction: 'rtl', fontSize: 6.8, marginTop: 2, textAlign: 'right' },
  cellLtr: { direction: 'ltr', fontSize: 8, textAlign: 'center' },
  footerBalance: {
    borderTopColor: colors.ink, borderTopWidth: 1.5, flexDirection: 'row-reverse',
    fontSize: 11, fontWeight: 700, justifyContent: 'space-between', marginTop: 9, paddingTop: 7,
  },
  pageNumber: { bottom: 12, color: colors.muted, fontSize: 7, left: 28, position: 'absolute' },
  invoiceHeading: { flexDirection: 'row-reverse', justifyContent: 'space-between', marginTop: 3 },
  invoiceSummary: { borderTopColor: colors.ink, borderTopWidth: 1.5, marginLeft: '45%', marginTop: 10, paddingTop: 6 },
  summaryRow: { flexDirection: 'row-reverse', justifyContent: 'space-between', marginBottom: 3 },
  thanks: { borderTopColor: colors.line, borderTopWidth: 1, direction: 'rtl', marginTop: 12, paddingTop: 6, textAlign: 'center' },
})

const statementColumns = [
  { key: 'date', label: 'التاريخ', width: '13%' },
  { key: 'description', label: 'البيان', width: '34%' },
  { key: 'document', label: 'المستند / المحل', width: '19%' },
  { key: 'debit', label: 'مدين', width: '11%' },
  { key: 'credit', label: 'دائن', width: '11%' },
  { key: 'balance', label: 'الرصيد', width: '12%' },
] as const

const invoiceColumns = [
  { key: 'description', label: 'الصنف', width: '38%' },
  { key: 'quantity', label: 'الكمية', width: '14%' },
  { key: 'price', label: 'السعر', width: '18%' },
  { key: 'discount', label: 'الخصم', width: '14%' },
  { key: 'total', label: 'الإجمالي', width: '16%' },
] as const

const receiptInvoiceColumns = [
  { key: 'description', label: 'الصنف', width: '46%' },
  { key: 'quantity', label: 'الكمية', width: '16%' },
  { key: 'price', label: 'السعر', width: '19%' },
  { key: 'total', label: 'الإجمالي', width: '19%' },
] as const

export function statementEntryLabel(entry: PdfStatementEntry, kind: PdfAccountStatement['kind']) {
  const labels: Record<string, string> = kind === 'customer' ? {
    sale: 'مبيعات', sale_payment: 'دفعة', payment: 'دفعة',
    sale_check: 'شيك', check: 'شيك', customer_return: 'مرتجع مبيعات',
    maintenance: 'صيانة', maintenance_payment: 'دفعة صيانة',
    maintenance_check: 'شيك صيانة', check_bounce: 'شيك مرتجع', correction: 'تصحيح رصيد',
  } : {
    purchase: 'مشتريات', purchase_payment: 'دفعة', supplier_payment: 'دفعة',
    owner_check: 'شيك', check_transfer: 'شيك محوّل',
    supplier_return: 'مرتجع مشتريات', owner_check_bounce: 'تصحيح شيك مرتجع',
    check_transfer_bounce: 'تصحيح شيك مرتجع', correction: 'تصحيح رصيد',
  }
  return labels[entry.source_type] ?? `تصحيح - ${movementSourceLabel(entry.source_type)}`
}

function StatementHeader({ statement }: { statement: PdfAccountStatement }) {
  const customer = statement.kind === 'customer'
  return <View>
    <Text style={styles.brand}>نظام إدارة الحسابات والمتجر</Text>
    <Text style={styles.title}>{customer ? 'كشف حساب عميل' : 'كشف حساب مورد'}</Text>
    <View style={styles.metaGrid}>
      <Text style={styles.meta}>الاسم: {statement.party.name}</Text>
      <Text style={styles.meta}>الهاتف: {statement.party.phone ?? '—'}</Text>
      <Text style={styles.meta}>من: {statement.from}</Text>
      <Text style={styles.meta}>إلى: {statement.to}</Text>
      {statement.project && <Text style={styles.meta}>المشروع: {statement.project.name}</Text>}
    </View>
    <View style={styles.rule} />
  </View>
}

function TableHeader({ columns }: { columns: ReadonlyArray<{ key: string; label: string; width: string }> }) {
  return <View style={styles.tableHeader} wrap={false}>
    {columns.map((column) => <View key={column.key} style={[styles.cell, { width: column.width }]}>
      <Text style={[styles.cellText, styles.bold]}>{column.label}</Text>
    </View>)}
  </View>
}

function StatementRow({ entry, kind }: { entry: PdfStatementEntry; kind: PdfAccountStatement['kind'] }) {
  const items = entry.purchase_items ?? []
  return <View style={styles.tableRow} wrap={false}>
    <View style={[styles.cell, { width: '13%' }]}><Text style={styles.cellLtr}>{entry.date}</Text></View>
    <View style={[styles.cell, { width: '34%' }]}>
      <Text style={[styles.cellText, styles.bold]}>{statementEntryLabel(entry, kind)}</Text>
      {entry.description && <Text style={styles.cellSmall}>{entry.description}</Text>}
      {entry.project_name && <Text style={styles.cellSmall}>المشروع: {entry.project_name}</Text>}
      {items.map((item, index) => <Text key={`${entry.id}:${index}`} style={styles.cellSmall}>
        {item.product} - {formatDecimal(item.quantity)} × ₪{formatDecimal(item.unit_price)} = ₪{formatDecimal(item.line_total)}
      </Text>)}
    </View>
    <View style={[styles.cell, { width: '19%' }]}>
      <Text style={styles.cellText}>{entry.document_number ?? `#${entry.source_id ?? entry.id}`}</Text>
      <Text style={styles.cellSmall}>{entry.store_name}</Text>
    </View>
    <View style={[styles.cell, { width: '11%' }]}><Text style={styles.cellLtr}>{entry.debit === '0' ? '—' : `₪${formatDecimal(entry.debit)}`}</Text></View>
    <View style={[styles.cell, { width: '11%' }]}><Text style={styles.cellLtr}>{entry.credit === '0' ? '—' : `₪${formatDecimal(entry.credit)}`}</Text></View>
    <View style={[styles.cell, { width: '12%' }]}><Text style={[styles.cellLtr, styles.bold]}>₪{formatDecimal(entry.running_balance)}</Text></View>
  </View>
}

function StatementPdfDocument({ statement }: { statement: PdfAccountStatement }) {
  const pages = statement.entries.reduce<PdfStatementEntry[][]>((result, entry) => {
    const estimatedHeight = 31
      + (entry.description ? 9 : 0)
      + (entry.project_name ? 9 : 0)
      + (entry.purchase_items?.length ?? 0) * 9
    const current = result.at(-1)!
    const currentHeight = current.reduce((height, item) => height + 31
      + (item.description ? 9 : 0)
      + (item.project_name ? 9 : 0)
      + (item.purchase_items?.length ?? 0) * 9, 0)

    if (current.length && currentHeight + estimatedHeight > 530) result.push([entry])
    else current.push(entry)
    return result
  }, [[]])

  return <Document title={statement.kind === 'customer' ? 'كشف حساب عميل' : 'كشف حساب مورد'}>
    {pages.map((entries, pageIndex) => <Page key={pageIndex} size="A4" style={styles.page}>
      <StatementHeader statement={statement} />
      {pageIndex === 0 && <View style={styles.balance}>
        <Text style={[styles.rtl, styles.bold]}>الرصيد الافتتاحي</Text>
        <Text style={[styles.ltr, styles.bold]}>₪{formatDecimal(statement.opening_balance)}</Text>
      </View>}
      <View style={[styles.table, { marginTop: pageIndex === 0 ? 0 : 8 }]}>
        <TableHeader columns={statementColumns} />
        {entries.map((entry) => <StatementRow entry={entry} key={entry.id} kind={statement.kind} />)}
        {!statement.entries.length && <View style={[styles.cell, { minHeight: 55, width: '100%' }]}>
          <Text style={styles.rtl}>لا توجد حركات في الفترة المحددة.</Text>
        </View>}
      </View>
      {pageIndex === pages.length - 1 && <View style={styles.footerBalance}>
        <Text style={styles.rtl}>الرصيد الختامي</Text>
        <Text style={styles.ltr}>₪{formatDecimal(statement.closing_balance)}</Text>
      </View>}
      <Text fixed render={({ pageNumber, totalPages }) => `${pageNumber} / ${totalPages}`} style={styles.pageNumber} />
    </Page>)}
  </Document>
}

function InvoiceHeader({ invoice, receipt }: { invoice: SavedInvoice; receipt: boolean }) {
  return <>
    <Text style={styles.brand}>نظام إدارة الحسابات والمتجر</Text>
    <View style={styles.invoiceHeading}>
      <View>
        <Text style={receipt ? styles.receiptTitle : styles.title}>فاتورة بيع</Text>
        <Text style={[styles.rtl, { marginTop: 3 }]}>رقم الفاتورة: {invoice.invoice_number}</Text>
      </View>
      <View>
        <Text style={styles.rtl}>التاريخ: {invoice.business_date}</Text>
        <Text style={[styles.rtl, { marginTop: 3 }]}>العميل: {invoice.customer_name ?? 'بيع نقدي'}</Text>
      </View>
    </View>
    <View style={styles.rule} />
  </>
}

function InvoiceRow({ item, receipt }: { item: SavedInvoice['items'][number]; receipt: boolean }) {
  const columns = receipt ? [
    { value: item.description, width: '46%', rtl: true },
    { value: formatDecimal(item.quantity), width: '16%', rtl: false },
    { value: `₪${formatDecimal(item.actual_price)}`, width: '19%', rtl: false },
    { value: `₪${formatDecimal(item.total)}`, width: '19%', rtl: false },
  ] : [
    { value: item.description, width: '38%', rtl: true },
    { value: formatDecimal(item.quantity), width: '14%', rtl: false },
    { value: `₪${formatDecimal(item.actual_price)}`, width: '18%', rtl: false },
    { value: `₪${formatDecimal(item.discount)}`, width: '14%', rtl: false },
    { value: `₪${formatDecimal(item.total)}`, width: '16%', rtl: false },
  ]
  return <View style={styles.tableRow} wrap={false}>
    {columns.map((column, index) => <View key={index} style={[styles.cell, { width: column.width }]}>
      <Text style={column.rtl ? styles.cellText : styles.cellLtr}>{column.value}</Text>
    </View>)}
  </View>
}

function InvoicePdfDocument({ invoice, size }: { invoice: SavedInvoice; size: 'A4' | '80mm' }) {
  const receipt = size === '80mm'
  const columns = receipt ? receiptInvoiceColumns : invoiceColumns
  return <Document title={`فاتورة ${invoice.invoice_number}`}>
    <Page size={receipt ? [226.77, 566.93] : 'A4'} style={receipt ? styles.receiptPage : styles.page}>
      <InvoiceHeader invoice={invoice} receipt={receipt} />
      <View style={[styles.table, { marginTop: 10 }]}>
        <TableHeader columns={columns} />
        {invoice.items.map((item) => <InvoiceRow item={item} key={item.id} receipt={receipt} />)}
      </View>
      <View style={[styles.invoiceSummary, receipt ? { marginLeft: '20%' } : {}]}>
        <SummaryRow label="المجموع" value={invoice.items_subtotal} />
        <SummaryRow label="خصم الفاتورة" value={invoice.invoice_discount} />
        <SummaryRow bold label="الإجمالي" value={invoice.total} />
        <SummaryRow label="المدفوع" value={invoice.paid_total} />
        <SummaryRow label="المتبقي" value={invoice.remaining_due} />
      </View>
      <Text style={styles.thanks}>شكراً لتعاملكم معنا</Text>
    </Page>
  </Document>
}

function SummaryRow({ bold = false, label, value }: { bold?: boolean; label: string; value: string }) {
  return <View style={styles.summaryRow}>
    <Text style={[styles.rtl, bold ? styles.bold : {}]}>{label}</Text>
    <Text style={[styles.ltr, bold ? styles.bold : {}]}>₪{formatDecimal(value)}</Text>
  </View>
}

export async function createStatementPdf(statement: PdfAccountStatement) {
  return pdf(<StatementPdfDocument statement={statement} />).toBlob()
}

export async function createInvoicePdf(invoice: SavedInvoice, size: 'A4' | '80mm') {
  return pdf(<InvoicePdfDocument invoice={invoice} size={size} />).toBlob()
}
