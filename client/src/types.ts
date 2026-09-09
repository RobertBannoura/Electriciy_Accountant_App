export type Store = {
  id: string
  code: string
  name: string
}

export type SaveState = 'idle' | 'saving' | 'saved' | 'error'
