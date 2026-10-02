type DateFieldProps = {
  label: string
  max?: string
  min?: string
  onChange: (value: string) => void
  value: string
}

export function DateField({ label, max, min, onChange, value }: DateFieldProps) {
  return (
    <label className="block min-w-0 font-bold text-slate-700">
      <span className="mb-2 block font-black">{label}</span>
      <input
        aria-label={label}
        className="min-h-12 w-full min-w-0 rounded-xl border border-slate-300 bg-white px-3 text-base font-black text-slate-900 shadow-sm focus:border-teal-600 focus:outline-none focus:ring-4 focus:ring-teal-100"
        dir="ltr"
        max={max}
        min={min}
        onChange={(event) => onChange(event.target.value)}
        type="date"
        value={value}
      />
    </label>
  )
}
