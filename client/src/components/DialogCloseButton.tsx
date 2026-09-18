type DialogCloseButtonProps = {
  onClick: () => void
  ariaLabel?: string
  className?: string
}

export function DialogCloseButton({
  onClick,
  ariaLabel = 'إغلاق',
  className = '',
}: DialogCloseButtonProps) {
  return (
    <button
      aria-label={ariaLabel}
      className={`size-11 shrink-0 rounded-full bg-rose-50 text-2xl font-black leading-none text-rose-700 ring-1 ring-rose-200 transition hover:bg-rose-100 hover:text-rose-800 focus:outline-none focus:ring-4 focus:ring-rose-200 ${className}`}
      onClick={onClick}
      type="button"
    >
      ×
    </button>
  )
}
