export function isValidEan13(value: string) {
  if (!/^\d{13}$/.test(value)) return false
  const sum = [...value.slice(0, 12)].reduce(
    (total, digit, index) => total + Number(digit) * (index % 2 === 0 ? 1 : 3),
    0,
  )
  return String((10 - (sum % 10)) % 10) === value.at(-1)
}
