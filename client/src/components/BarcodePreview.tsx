import { isValidEan13 } from '../barcodes/ean13'

const leftPatterns = [
  '0001101', '0011001', '0010011', '0111101', '0100011',
  '0110001', '0101111', '0111011', '0110111', '0001011',
]
const alternatePatterns = [
  '0100111', '0110011', '0011011', '0100001', '0011101',
  '0111001', '0000101', '0010001', '0001001', '0010111',
]
const rightPatterns = [
  '1110010', '1100110', '1101100', '1000010', '1011100',
  '1001110', '1010000', '1000100', '1001000', '1110100',
]
const parityPatterns = ['LLLLLL', 'LLGLGG', 'LLGGLG', 'LLGGGL', 'LGLLGG', 'LGGLLG', 'LGGGLL', 'LGLGLG', 'LGLGGL', 'LGGLGL']
const guardIndexes = new Set([0, 2, 46, 48, 92, 94])

function encodeEan13(value: string) {
  const parity = parityPatterns[Number(value[0])]
  const left = [...value.slice(1, 7)]
    .map((digit, index) =>
      parity[index] === 'L'
        ? leftPatterns[Number(digit)]
        : alternatePatterns[Number(digit)],
    )
    .join('')
  const right = [...value.slice(7)]
    .map((digit) => rightPatterns[Number(digit)])
    .join('')
  return `101${left}01010${right}101`
}

export function BarcodePreview({ barcode, productName }: { barcode: string; productName: string }) {
  if (!isValidEan13(barcode)) {
    return <p className="rounded-xl bg-amber-50 p-4 font-bold text-amber-900">هذا الباركود ليس بصيغة EAN-13 القابلة للمعاينة.</p>
  }

  const bits = encodeEan13(barcode)
  return (
    <div className="barcode-print-area rounded-2xl border border-slate-200 bg-white p-6 text-center">
      <p className="mb-3 text-lg font-black">{productName}</p>
      <svg aria-label={`باركود ${barcode}`} className="mx-auto h-auto w-full max-w-sm" role="img" viewBox="0 0 115 72">
        <rect fill="white" height="72" width="115" />
        {[...bits].map((bit, index) =>
          bit === '1' ? (
            <rect fill="black" height={guardIndexes.has(index) ? 55 : 50} key={index} width="1" x={10 + index} y="2" />
          ) : null,
        )}
        <text direction="ltr" fontFamily="Arial, sans-serif" fontSize="8" textAnchor="middle" x="57.5" y="68">{barcode}</text>
      </svg>
    </div>
  )
}
