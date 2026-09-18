import { useEffect, useState } from 'react'

const phoneQuery = '(max-width: 639px)'

export function usePhoneWeb() {
  const [isPhoneWeb, setIsPhoneWeb] = useState(
    () => !window.desktop && window.matchMedia(phoneQuery).matches,
  )

  useEffect(() => {
    if (window.desktop) {
      setIsPhoneWeb(false)
      return
    }

    const media = window.matchMedia(phoneQuery)
    const update = () => setIsPhoneWeb(media.matches)
    update()
    media.addEventListener('change', update)
    return () => media.removeEventListener('change', update)
  }, [])

  return isPhoneWeb
}
