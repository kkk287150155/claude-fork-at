export type CutPoint = { uuid: string; kind: 'prompt' | 'reply' | 'tool'; label: string }

declare module 'claude-code' {
  interface PluginState {
    'fork-at': {
      points: CutPoint[]
      chosen: string
      status: string
      page: number
    }
  }
}
