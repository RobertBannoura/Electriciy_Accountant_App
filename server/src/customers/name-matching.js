// Keep identity matching conservative. Spelling variants only affect suggestions.
export function nameKey(value) {
  return value.normalize('NFKC').trim().replace(/\s+/gu, ' ').toLowerCase()
}

function searchKey(value) {
  return nameKey(value).normalize('NFD').replace(/\p{M}/gu, '')
    .replace(/ـ/g, '').replace(/[أإآٱ]/g, 'ا').replace(/ى/g, 'ي')
}

function editDistance(left, right) {
  let previous = Array.from({ length: right.length + 1 }, (_, index) => index)
  for (let i = 0; i < left.length; i += 1) {
    const current = [i + 1]
    for (let j = 0; j < right.length; j += 1) {
      current.push(Math.min(current[j] + 1, previous[j + 1] + 1,
        previous[j] + (left[i] === right[j] ? 0 : 1)))
    }
    previous = current
  }
  return previous[right.length]
}

export function rankNameMatches(records, search) {
  const term = searchKey(search)
  if (!term) return records
  const tokens = term.split(' ')
  return records.map((record) => {
    const name = searchKey(record.name)
    let score = 0
    if (nameKey(record.name) === nameKey(search)) score = 100
    else if (name === term) score = 95
    else if (name.includes(term)) score = 90
    else if (record.phone && searchKey(record.phone).includes(term)) score = 85
    else {
      const words = name.split(' ')
      if (tokens.every((token) => words.some((word) => word.includes(token)))) score = 80
      else if (tokens.every((token) => words.some((word) => {
        const tolerance = token.length >= 6 ? 2 : token.length >= 3 ? 1 : 0
        return Math.abs(word.length - token.length) <= tolerance
          && editDistance(word, token) <= tolerance
      }))) score = 60
    }
    return { record, score }
  }).filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score || a.record.name.localeCompare(b.record.name, 'ar'))
    .map(({ record }) => record)
}
