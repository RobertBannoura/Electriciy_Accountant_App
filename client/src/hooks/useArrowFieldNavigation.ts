import { useEffect } from 'react'

const controlSelector = 'a[href], button, input, select, summary, textarea, [tabindex]'
const backControlSelector = '[data-arrow-navigation-back]'
const dateInputTypes = new Set(['date', 'datetime-local', 'month', 'time', 'week'])
const nativeArrowInputTypes = new Set(['color', 'file', 'number', 'radio', 'range'])

function isAvailableControl(element: EventTarget | null): element is HTMLElement {
  if (!(element instanceof HTMLElement)) return false
  if (!element.matches(controlSelector)) return false
  if (element instanceof HTMLInputElement && element.type === 'hidden') return false
  if (element.matches(':disabled') || element.tabIndex < 0 || element.getAttribute('aria-hidden') === 'true') return false
  if (element instanceof HTMLInputElement && element.readOnly) return false
  if (element instanceof HTMLTextAreaElement && element.readOnly) return false
  if (element.closest('[inert], [hidden], [aria-hidden="true"]')) return false
  if (element.getClientRects().length === 0 || getComputedStyle(element).visibility !== 'visible') return false
  return true
}

function activeModal() {
  return Array.from(document.querySelectorAll<HTMLElement>('[aria-modal="true"]'))
    .reverse().find((candidate) => candidate.getClientRects().length > 0 && getComputedStyle(candidate).visibility === 'visible') ?? null
}

function scopeFor(source: HTMLElement | null) {
  return activeModal()
    ?? (source?.matches(backControlSelector) ? document.querySelector('[data-arrow-navigation]') : null)
    ?? source?.closest('[role="dialog"], dialog')
    ?? source?.closest('[data-arrow-navigation]')
    ?? source?.closest('main')
    ?? document.querySelector('[data-arrow-navigation]')
    ?? document.getElementById('root')
}

function controlsIn(scope: Element) {
  const controls = Array.from(scope.querySelectorAll(controlSelector)).filter(isAvailableControl)
  if (scope.matches('[data-arrow-navigation]') && !activeModal()) {
    const backControl = document.querySelector<HTMLElement>(backControlSelector)
    if (isAvailableControl(backControl)) controls.unshift(backControl)
  }
  return controls
}

function focusControl(control: HTMLElement) {
  control.focus()
  control.scrollIntoView({ block: 'nearest', inline: 'nearest' })
}

function nextControlAfter(source: HTMLElement) {
  const scope = scopeFor(source)
  if (!scope) return null
  const controls = controlsIn(scope)
  const index = controls.indexOf(source)
  if (index < 0) return null
  const following = controls.slice(index + 1)
  return following.find((control) => control.matches('input, select, textarea')) ?? following[0] ?? null
}

function controlInDirection(source: HTMLElement, controls: HTMLElement[], key: string) {
  const current = source.getBoundingClientRect()
  const centerX = current.left + current.width / 2
  const centerY = current.top + current.height / 2
  const horizontal = key === 'ArrowLeft' || key === 'ArrowRight'
  const sign = key === 'ArrowDown' || key === 'ArrowRight' ? 1 : -1
  let closest: HTMLElement | null = null
  let bestScore = Infinity

  for (const control of controls) {
    if (control === source) continue
    const rect = control.getBoundingClientRect()
    const dx = rect.left + rect.width / 2 - centerX
    const dy = rect.top + rect.height / 2 - centerY
    const distance = sign * (horizontal ? dx : dy)
    if (distance <= 2) continue
    const crossDistance = Math.abs(horizontal ? dy : dx)
    const score = distance + crossDistance * 2
    if (score < bestScore) {
      bestScore = score
      closest = control
    }
  }

  return closest
}

export function useArrowFieldNavigation() {
  useEffect(() => {
    function navigate(event: KeyboardEvent) {
      if (event.defaultPrevented || event.isComposing || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return
      if (!['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(event.key)) return
      if (event.target instanceof HTMLElement && event.target.closest('[contenteditable="true"]')) return

      const modal = activeModal()
      const source = isAvailableControl(event.target) && (!modal || modal.contains(event.target)) ? event.target : null
      // These controls already use arrows to edit a value or choose an option.
      if (source instanceof HTMLSelectElement || source instanceof HTMLTextAreaElement) return
      if (source instanceof HTMLInputElement && (nativeArrowInputTypes.has(source.type) || source.list)) return

      const rtl = getComputedStyle(source ?? document.documentElement).direction === 'rtl'
      const forward = event.key === 'ArrowDown' || (event.key === 'ArrowLeft' && rtl) || (event.key === 'ArrowRight' && !rtl)
      const horizontal = event.key === 'ArrowLeft' || event.key === 'ArrowRight'
      const dateInput = source instanceof HTMLInputElement && dateInputTypes.has(source.type)
      if (horizontal && dateInput) return
      if (horizontal && source instanceof HTMLInputElement) {
        const cursor = source.selectionStart
        if (cursor !== null) {
          if (cursor !== source.selectionEnd) return
          if (forward ? cursor < source.value.length : cursor > 0) return
        }
      }

      const scope = scopeFor(source)
      if (!scope) return

      const controls = controlsIn(scope)
      const index = source ? controls.indexOf(source) : -1
      const next = index < 0
        ? (forward ? controls[0] : controls[controls.length - 1])
        : dateInput
          ? controls[index + (forward ? 1 : -1)]
          : controlInDirection(source!, controls, event.key) ?? controls[index + (forward ? 1 : -1)]
      if (!next) return

      event.preventDefault()
      focusControl(next)
    }

    function advanceAfterActivation(event: KeyboardEvent) {
      if (event.key !== 'Enter' || event.repeat || event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return
      const source = event.target
      if (!(source instanceof HTMLButtonElement) || source.closest('[role="listbox"]')) return
      window.requestAnimationFrame(() => {
        const dialog = activeModal()
        if (dialog && !dialog.contains(source)) {
          const controls = controlsIn(dialog)
          const first = controls.find((control) => control.matches('input, select, textarea')) ?? controls[0]
          if (first) focusControl(first)
        }
      })
    }

    function advanceAfterDate(event: KeyboardEvent) {
      if (event.key !== 'Enter' || event.defaultPrevented || event.isComposing || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return
      const source = event.target
      if (!(source instanceof HTMLInputElement) || !dateInputTypes.has(source.type)) return
      const next = nextControlAfter(source)
      if (!next) return
      event.preventDefault()
      focusControl(next)
    }

    function advanceAfterSelect(event: KeyboardEvent) {
      if (event.key !== 'Enter' || event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return
      const source = event.target
      if (!(source instanceof HTMLSelectElement)) return
      window.requestAnimationFrame(() => {
        if (source.isConnected && document.activeElement === source) {
          const next = nextControlAfter(source)
          if (next) focusControl(next)
        }
      })
    }

    window.addEventListener('keydown', navigate)
    window.addEventListener('keydown', advanceAfterActivation)
    window.addEventListener('keydown', advanceAfterDate)
    window.addEventListener('keyup', advanceAfterSelect)
    return () => {
      window.removeEventListener('keydown', navigate)
      window.removeEventListener('keydown', advanceAfterActivation)
      window.removeEventListener('keydown', advanceAfterDate)
      window.removeEventListener('keyup', advanceAfterSelect)
    }
  }, [])
}
