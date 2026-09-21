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
      <span className="relative block min-h-12 w-full min-w-0 overflow-hidden rounded-xl border border-slate-300 bg-white px-3 py-3 text-left text-base font-black leading-6 text-slate-900 shadow-sm">
        <span aria-hidden="true" dir="ltr">{value}</span>
        <input
          aria-label={label}
          className="absolute inset-0 h-full w-full cursor-pointer opacity-0"
          max={max}
          min={min}
          onChange={(event) => onChange(event.target.value)}
          type="date"
          value={value}
        />
      </span>
    </label>
  )
}
