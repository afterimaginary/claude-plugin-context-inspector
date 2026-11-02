export type Compaction = {
  at: string
  trigger: string
  preTokens?: number
  postTokens?: number
  durationMs?: number
  prompts?: number
  summary: string
  /** Tokens the summary message takes, wrapper text included: an estimate. */
  summaryTokens: number
  context: CompactionContext
}

/** One thing attached again after the compaction; tokens are estimates. */
export type ContextItem = { name: string; tokens?: number; lines?: number; isNameOnly?: boolean }

export type KeptMessage = { role: string; text: string; tokens: number }

/** What came back with the summary: read from the rows written just after it. */
export type CompactionContext = {
  files: ContextItem[]
  skills: ContextItem[]
  instructions: ContextItem[]
  plan?: ContextItem
  tasks: ContextItem[]
  tools: string[]
  keptIds: string[]
  kept: KeptMessage[]
}

/** The full summary page's tabs: the summary itself, its changes grouped by section, or marked inline. */
export type Tab = 'summary' | 'sections' | 'inline'

export type View = 'overview' | 'summary'

declare module 'claude-code' {
  interface PluginState {
    'compaction-viewer': {
      compactions: Shaped<Compaction[]>
      selected: number | null
      view: View
      summaryTab: Tab
      /** The overview rows shown open, by id. */
      open: string[]
    }
  }
}
