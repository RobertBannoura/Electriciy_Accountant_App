export function groupStatementEntries<T extends { date: string }>(entries: T[]) {
  const groups: Array<{ date: string; entries: T[] }> = []
  for (const entry of entries) {
    const current = groups.at(-1)
    if (current?.date === entry.date) current.entries.push(entry)
    else groups.push({ date: entry.date, entries: [entry] })
  }
  return groups
}
