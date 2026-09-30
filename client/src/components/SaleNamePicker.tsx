import { useEffect, useState } from 'react'

type Option = { id: string; name: string; phone?: string | null }

export function SaleNamePicker({ id, label, value, selectedId, options, loading = false,
  disabled = false, status, onChange, onSelect, onCommit }: {
  id: string
  label: string
  value: string
  selectedId: string
  options: Option[]
  loading?: boolean
  disabled?: boolean
  status: string
  onChange: (value: string) => void
  onSelect: (option: Option) => void
  onCommit: (value: string) => void
}) {
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(-1)
  useEffect(() => {
    if (open && active >= 0 && options[active]) {
      document.getElementById(`${id}-option-${options[active].id}`)?.scrollIntoView({ block: 'nearest' })
    }
  }, [active, id, open, options])

  function choose(option: Option) {
    onSelect(option)
    setOpen(false)
    onCommit(option.name)
  }

  return (
    <div className="relative" onBlur={(event) => {
      if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false)
    }}>
      <label className="mb-1 block font-black" htmlFor={id}>{label}</label>
      <input
        id={id} role="combobox" autoComplete="off" maxLength={150}
        aria-autocomplete="list" aria-expanded={open} aria-controls={`${id}-options`}
        aria-describedby={`${id}-status`}
        aria-activedescendant={open && options[active] ? `${id}-option-${options[active].id}` : undefined}
        className="min-h-11 w-full rounded-xl border border-slate-300 bg-white px-3 text-lg font-black outline-none focus:border-teal-600 focus:ring-4 focus:ring-teal-100 disabled:bg-slate-100"
        disabled={disabled} value={value} placeholder="ابحث أو اكتب اسماً جديداً"
        onFocus={() => { setOpen(true); setActive(-1) }}
        onChange={(event) => { onChange(event.target.value); setOpen(true); setActive(-1) }}
        onKeyDown={(event) => {
          if (event.key === 'Escape') setOpen(false)
          if (event.key === 'Tab') setOpen(false)
          if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            if (!options.length || loading) return
            event.preventDefault()
            setOpen(true)
            setActive((index) => {
              return event.key === 'ArrowDown'
                ? (index + 1) % options.length
                : (index <= 0 ? options.length - 1 : index - 1)
            })
          }
          if (event.key === 'Enter') {
            event.preventDefault()
            const choice = open && !loading ? options[active] ?? (value.trim().length > 0 && options.length === 1 ? options[0] : undefined) : undefined
            if (choice) choose(choice)
            else {
              setOpen(false)
              onCommit(value)
            }
          }
        }}
      />
      <p className="mt-1 text-xs font-bold text-teal-800" id={`${id}-status`} role="status">{loading ? 'جارٍ البحث…' : status}</p>
      {open && !disabled && (
        <div className="absolute inset-x-0 z-30 mt-1 max-h-72 overflow-y-auto rounded-xl border-2 border-slate-200 bg-white shadow-xl" id={`${id}-options`} role="listbox" aria-label={label} aria-busy={loading}>
          <button type="button" role="option" aria-selected={!value}
            className="block min-h-11 w-full border-b px-3 text-right font-bold hover:bg-slate-100"
            onClick={() => { onChange(''); setOpen(false); onCommit('') }}>بدون {id === 'sale-customer' ? 'عميل' : 'مشروع'}</button>
          {options.map((option, index) => (
            <button type="button" role="option" aria-selected={selectedId === option.id}
              id={`${id}-option-${option.id}`} key={option.id}
              className={`block min-h-12 w-full border-b border-slate-100 px-3 py-2 text-right hover:bg-teal-50 focus:bg-teal-50 ${active === index ? 'bg-teal-50' : ''}`}
              onClick={() => choose(option)}>
              <span className="block font-black">{option.name}</span>
              {option.phone && <span className="block text-sm text-slate-500" dir="ltr">{option.phone}</span>}
            </button>
          ))}
          {!loading && !options.length && <p className="p-3 text-sm text-slate-600">لا توجد أسماء مشابهة</p>}
          {!loading && value.trim() && !selectedId && <p className="border-t bg-amber-50 p-3 text-sm font-bold text-amber-900">راجع الأسماء المشابهة لتجنب التكرار. اترك الاسم الجديد في الحقل لإنشائه عند حفظ البيع.</p>}
        </div>
      )}
    </div>
  )
}
