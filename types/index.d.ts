export type Scope = 'branch' | 'project' | 'all'

export type SessionReport = {
  id: string
  /** The transcript this report was read from. */
  transcript: string
  title: string
  /** The session this one came from (a fork's, a /clear's, the one that ran it), or ''. */
  parent: string
  /** How it came from `parent`: forked, continued after /clear, or started by it. */
  parentVia: ParentVia
  firstPrompt: string
  lastPrompt: string
  lastReply: string
  startedAt: string
  endedAt: string
  durationMs: number
  /** Time the model was working: the sum of its turns (`turn_duration`). */
  activeMs: number
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
  agents: { count: number; usage: TokenUsage; isPartial: boolean; maxDepth: number; unfinished: number }
  quality: Quality
  delegation: Delegation
  wip: Wip
  /** The plans this session wrote (ExitPlanMode), one per plan file. */
  plans: PlanRef[]
  /** Plan files (base names) this session named: read, edited or quoted. */
  mentions: string[]
  /** `git commit` commands it ran. */
  commits: number
  /** Up to 24 points: work time per turn. */
  series: { activity: number[] }
  /** The effort of the last reply (`low` … `max`), or '' when not recorded. */
  effort: string
  /** Replies by effort level, every reply of the main agent counted. */
  effortMix: Record<string, number>
  /** Whether the transcript's format was recognised: see `Signals`. */
  signals: Signals
  isPartial: boolean
}

/**
 * Checks that the internal transcript text this report reads (refusal and
 * interrupt phrases, task notifications, tool result links) was recognised.
 * None of it is a public interface: when a Claude Code update changes it, the
 * counts would drop to zero and a session would score perfect, so the score
 * says it cannot judge instead.
 */
export type Signals = {
  /** The Claude Code version that wrote the transcript (its last line). */
  version: string
  /** Tool results that answered a tool call of this session. */
  linkedResults: number
  /** Why the format looks changed; empty when all was recognised. */
  unrecognised: string[]
}

/** How the person and the tools answered the agent. */
export type Quality = {
  /** Tool calls the person turned down (plans and questions apart). */
  rejected: number
  /** Of those, the ones that came with a correction. */
  rejectedWithFeedback: number
  /** The last correction's words. */
  lastFeedback: string
  /** Turns the person stopped (Esc), a refusal's own stop counted once. */
  interrupts: number
  /** Tool calls that failed on their own. */
  toolErrors: number
  compactions: number
  /** Plans sent back with comments: a revision, not a failure. */
  plansRevised: number
  /** Plans turned down with no comment. */
  plansRejected: number
  /** Questions the person answered by asking back. */
  clarified: number
}

export type Delegation = {
  /** Subagents started, by type. */
  agents: Record<string, number>
  /** Work started in the background (agents and commands). */
  background: number
  completed: number
  failed: number
  /** Killed or stopped. */
  killed: number
  messages: number
  skills: number
}

export type OpenWork = { id: string; kind: 'agent' | 'command'; label: string }

export type Todo = {
  id: string
  text: string
  status: 'pending' | 'in_progress' | 'completed'
  blockedBy: string[]
}

export type Wip = {
  /** The last recap the session wrote of itself (`away_summary`). */
  summary: string
  /** Background work started and never reported done. */
  open: OpenWork[]
  todos: Todo[]
  todoSource: 'todos' | 'tasks' | ''
}

export type PlanRef = {
  /** The plan file's base name: its key across sessions. */
  name: string
  path: string
  title: string
  status: 'approved' | 'revised' | 'rejected'
  /** When it was last sent for approval. */
  at: string
  /** Times it was sent back with comments. */
  revisions: number
  /** File paths the plan names. */
  files: string[]
  isPartial: boolean
}

export type ParentVia = '' | 'fork' | 'clear' | 'subprocess'

export type TreeNode = { title: string; endedAt: string; parent: string; parentVia: ParentVia }

export type FileDiff = { path: string; added: number; removed: number }

/** `input`: fresh input + cache writes; `cache`: cache reads. */
export type TokenUsage = { input: number; output: number; cache: number }

/** One plan as the plans view lists it, joined across the listing's sessions. */
export type PlanRow = {
  name: string
  path: string
  title: string
  status: PlanRef['status'] | 'file'
  at: string
  revisions: number
  /** The session that wrote it, or ''. */
  origin: string
  /** Sessions that named its file after it was written. */
  linked: string[]
  files: string[]
  /** Of `files`, the ones an origin or linked session edited. */
  touched: string[]
  exists: boolean
  isPartial: boolean
}

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
  plans: PlanRow[]
  isLoading: boolean
  error: string
}

/** What `git` says now of the files a session edited, inside their repository. */
export type GitInfo = {
  state: 'loading' | 'ok' | 'no-repo' | 'gone' | 'error'
  /** Session files inside the repository. */
  total: number
  /** Of those, the ones with changes not committed (untracked included). */
  dirty: string[]
  untracked: number
  added: number
  removed: number
  /** Session files a commit since the session started touched. */
  committed: number
  commits: number
}

export type Settings = {
  score: boolean
  badge: boolean
  charts: boolean
  conversation: boolean
  quality: boolean
  agents: boolean
  wip: boolean
  todos: boolean
  todoHint: boolean
  plans: boolean
  uncommitted: boolean
  tokens: boolean
  files: boolean
  tree: boolean
  /** Where `e` writes a plan, relative to the session's folder. */
  exportDir: string
}

export type SectionKey =
  | 'score'
  | 'badge'
  | 'charts'
  | 'conversation'
  | 'quality'
  | 'agents'
  | 'wip'
  | 'todos'
  | 'todoHint'
  | 'plans'
  | 'uncommitted'
  | 'tokens'
  | 'files'
  | 'tree'

export type ListMode = 'sessions' | 'plans' | 'search'

/**
 * A message the search can find: your prompt or the agent's reply, with
 * `cut`, the last chain entry of its turn, where a fork can stop
 * (`--resume-session-at`) to continue from right after that turn.
 */
export type SearchEntry = {
  role: 'user' | 'agent'
  text: string
  at: string
  cut: string
}
export type Panel = 'report' | 'settings' | 'help'

declare module 'claude-code' {
  interface PluginState {
    'super-resume': {
      scope: Scope
      selected: string
      selectedPlan: string
      reportTop: { id: string; top: number }
      listing: Shaped<Listing>
      git: Record<string, GitInfo>
      settings: Settings
      settingsAt: number
      listMode: ListMode
      panel: Panel
      exports: Record<string, string>
      planTextAt: number
      query: string
      selectedMatch: string
      choice: string
    }
  }
}
