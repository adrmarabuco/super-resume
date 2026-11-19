export type Scope = 'branch' | 'project' | 'all'

export type SessionReport = {
  id: string
  title: string
  /** The session this one was forked from (its `forkedFrom`), or ''. */
  parent: string
  firstPrompt: string
  lastPrompt: string
  lastReply: string
  startedAt: string
  endedAt: string
  durationMs: number
  cwd: string
  branch: string
  model: string
  turns: number
  toolCalls: number
  contextTokens: number
  contextWindow: number
  /** Files edited, with the lines added and removed in each. */
  files: FileDiff[]
  added: number
  removed: number
  /** Every reply's tokens, this session's own. */
  usage: TokenUsage
  /** Its subagents' transcripts: how many, and their tokens. */
  agents: { count: number; usage: TokenUsage; isPartial: boolean }
  isPartial: boolean
}

export type TreeNode = { title: string; endedAt: string; parent: string }

export type FileDiff = { path: string; added: number; removed: number }

/** `input`: fresh input + cache writes; `cache`: cache reads. */
export type TokenUsage = { input: number; output: number; cache: number }

export type Listing = {
  scope: Scope
  root: string
  branch: string
  sessions: SessionReport[]
  /**
   * Every session read for this listing, the listed ones and the ancestors
   * of a fork, by id: enough to name a parent, walk a chain, count forks.
   */
  tree: Record<string, TreeNode>
  isLoading: boolean
  error: string
}

declare module 'claude-code' {
  interface PluginState {
    'super-resume': {
      scope: Scope
      selected: string
      listing: Shaped<Listing>
    }
  }
}
