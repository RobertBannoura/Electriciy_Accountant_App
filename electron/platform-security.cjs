const fs = require('node:fs/promises')
const path = require('node:path')

const maxPdfBytes = 50 * 1024 * 1024
const forbiddenPdfAction = /\/(?:JavaScript|JS|Launch|EmbeddedFiles?|OpenAction|AA|URI|GoToR|SubmitForm|ImportData|RichMedia|XFA)(?=[^A-Za-z0-9]|$)/i

function safeSuggestedName(value, fallback = 'مستند') {
  const requested = typeof value === 'string' ? value : fallback
  const printable = [...requested]
    .filter((character) => {
      const code = character.charCodeAt(0)
      return code >= 32 && code !== 127
    })
    .join('')
  return printable.replace(/[<>:"/\\|?*]/g, '-').replace(/[. ]+$/g, '').slice(0, 120) || fallback
}

function pdfBuffer(value) {
  if (Buffer.isBuffer(value)) return value
  if (ArrayBuffer.isView(value)) return Buffer.from(value.buffer, value.byteOffset, value.byteLength)
  if (value instanceof ArrayBuffer) return Buffer.from(value)
  return null
}

function assertSafePdfData(value) {
  const data = pdfBuffer(value)
  if (!data || data.length < 5 || data.length > maxPdfBytes
    || data.subarray(0, 5).toString('ascii') !== '%PDF-') {
    throw new TypeError('بيانات PDF غير صالحة')
  }

  // React-PDF and Chromium do not need interactive PDF actions. Decode PDF
  // name escapes before looking for the active-content primitives most often
  // used for scripts, launches, embedded files, forms, or remote navigation.
  const syntax = data.toString('latin1').replace(/#([0-9a-f]{2})/gi, (_match, hex) => (
    String.fromCharCode(Number.parseInt(hex, 16))
  ))
  if (forbiddenPdfAction.test(syntax)) {
    throw new TypeError('لا يسمح بحفظ PDF يحتوي على إجراءات أو موارد تفاعلية')
  }
  return data
}

async function assertSafeSelectedFile(filePath, extension, { fsApi = fs } = {}) {
  if (typeof filePath !== 'string' || !path.isAbsolute(filePath)
    || path.extname(filePath).toLowerCase() !== extension) {
    throw new TypeError('مسار ملف الحفظ غير صالح')
  }
  const parent = path.dirname(filePath)
  const parentStats = await fsApi.stat(parent)
  if (!parentStats.isDirectory()) throw new TypeError('مجلد الحفظ غير صالح')

  try {
    const targetStats = await fsApi.lstat(filePath)
    if (targetStats.isSymbolicLink() || !targetStats.isFile()) {
      throw new TypeError('لا يسمح بالكتابة عبر رابط أو مسار غير عادي')
    }
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }
  return filePath
}

function desktopCheckNotification(options) {
  if (!options || typeof options !== 'object' || Array.isArray(options)
    || !Number.isInteger(options.count) || options.count < 1 || options.count > 10_000) {
    throw new TypeError('بيانات إشعار سطح المكتب غير صالحة')
  }
  const messages = {
    checks_due: {
      title: 'شيكات مستحقة اليوم',
      body: `يوجد ${options.count} شيك مستحق. افتح التطبيق لعرض التفاصيل.`,
    },
    checks_bounced: {
      title: 'شيكات مرتجعة تحتاج متابعة',
      body: `يوجد ${options.count} شيك مرتجع يحتاج متابعة. افتح التطبيق لعرض التفاصيل.`,
    },
  }
  const content = messages[options.kind]
  if (!content || Object.keys(options).some((key) => !['kind', 'count'].includes(key))) {
    throw new TypeError('نوع إشعار سطح المكتب غير صالح')
  }
  return content
}

module.exports = {
  assertSafePdfData,
  assertSafeSelectedFile,
  desktopCheckNotification,
  maxPdfBytes,
  safeSuggestedName,
}
