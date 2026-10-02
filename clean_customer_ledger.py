#!/usr/bin/env python3
"""Clean this Customers ledger format without changing the source workbook.

Python 3.10+, standard library only. No Excel installation required.
  python clean_customer_ledger.py "latest.xlsm" --out "cleaned"
Review customer_mapping.csv, then confirm names with an aliases CSV containing:
  original_name,customer_id,customer_name
  ابراهيم جبران 7,IBRAHIM_J,ابراهيم جبران
  ابراهيم جبران 8,IBRAHIM_J,ابراهيم جبران
  ابراهيم جبران 9,IBRAHIM_J,ابراهيم جبران
  ابراهيم جبران 10,IBRAHIM_J,ابراهيم جبران
  python clean_customer_ledger.py "latest.xlsm" --out "cleaned2" --aliases aliases.csv

Outputs (UTF-8 BOM CSV for Arabic in Excel):
 customer_mapping.csv: proposed numbered continuations; confirmed=1 only for
   explicit aliases or unique unnumbered names. Slash/project names stay separate.
 sections.csv: opening, movement and closing values with original Excel rows.
 transactions.csv: purchases/returns/credits/payments; NO carried balances.
 customers.csv: ONE latest recorded balance per proposed/confirmed customer.
 opening_balances_import.csv: only reviewed, reconciled customer snapshots.
 issues.csv: missing data, ambiguous identities, formula/reference issues.
 summary.json: counts, source SHA256 and totals; blocked totals aren't final debt.

IMPORT CHOICE: For go-live, import opening_balances_import.csv as opening debt
once per customer. Historical transactions are an archive, NOT additional debt
on top of that snapshot. For a full-history import, use the first section opening
plus transactions plus reviewed adjustments; reconcile to each latest balance.
Never import every section opening. Negative balances mean customer credit.
Blank prices remain blank and are flagged. Rounding differences <=1 are allowed
and recorded, never used to rewrite balances. Larger unexplained gaps block import.
Source cached Excel formula values must be current: save the workbook in Excel
after recalculation before running. This program doesn't execute Excel macros.
Outputs are staging files; it does not connect to or write your application DB.
"""
import argparse
import csv
import hashlib
import json
import re
import unicodedata
import zipfile
from collections import defaultdict
from datetime import datetime, timedelta
from decimal import Decimal, InvalidOperation
from pathlib import Path
import posixpath
import xml.etree.ElementTree as ET

NS = {'m': 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'}
RID = '{http://schemas.openxmlformats.org/officeDocument/2006/relationships}id'
ZERO = Decimal(0)

def norm(value):
    return ' '.join(unicodedata.normalize('NFC', str(value or '')).split())

def number(value):
    try:
        return Decimal(str(value)) if value is not None and str(value).strip() else None
    except InvalidOperation:
        return None

def fmt(value):
    return '' if value is None else format(value.quantize(Decimal('.01')), 'f')

def load_workbook(path):
    """Read OOXML values/formulas directly; never edit or execute workbook code."""
    result = {}
    with zipfile.ZipFile(path) as z:
        strings = []
        if 'xl/sharedStrings.xml' in z.namelist():
            strings = [''.join(el.itertext()) for el in ET.fromstring(z.read('xl/sharedStrings.xml')).findall('m:si', NS)]
        rels = {el.get('Id'): el.get('Target') for el in ET.fromstring(z.read('xl/_rels/workbook.xml.rels'))}
        for sheet in ET.fromstring(z.read('xl/workbook.xml')).findall('m:sheets/m:sheet', NS):
            target = rels[sheet.get(RID)]
            target = target.lstrip('/') if target.startswith('/') else posixpath.normpath('xl/' + target)
            rows = {}
            for row in ET.fromstring(z.read(target)).findall('m:sheetData/m:row', NS):
                cells = {}
                for cell in row.findall('m:c', NS):
                    v, f = cell.find('m:v', NS), cell.find('m:f', NS)
                    value = v.text if v is not None else None
                    if cell.get('t') == 's' and value is not None:
                        value = strings[int(value)]
                    elif cell.get('t') == 'inlineStr':
                        value = ''.join(cell.find('m:is', NS).itertext())
                    cells[re.sub(r'\d', '', cell.get('r'))] = {'v': value, 'f': f.text if f is not None else None, 'formula': f is not None}
                rows[int(row.get('r'))] = cells
            result[sheet.get('name')] = rows
    return result

def value(rows, row, col):
    return rows.get(row, {}).get(col, {}).get('v')

def dated(value_):
    n = number(value_)
    if n is not None and Decimal(35000) < n < Decimal(65000):
        return (datetime(1899, 12, 30) + timedelta(days=float(n))).date().isoformat()
    for pattern in ('%d/%m/%Y', '%d/%m/%y', '%d-%m-%Y', '%Y-%m-%d'):
        try:
            return datetime.strptime(norm(value_), pattern).date().isoformat()
        except ValueError:
            pass
    return ''

def write_csv(path, records, fields):
    with path.open('w', encoding='utf-8-sig', newline='') as f:
        writer = csv.DictWriter(f, fieldnames=fields, extrasaction='ignore')
        writer.writeheader()
        writer.writerows(records)

def clean(source, out, aliases_path=None):
    sheets = load_workbook(source)
    sheet_name = next((n for n in sheets if n.casefold() == 'customers'), None)
    if sheet_name is None:
        raise ValueError('Customers sheet not found.')
    rows = sheets[sheet_name]
    headers = [r for r in sorted(rows) if norm(value(rows, r, 'A')).casefold() in {'arecivebal', 'areceivable', 'receivable'} and norm(value(rows, r, 'G'))]
    if not headers:
        raise ValueError('No recognized customer headers; workbook format differs.')
    aliases = {}
    if aliases_path:
        with Path(aliases_path).open(encoding='utf-8-sig', newline='') as f:
            for row in csv.DictReader(f):
                if not all(norm(row.get(k)) for k in ('original_name', 'customer_id', 'customer_name')):
                    raise ValueError('Aliases require original_name, customer_id, customer_name.')
                key = norm(row['original_name'])
                if key in aliases and aliases[key] != row:
                    raise ValueError('Conflicting aliases for ' + key)
                aliases[key] = row
    issues, sections, transactions, groups = [], [], [], defaultdict(list)
    def issue(code, section, row, detail, block=True):
        issues.append(dict(code=code, customer_id=section.get('customer_id', ''), section_id=section.get('section_id', ''), source_row=row, blocks_import=int(block), detail=detail))
        if block:
            section['_blocked'] = True
    for index, start in enumerate(headers):
        end = headers[index + 1] - 1 if index + 1 < len(headers) else max(rows)
        original = norm(value(rows, start, 'G'))
        # Only propose simple terminal counters; never strip phone numbers or A1.
        proposed = re.sub(r'\s+[0-9]{1,3}$', '', original) if '/' not in original else original
        mapped = aliases.get(original)
        key = mapped['customer_id'] if mapped else 'candidate_' + hashlib.sha256(proposed.encode()).hexdigest()[:12]
        sec = dict(section_id=f'S{start}', customer_id=key, customer_name=mapped['customer_name'] if mapped else proposed, original_name=original, source_start=start, source_end=end, identity_confirmed=int(bool(mapped)), _blocked=False)
        groups[key].append(sec)
        summaries = [r for r in range(start + 1, end + 1) if re.match(r'^SUM\(C', rows.get(r, {}).get('C', {}).get('f') or '', re.I) and rows.get(r, {}).get('A', {}).get('formula')]
        if len(summaries) != 1:
            issue('SUMMARY_NOT_UNIQUE', sec, start, f'Found {len(summaries)} section total rows; review boundary/formulas.')
        total_row = summaries[0] if summaries else end + 1
        sec['source_total_row'] = total_row
        opening_row = start + 1
        opening_a, opening_b = number(value(rows, opening_row, 'A')), number(value(rows, opening_row, 'B'))
        priced_first = number(value(rows, opening_row, 'D')) is not None or number(value(rows, opening_row, 'E')) is not None
        opening = (opening_a or ZERO) - (opening_b or ZERO) if not priced_first else ZERO
        sec['opening_balance'] = fmt(opening)
        if priced_first and opening_a:
            issue('UNCLEAR_OPENING', sec, opening_row, 'Opening row also contains product data.')
        delta, sales, offsets = ZERO, ZERO, ZERO
        current_date = ''
        for r in range(start + 1, total_row):
            label = norm(value(rows, r, 'F'))
            rawdate = value(rows, r, 'G')
            date = dated(rawdate)
            if date:
                current_date = date
            price, qty, cached = [number(value(rows, r, col)) for col in ('D', 'E', 'C')]
            payment = number(value(rows, r, 'B'))
            base = dict(transaction_id=f'{sheet_name}:{r}', customer_id=key, section_id=sec['section_id'], source_sheet=sheet_name, source_row=r, date=current_date, date_inherited=int(not bool(date) and bool(current_date)), raw_date_or_note=rawdate or '', description=label, unit_price=fmt(price), quantity=fmt(qty), amount='', balance_delta='')
            if r == opening_row and not priced_first:
                continue  # Both A debt and B credit are opening balances.
            if price is not None and qty is not None:
                amount = price * qty
                if cached is not None and abs(cached - amount) > Decimal('.01'):
                    issue('LINE_TOTAL_MISMATCH', sec, r, f'Cached C={fmt(cached)}, price*quantity={fmt(amount)}.')
                if amount or label:
                    transactions.append(dict(base, transaction_id=base['transaction_id']+':item', type='sale' if amount >= 0 else 'return', amount=fmt(abs(amount)), balance_delta=fmt(amount)))
                    delta += amount
                    sales += amount
            elif price is not None or qty is not None:
                issue('MISSING_PRICE_OR_QUANTITY', sec, r, f'{label}: price={fmt(price)}, quantity={fmt(qty)}. No value invented.')
                transactions.append(dict(base, type='incomplete_item'))
            elif cached:
                issue('UNCLASSIFIED_CHARGE', sec, r, f'Amount {fmt(cached)} without complete price/quantity; preserved for review.')
                transactions.append(dict(base, type='unclassified_charge', amount=fmt(abs(cached)), balance_delta=fmt(cached)))
                delta += cached
                sales += cached
            if payment:
                kind = 'return_credit' if 'مرتجع' in label else 'discount' if 'خصم' in label else 'cheque_payment' if 'شيك' in label else 'payment' if any(w in label for w in ('دفع', 'تسديد', 'نقد', 'كاش')) else 'unclassified_credit'
                transactions.append(dict(base, transaction_id=base['transaction_id']+':credit', type=kind, amount=fmt(abs(payment)), balance_delta=fmt(-payment)))
                delta -= payment
                offsets += payment
                if kind == 'unclassified_credit':
                    issue('PAYMENT_TYPE_UNCLEAR', sec, r, 'Credit amount is preserved; cash versus return/discount requires classification.', False)
            # A-column intermediate subtotal notes are deliberately not transactions.
        closing = number(value(rows, total_row, 'A'))
        sec.update(new_sales_net=fmt(sales), payments_and_credits=fmt(offsets), net_movement=fmt(delta), calculated_closing=fmt(opening+delta), recorded_closing=fmt(closing))
        if closing is None:
            issue('MISSING_CLOSING', sec, total_row, 'Missing cached closing balance; recalculate and save in Excel.')
        elif abs(closing - opening - delta) > Decimal(1):
            issue('SECTION_DOES_NOT_RECONCILE', sec, total_row, f'Recorded {fmt(closing)} versus reconstructed {fmt(opening+delta)}.')
        elif closing != opening + delta:
            issue('ROUNDING_DIFFERENCE', sec, total_row, fmt(closing-opening-delta), False)
        sections.append(sec)
    customers, mapping = [], []
    for key, chain in groups.items():
        unique_originals = {s['original_name'] for s in chain}
        confirmed = all(s['identity_confirmed'] for s in chain) or (len(unique_originals) == 1 and chain[0]['original_name'] == chain[0]['customer_name'])
        if not confirmed:
            issue('CONFIRM_CUSTOMER_MAPPING', chain[-1], chain[-1]['source_start'], 'Confirm proposed numbered continuation using --aliases; no identity guessed for import.')
        for prev, nxt in zip(chain, chain[1:]):
            prev_close, next_open = number(prev['recorded_closing']), number(nxt['opening_balance'])
            if prev_close is None or abs(next_open-prev_close) > Decimal(1):
                issue('CARRY_CHAIN_GAP', nxt, nxt['source_start']+1, f'Previous closing={fmt(prev_close)}, next opening={fmt(next_open)}. May be separate account or missing transactions.')
            elif prev_close != next_open:
                issue('CARRY_ROUNDING', nxt, nxt['source_start']+1, fmt(next_open-prev_close), False)
        latest = chain[-1]
        ready = confirmed and not any(s['_blocked'] for s in chain)
        customers.append(dict(customer_id=key, customer_name=latest['customer_name'], section_count=len(chain), latest_section_id=latest['section_id'], latest_balance=latest['recorded_closing'], import_ready=int(ready), identity_confirmed=int(confirmed), balance_basis='latest section in workbook order; verify same account chain'))
        for s in chain:
            mapping.append(dict(original_name=s['original_name'], customer_id=key, customer_name=s['customer_name'], confirmed=int(confirmed), source_start=s['source_start']))
    # Sales report is audited only. Raw Customers data owns reconstruction.
    report = sheets.get('تقرير مبيعات', {})
    covered = set()
    for r, cells in report.items():
        name_formula = cells.get('G', {}).get('f') or ''
        name_match = re.search(r"Customers!?\!?G(\d+)$", name_formula, re.I)
        if not name_match:
            continue
        covered.add(int(name_match[1]))
        refs = [re.search(r'Customers!([ABC])(\d+)$', cells.get(col, {}).get('f') or '', re.I) for col in 'DEF']
        if not all(refs) or [m[1] for m in refs] != list('ABC') or len({m[2] for m in refs}) != 1:
            issue('REPORT_WRONG_REFERENCE', {}, r, 'Report row mixes source totals or columns; not used by cleaner.', False)
    missing = sorted(set(headers)-covered)
    if report and missing:
        issue('REPORT_MISSING_SECTIONS', {}, '', f'{len(missing)} Customers headers absent from report: '+','.join(map(str, missing)), False)
    out.mkdir(parents=True, exist_ok=False)
    section_fields = ['section_id','customer_id','customer_name','original_name','source_start','source_end','source_total_row','opening_balance','new_sales_net','payments_and_credits','net_movement','calculated_closing','recorded_closing']
    write_csv(out/'sections.csv', sections, section_fields)
    write_csv(out/'transactions.csv', transactions, ['transaction_id','customer_id','section_id','source_sheet','source_row','date','date_inherited','raw_date_or_note','type','description','unit_price','quantity','amount','balance_delta'])
    write_csv(out/'customer_mapping.csv', mapping, ['original_name','customer_id','customer_name','confirmed','source_start'])
    write_csv(out/'customers.csv', customers, ['customer_id','customer_name','section_count','latest_section_id','latest_balance','import_ready','identity_confirmed','balance_basis'])
    write_csv(out/'opening_balances_import.csv', [dict(customer_id=c['customer_id'], customer_name=c['customer_name'], opening_balance=c['latest_balance']) for c in customers if c['import_ready']], ['customer_id','customer_name','opening_balance'])
    write_csv(out/'issues.csv', issues, ['code','customer_id','section_id','source_row','blocks_import','detail'])
    summary = dict(source_file=source.name, source_sha256=hashlib.sha256(source.read_bytes()).hexdigest(), sections=len(sections), proposed_customers=len(customers), transactions=len(transactions), import_ready_customers=sum(c['import_ready'] for c in customers), blocked_customers=sum(not c['import_ready'] for c in customers), issue_counts=dict(__import__('collections').Counter(i['code'] for i in issues)), ready_net_balance=fmt(sum((number(c['latest_balance']) or ZERO for c in customers if c['import_ready']), ZERO)), note='Only ready rows exported for opening-balance import. Net includes customer credits. No whole-workbook final debt is claimed. Do not add archived history to imported closing snapshots.')
    (out/'summary.json').write_text(json.dumps(summary, ensure_ascii=False, indent=2), encoding='utf-8')
    return summary

if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('workbook', type=Path)
    parser.add_argument('--out', type=Path, required=True, help='New output folder; existing folders are never overwritten.')
    parser.add_argument('--aliases', type=Path)
    args = parser.parse_args()
    try:
        print(json.dumps(clean(args.workbook, args.out, args.aliases), ensure_ascii=False, indent=2))
    except (ValueError, FileExistsError, zipfile.BadZipFile) as exc:
        parser.exit(1, str(exc)+'\n')
