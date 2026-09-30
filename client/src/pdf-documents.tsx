/* eslint-disable react-refresh/only-export-components -- Lazily loaded PDF renderers intentionally export document factories and typed helpers. */
import { Document, Font, Page, StyleSheet, Text, View, pdf } from '@react-pdf/renderer'
import notoSansHebrewBoldUrl from './assets/fonts/NotoSansHebrew-Bold.ttf?url'
import notoSansHebrewRegularUrl from './assets/fonts/NotoSansHebrew-Regular.ttf?url'
import notoSansArabicUrl from './assets/fonts/NotoSansArabic-Variable.ttf?url'
import { movementSourceLabel } from './business-labels'
import { formatDecimal, formatQuantity } from './money-display'
import { groupStatementEntries } from './statement-groups'
import type { SavedInvoice } from './components/InvoiceOutput'

export type PdfStatementEntry = {
  id: string
  date: string
  store_name: string
  source_type: string
  source_id: string | null
  description: string | null
  document_number: string | null
  original_document_number?: string | null
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
  family: 'NotoArabic',
  fonts: [
    { src: notoSansArabicUrl, fontWeight: 400 },
    { src: notoSansArabicUrl, fontWeight: 700 },
  ],
})

Font.register({
  family: 'NotoHebrew',
  fonts: [
    { src: notoSansHebrewRegularUrl, fontWeight: 400 },
    { src: notoSansHebrewBoldUrl, fontWeight: 700 },
  ],
})

const colors = {
  ink: '#0f172a',
  muted: '#475569',
  line: '#cbd5e1',
  soft: '#f1f5f9',
}

const MAX_STATEMENT_PAGE_HEIGHT = 475

const styles = StyleSheet.create({
  page: {
    backgroundColor: '#ffffff', color: colors.ink, direction: 'rtl',
    fontFamily: 'NotoArabic', fontSize: 8.4, padding: 28,
  },
  receiptPage: {
    backgroundColor: '#ffffff', color: colors.ink, direction: 'rtl',
    fontFamily: 'NotoArabic', fontSize: 8, padding: 9,
  },
  title: { direction: 'rtl', fontSize: 22, fontWeight: 700, textAlign: 'center' },
  receiptTitle: { direction: 'rtl', fontSize: 16, fontWeight: 700, textAlign: 'center' },
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
  tableRow: { alignItems: 'stretch', flexDirection: 'row-reverse', minHeight: 40 },
  tableHeader: { backgroundColor: colors.soft, flexDirection: 'row-reverse', minHeight: 27 },
  statementDate: {
    backgroundColor: '#e2e8f0', borderBottomColor: colors.line, borderBottomWidth: 1,
    borderRightColor: colors.line, borderRightWidth: 1,
    minHeight: 22, paddingHorizontal: 6, paddingVertical: 4,
  },
  cell: {
    borderBottomColor: colors.line, borderBottomWidth: 1,
    borderRightColor: colors.line, borderRightWidth: 1,
    direction: 'rtl', justifyContent: 'flex-start', paddingHorizontal: 4,
    paddingVertical: 5, textAlign: 'right',
  },
  cellText: { direction: 'rtl', fontSize: 7.6, lineHeight: 1.75, textAlign: 'right' },
  cellSmall: { color: colors.muted, direction: 'rtl', fontSize: 6.4, lineHeight: 1.85, marginTop: 2, textAlign: 'right' },
  itemName: { color: colors.ink, direction: 'rtl', fontSize: 6.4, lineHeight: 1.8, marginTop: 3, textAlign: 'right' },
  itemFormula: { color: colors.muted, direction: 'ltr', fontFamily: 'NotoHebrew', fontSize: 6.2, lineHeight: 1.55, textAlign: 'right' },
  cellLtr: { direction: 'ltr', fontSize: 7.4, lineHeight: 1.45, textAlign: 'center' },
  documentNumber: { direction: 'ltr', fontSize: 7.5, lineHeight: 1.45, textAlign: 'center' },
  moneyCell: { alignItems: 'center', justifyContent: 'center', paddingHorizontal: 2 },
  moneyValue: {
    alignItems: 'baseline', direction: 'ltr', flexDirection: 'row',
    justifyContent: 'center', minWidth: 38,
  },
  moneyNumber: { direction: 'ltr', fontFamily: 'NotoHebrew', fontSize: 7.8, lineHeight: 1.2, textAlign: 'left' },
  moneyNumberSmall: { color: colors.muted, fontSize: 7 },
  shekelSymbol: { direction: 'ltr', fontFamily: 'NotoHebrew', fontSize: 8.2, lineHeight: 1.2, marginRight: 2 },
  footerBalance: {
    borderTopColor: colors.ink, borderTopWidth: 1.5, flexDirection: 'row-reverse',
    fontSize: 11, fontWeight: 700, justifyContent: 'space-between', marginTop: 9, paddingTop: 7,
  },
  pageNumber: { bottom: 12, color: colors.muted, fontSize: 7, left: 28, position: 'absolute' },
  invoiceHeading: { flexDirection: 'row-reverse', justifyContent: 'space-between', marginTop: 3 },
  receiptInvoiceHeading: { flexDirection: 'column' },
  invoiceSummary: { borderTopColor: colors.ink, borderTopWidth: 1.5, marginLeft: '45%', marginTop: 10, paddingTop: 6 },
  summaryRow: { flexDirection: 'row-reverse', justifyContent: 'space-between', marginBottom: 3 },
  thanks: { borderTopColor: colors.line, borderTopWidth: 1, direction: 'rtl', marginTop: 12, paddingTop: 6, textAlign: 'center' },
})

const statementColumns = [
  { key: 'description', label: 'البيان', width: '44%' },
  { key: 'document', label: 'المستند', width: '20%' },
  { key: 'debit', label: 'مدين', width: '12%' },
  { key: 'credit', label: 'دائن', width: '12%' },
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

const pdfCurrencySymbols: Record<string, string> = {
  ILS: '₪',
  USD: '$',
  JOD: 'د.أ',
}

export function formatPdfMoney(value: string, currencyCode = 'ILS') {
  const symbol = pdfCurrencySymbols[currencyCode] ?? currencyCode
  return `${symbol}${formatDecimal(value)}`
}

function MoneyValue({ bold = false, currencyCode = 'ILS', small = false, value }: {
  bold?: boolean
  currencyCode?: string
  small?: boolean
  value: string
}) {
  const amount = formatDecimal(value)
  if (currencyCode !== 'ILS') {
    return <Text style={[styles.moneyNumber, small ? styles.moneyNumberSmall : {}, bold ? styles.bold : {}]}>{formatPdfMoney(value, currencyCode)}</Text>
  }

  return <Text style={[styles.moneyNumber, small ? styles.moneyNumberSmall : {}, bold ? styles.bold : {}]}>₪{amount}</Text>
}

function PurchaseItemsList({ items }: { items: NonNullable<PdfStatementEntry['purchase_items']> }) {
  if (!items.length) return null
  return <View>
    <Text style={styles.cellSmall}>الأصناف:</Text>
    {items.map((item, index) => <View key={`${item.product}:${index}`} wrap={false}>
      <Text style={styles.itemName}>{index + 1}. {item.product}</Text>
      <Text style={styles.itemFormula}>{formatQuantity(item.quantity)} x {formatPdfMoney(item.unit_price)} = {formatPdfMoney(item.line_total)}</Text>
    </View>)}
  </View>
}

function normalizePdfText(value: string) {
  return value.replace(/\s+/g, ' ').trim()
}

function estimateStatementRowHeight(entry: PdfStatementEntry) {
  const itemCount = entry.purchase_items?.length ?? 0
  const descriptionLength = normalizePdfText(entry.description ?? '').length
  const descriptionLines = descriptionLength ? Math.max(1, Math.ceil(descriptionLength / 42)) : 0
  const projectLines = entry.project_name ? 1 : 0
  const itemNameLines = (entry.purchase_items ?? []).reduce((total, item) => {
    return total + Math.max(1, Math.ceil(normalizePdfText(item.product).length / 34))
  }, 0)
  return 32 + (entry.original_document_number ? 18 : 0) + (descriptionLines * 9) + (projectLines * 9) + (itemCount ? 8 : 0) + (itemNameLines * 10) + (itemCount * 9)
}

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
  return <View>
    <Text style={styles.title}>طلبية تسعير</Text>
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
    <View style={[styles.cell, { width: '44%' }]}>
      <Text style={[styles.cellText, styles.bold]}>{statementEntryLabel(entry, kind)}</Text>
      {entry.original_document_number && <Text style={styles.cellSmall}>الفاتورة الأصلية: {entry.original_document_number} — تاريخ المرتجع: {entry.date}</Text>}
      {entry.description && <Text style={styles.cellSmall}>{normalizePdfText(entry.description)}</Text>}
      {entry.project_name && <Text style={styles.cellSmall}>المشروع: {entry.project_name}</Text>}
      <PurchaseItemsList items={items} />
    </View>
    <View style={[styles.cell, { width: '20%' }]}>
      <Text style={styles.documentNumber}>{entry.document_number ?? `#${entry.source_id ?? entry.id}`}</Text>
    </View>
    <View style={[styles.cell, styles.moneyCell, { width: '12%' }]}>{entry.debit === '0' ? <Text style={styles.cellLtr}>—</Text> : <MoneyValue value={entry.debit} />}</View>
    <View style={[styles.cell, styles.moneyCell, { width: '12%' }]}>{entry.credit === '0' ? <Text style={styles.cellLtr}>—</Text> : <MoneyValue value={entry.credit} />}</View>
    <View style={[styles.cell, styles.moneyCell, { width: '12%' }]}><MoneyValue bold value={entry.running_balance} /></View>
  </View>
}

function StatementPdfDocument({ statement }: { statement: PdfAccountStatement }) {
  const pages = statement.entries.reduce<PdfStatementEntry[][]>((result, entry) => {
    const estimatedHeight = estimateStatementRowHeight(entry)
    const current = result.at(-1)!
    const currentHeight = current.reduce((height, item, index) =>
      height + estimateStatementRowHeight(item) + (index === 0 || item.date !== current[index - 1].date ? 22 : 0), 0)
    const dateHeight = current.length === 0 || current.at(-1)?.date !== entry.date ? 22 : 0

    if (current.length && currentHeight + dateHeight + estimatedHeight > MAX_STATEMENT_PAGE_HEIGHT) result.push([entry])
    else current.push(entry)
    return result
  }, [[]])

  return <Document title="طلبية تسعير">
    {pages.map((entries, pageIndex) => <Page key={pageIndex} size="A4" style={styles.page}>
      <StatementHeader statement={statement} />
      {pageIndex === 0 && <View style={styles.balance}>
        <Text style={[styles.rtl, styles.bold]}>الرصيد الافتتاحي</Text>
        <MoneyValue bold value={statement.opening_balance} />
      </View>}
      <View style={[styles.table, { marginTop: pageIndex === 0 ? 0 : 8 }]}>
        <TableHeader columns={statementColumns} />
        {groupStatementEntries(entries).map((group) => <View key={group.date}>
          <View style={styles.statementDate} wrap={false}>
            <Text style={[styles.rtl, styles.bold]}>{group.date}</Text>
          </View>
          {group.entries.map((entry) => <StatementRow entry={entry} key={entry.id} kind={statement.kind} />)}
        </View>)}
        {!statement.entries.length && <View style={[styles.cell, { minHeight: 55, width: '100%' }]}>
          <Text style={styles.rtl}>لا توجد حركات في الفترة المحددة.</Text>
        </View>}
      </View>
      {pageIndex === pages.length - 1 && <View style={styles.footerBalance}>
        <Text style={styles.rtl}>الرصيد الختامي</Text>
        <MoneyValue bold value={statement.closing_balance} />
      </View>}
      <Text fixed render={({ pageNumber, totalPages }) => `${pageNumber} / ${totalPages}`} style={styles.pageNumber} />
    </Page>)}
  </Document>
}

function InvoiceHeader({ invoice, receipt }: { invoice: SavedInvoice; receipt: boolean }) {
  return <>
    <Text style={receipt ? styles.receiptTitle : styles.title}>طلبية تسعير</Text>
    <View style={[styles.invoiceHeading, receipt ? styles.receiptInvoiceHeading : {}]}>
      <Text style={styles.rtl}>رقم الطلبية: {invoice.invoice_number}</Text>
      <Text style={styles.rtl}>التاريخ: {invoice.business_date}</Text>
      <Text style={styles.rtl}>العميل: {invoice.customer_name ?? 'بدون عميل'}</Text>
      <Text style={styles.rtl}>المستلم: {invoice.receiver_name ?? ''}</Text>
    </View>
    <View style={styles.rule} />
  </>
}

function InvoiceRow({ item, receipt }: { item: SavedInvoice['items'][number]; receipt: boolean }) {
  const columns = receipt ? [
    { value: item.description, width: '46%', rtl: true },
    { value: formatQuantity(item.quantity), width: '16%', rtl: false },
    { value: item.actual_price, width: '19%', money: true },
    { value: item.total, width: '19%', money: true },
  ] : [
    { value: item.description, width: '38%', rtl: true },
    { value: formatQuantity(item.quantity), width: '14%', rtl: false },
    { value: item.actual_price, width: '18%', money: true },
    { value: item.discount, width: '14%', money: true },
    { value: item.total, width: '16%', money: true },
  ]
  return <View style={styles.tableRow} wrap={false}>
    {columns.map((column, index) => <View key={index} style={[styles.cell, column.money ? styles.moneyCell : {}, { width: column.width }]}>
      {column.money ? <MoneyValue value={column.value} /> : <Text style={column.rtl ? styles.cellText : styles.cellLtr}>{column.value}</Text>}
    </View>)}
  </View>
}

function InvoicePdfDocument({ invoice, size }: { invoice: SavedInvoice; size: 'A4' | '80mm' }) {
  const receipt = size === '80mm'
  const columns = receipt ? receiptInvoiceColumns : invoiceColumns
  return <Document title={`طلبية تسعير ${invoice.invoice_number}`}>
    <Page size={receipt ? [226.77, 566.93] : 'A4'} style={receipt ? styles.receiptPage : styles.page}>
      <InvoiceHeader invoice={invoice} receipt={receipt} />
      <View style={[styles.table, { marginTop: 10 }]}>
        <TableHeader columns={columns} />
        {invoice.items.map((item) => <InvoiceRow item={item} key={item.id} receipt={receipt} />)}
      </View>
      <View style={[styles.invoiceSummary, receipt ? { marginLeft: '20%' } : {}]}>
        <SummaryRow label="المجموع" value={invoice.items_subtotal} />
        <SummaryRow label="خصم الطلبية" value={invoice.invoice_discount} />
        <SummaryRow bold label="الإجمالي" value={invoice.total} />
        <SummaryRow label="المدفوع" value={invoice.paid_total} />
        <SummaryRow label="المتبقي" value={invoice.remaining_due} />
      </View>
      {!!invoice.returns?.length && <View style={{ marginTop: 12 }}>
        <Text style={[styles.rtl, styles.bold]}>حركات المرتجع على الفاتورة</Text>
        <Text style={styles.rtl}>المبالغ أعلاه تخص الفاتورة الأصلية. المرتجعات حركات مستقلة في كشف الحساب.</Text>
        {invoice.returns.map((movement) => <View key={movement.id} style={{ marginTop: 8 }} wrap={false}>
          <Text style={styles.rtl}>مرتجع: {movement.document_number} — التاريخ: {movement.business_date}</Text>
          {movement.items.map((item, index) => <Text key={index} style={styles.rtl}>{normalizePdfText(item.description)} × {formatQuantity(item.quantity)}</Text>)}
          <SummaryRow label="قيمة المرتجع" value={movement.total} />
        </View>)}
      </View>}
      <Text style={styles.thanks}>شكراً لتعاملكم معنا</Text>
    </Page>
  </Document>
}

function SummaryRow({ bold = false, label, value }: { bold?: boolean; label: string; value: string }) {
  return <View style={styles.summaryRow}>
    <Text style={[styles.rtl, bold ? styles.bold : {}]}>{label}</Text>
    <MoneyValue bold={bold} value={value} />
  </View>
}

export async function createStatementPdf(statement: PdfAccountStatement) {
  return pdf(<StatementPdfDocument statement={statement} />).toBlob()
}

export async function createInvoicePdf(invoice: SavedInvoice, size: 'A4' | '80mm') {
  return pdf(<InvoicePdfDocument invoice={invoice} size={size} />).toBlob()
}
