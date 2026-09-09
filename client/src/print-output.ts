export type PrintSize = 'A4' | '80mm'

export async function savePdfBlob({ blob, fileName }: { blob: Blob; fileName: string }) {
  if (blob.type && blob.type !== 'application/pdf') {
    throw new Error('تعذّر إنشاء ملف PDF صالح')
  }

  if (window.desktop) {
    const data = new Uint8Array(await blob.arrayBuffer())
    return window.desktop.savePdfData({ data, fileName })
  }

  const safeName = fileName.replace(/[<>:"/\\|?*]/g, '-').slice(0, 120) || 'مستند'
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.download = `${safeName}.pdf`
  link.href = url
  link.click()
  window.setTimeout(() => URL.revokeObjectURL(url), 10_000)
  return { saved: true, canceled: false }
}

function nextPaint() {
  return new Promise<void>((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
  })
}

export async function outputPrintDocument({
  element,
  fileName,
  mode,
  size,
}: {
  element: HTMLElement
  fileName: string
  mode: 'print' | 'pdf'
  size: PrintSize
}) {
  element.dataset.printActive = 'true'
  element.dataset.printSize = size
  document.documentElement.dataset.printSize = size
  await document.fonts.ready
  await nextPaint()

  try {
    if (mode === 'pdf' && window.desktop) {
      return await window.desktop.savePdf({ fileName, pageSize: size })
    }
    window.print()
    return { saved: false, canceled: false, browserDialog: true }
  } finally {
    delete element.dataset.printActive
    delete document.documentElement.dataset.printSize
  }
}
