import type {
  Delegation,
  FileDiff,
  OpenWork,
  PlanRef,
  Quality,
  SearchEntry,
  SessionReport,
  Signals,
  Todo,
  TokenUsage,
  Wip,
} from '../types'

// Claude Code names a project's transcript folder after its path, every
// character outside [A-Za-z0-9] turned into "-".
export const projectFolderName = (path: string): string =>
  path.replace(/[^A-Za-z0-9]/g, '-')

type Block = {
  type?: string
  id?: string
  text?: string
  name?: string
  input?: Record<string, unknown>
  tool_use_id?: string
  content?: unknown
  is_error?: boolean
}

type Line = {
  type?: string
  uuid?: string
  subtype?: string
  version?: string
  effort?: string
  perTurnEffort?: string | null
  isMeta?: boolean
  isSidechain?: boolean
  timestamp?: string
  cwd?: string
  gitBranch?: string
  summary?: string
  customTitle?: string
  aiTitle?: string
  content?: unknown
  durationMs?: number
  attachment?: { type?: string; planFilePath?: string }
  message?: {
    id?: string
    role?: string
    model?: string
    content?: string | Block[]
    usage?: Usage
  }
  toolUseResult?: unknown
  forkedFrom?: { sessionId?: string; messageUuid?: string }
}

type Usage = {
  input_tokens?: number
  output_tokens?: number
  cache_creation_input_tokens?: number
  cache_read_input_tokens?: number
}

type Hunk = { lines?: unknown }
type Patched = { filePath?: unknown; hunks?: unknown }

const emptyUsage = (): TokenUsage => ({ input: 0, output: 0, cache: 0 })

/**
 * Adds up the tokens of every model reply in `lines`. A reply is written as
 * one line per content block, each carrying the same usage, so each message
 * id counts once (its last line). `input` is fresh input plus what was
 * written to the cache; `cache` what was read back from it.
 */
const sumUsage = (byId: Map<string, Usage>): TokenUsage => {
  const total = emptyUsage()
  for (const usage of byId.values()) {
    total.input += (usage.input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0)
    total.output += usage.output_tokens ?? 0
    total.cache += usage.cache_read_input_tokens ?? 0
  }
  return total
}

const countHunks = (hunks: unknown): { added: number; removed: number } => {
  let added = 0
  let removed = 0
  if (!Array.isArray(hunks)) return { added, removed }
  for (const hunk of hunks as Hunk[]) {
    if (!Array.isArray(hunk?.lines)) continue
    for (const text of hunk.lines as unknown[]) {
      if (typeof text !== 'string') continue
      if (text.startsWith('+')) added += 1
      else if (text.startsWith('-')) removed += 1
    }
  }
  return { added, removed }
}

/**
 * The lines a tool result says it changed, by file: an Edit or Write result's
 * `structuredPatch` (a new file's `content`, its patch being empty), or the
 * files a Bash command edited (`bashEditDiff`).
 */
const diffsOf = (result: unknown): { path: string; added: number; removed: number }[] => {
  if (typeof result !== 'object' || result === null) return []
  const r = result as Record<string, unknown>
  if (typeof r.filePath === 'string' && Array.isArray(r.structuredPatch)) {
    if (r.type === 'create' && r.structuredPatch.length === 0 && typeof r.content === 'string') {
      const lines = r.content.replace(/\n$/, '').split('\n').length
      return [{ path: r.filePath, added: r.content === '' ? 0 : lines, removed: 0 }]
    }
    return [{ path: r.filePath, ...countHunks(r.structuredPatch) }]
  }
  const bash = r.bashEditDiff as { files?: unknown } | undefined
  if (bash && Array.isArray(bash.files)) {
    return (bash.files as Patched[])
      .filter(file => typeof file?.filePath === 'string')
      .map(file => ({ path: file.filePath as string, ...countHunks(file.hunks) }))
  }
  return []
}

/** What one subagent transcript holds: its tokens, as `sumUsage` counts them. */
export const parseAgentUsage = (text: string): TokenUsage => {
  const byId = new Map<string, Usage>()
  let n = 0
  for (const raw of text.split('\n')) {
    if (raw.trim() === '') continue
    let line: Line
    try {
      line = JSON.parse(raw) as Line
    } catch {
      continue
    }
    if (line.type !== 'assistant' || !line.message?.usage) continue
    byId.set(line.message.id ?? `#${n++}`, line.message.usage)
  }
  return sumUsage(byId)
}

/** A subagent's `agent-*.meta.json`: how deep it was spawned and whether it finished. */
export const parseAgentMeta = (text: string): { depth: number; finished: boolean } | undefined => {
  try {
    const meta = JSON.parse(text) as { spawnDepth?: unknown; finished?: unknown }
    return {
      depth: typeof meta.spawnDepth === 'number' ? meta.spawnDepth : 1,
      finished: meta.finished !== false,
    }
  } catch {
    return undefined
  }
}

const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit'])

// Rows Claude Code writes as user messages that the person never typed.
const isNoise = (text: string): boolean =>
  /^\s*(<command-|<local-command|<system-reminder|<bash-(input|stdout|stderr)|<task-notification|Caveat:|\[Request interrupted)/.test(
    text,
  )

const textOf = (content: string | Block[] | undefined): string => {
  if (content === undefined) return ''
  if (typeof content === 'string') return content
  return content
    .filter(block => block.type === 'text' && typeof block.text === 'string')
    .map(block => block.text as string)
    .join('\n')
}

// A tool result's text: a string, or its text blocks.
const resultText = (content: unknown): string => {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return (content as Block[])
    .filter(block => block?.type === 'text' && typeof block.text === 'string')
    .map(block => block.text as string)
    .join('\n')
}

const oneLine = (text: string, max: number): string => {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}

// At most `max` characters, the line breaks kept (paragraphs and lists stay
// readable in the report), runs of spaces and blank lines squeezed.
const clipText = (text: string, max: number): string => {
  const kept = text
    // a line's indent stays (it nests list items); spaces inside it are squeezed
    .replace(/(\S)[ \t]+/g, '$1 ')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  return kept.length > max ? `${kept.slice(0, max - 1)}…` : kept
}

// The last `max` characters, from a word's start, marked … when cut.
const tailOf = (text: string, max: number): string =>
  text.length > max ? `…${text.slice(-max).replace(/^\S*\s*/, '')}` : text

export type ResultKind =
  | 'ok'
  | 'error'
  | 'rejected'
  | 'rejected-feedback'
  | 'plan-revised'
  | 'plan-rejected'
  | 'clarify'

const REFUSED = /^The user doesn't want to (proceed with|take) this/

/**
 * A failed result that reads like the person refusing, in words `REFUSED`
 * does not know: the sign the wording changed in a Claude Code update.
 */
export const looksRefused = (text: string): boolean =>
  !REFUSED.test(text.trimStart()) &&
  /\b(?:the )?user\b[^.\n]{0,40}\b(?:rejected|declined|denied|refused|doesn't want|does not want|did not want)\b/i.test(text.slice(0, 300))

/**
 * What a tool result says of the call, by the tool it answers. A refusal of
 * a question (the person asks back) or of a plan sent back with comments is
 * the normal back and forth, kept apart from a refused action.
 */
export const classifyResult = (tool: string, text: string, isError: boolean): ResultKind => {
  if (REFUSED.test(text.trimStart())) {
    if (tool === 'AskUserQuestion') return 'clarify'
    const hasFeedback = /the user said:/i.test(text)
    if (tool === 'ExitPlanMode') return hasFeedback ? 'plan-revised' : 'plan-rejected'
    return hasFeedback ? 'rejected-feedback' : 'rejected'
  }
  return isError ? 'error' : 'ok'
}

/** The person's words after `the user said:`, without the note the engine adds. */
export const feedbackOf = (text: string): string => {
  const at = text.search(/the user said:/i)
  if (at < 0) return ''
  return text
    .slice(at + 'the user said:'.length)
    .split(/\n\s*Note: The user's next message/)[0]!
    .trim()
}

export type Notification = { taskId: string; toolUseId: string; status: string; summary: string }

/** Every `<task-notification>` in a text: the task, its call, how it ended. */
export const parseNotifications = (text: string): Notification[] => {
  const out: Notification[] = []
  for (const match of text.matchAll(/<task-notification>([\s\S]*?)(?:<\/task-notification>|$)/g)) {
    const body = match[1] ?? ''
    const tag = (name: string) => body.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`))?.[1]?.trim() ?? ''
    const status = tag('status')
    if (status === '') continue
    out.push({ taskId: tag('task-id'), toolUseId: tag('tool-use-id'), status, summary: tag('summary') })
  }
  return out
}

/** The first `# ` heading of a plan, or its first line. */
export const planTitle = (markdown: string): string => {
  const heading = markdown.match(/^#\s+(.+)$/m)?.[1]
  const first = markdown.split('\n').find(line => line.trim() !== '') ?? ''
  return oneLine((heading ?? first).replace(/[*_`#]/g, ''), 80)
}

/**
 * The file paths a plan names in backticks: a name with an extension, maybe
 * a folder, without a line suffix. URLs, commands and bare words are left out.
 */
export const planFiles = (markdown: string): string[] => {
  const found = new Set<string>()
  for (const match of markdown.matchAll(/`([^`\s]+)`/g)) {
    let path = (match[1] ?? '').replace(/:\d+(-\d+)?$/, '').replace(/[),.;]+$/, '')
    if (/:\/\//.test(path) || /^[-$]/.test(path) || path.includes('*')) continue
    if (!/[\\/]/.test(path) && !/^[\w.-]+\.(tsx?|jsx?|mjs|cjs|json|md|cs|py|rs|go|java|kt|swift|css|scss|html|ya?ml|toml|sh|ps1|uss|uxml|shader|hlsl|asset|unity|prefab)$/i.test(path)) continue
    if (!/\.[A-Za-z0-9]{1,10}$/.test(path)) continue
    path = path.replace(/\\/g, '/').replace(/^\.\//, '')
    found.add(path)
  }
  return [...found].slice(0, 60)
}

// A plan file named in a path: `~/.claude/plans/<name>.md` or `docs/plans/<name>.md`.
const PLAN_PATH = /(?:\.claude|docs)[\\/]+plans[\\/]+([\w.-]+\.md)/g

export const lastPart = (path: string): string =>
  path.split(/[\\/]/).filter(Boolean).at(-1) ?? path

/** At most `points` values: each the sum, the last or the highest of its stretch. */
export const downsample = (values: number[], points: number, mode: 'sum' | 'last' | 'max'): number[] => {
  if (values.length <= points) return values
  const out: number[] = []
  for (let i = 0; i < points; i++) {
    const from = Math.floor((i * values.length) / points)
    const to = Math.floor(((i + 1) * values.length) / points)
    const part = values.slice(from, Math.max(to, from + 1))
    out.push(mode === 'sum' ? part.reduce((a, b) => a + b, 0) : mode === 'max' ? Math.max(...part) : part.at(-1)!)
  }
  return out
}

const TODO_STATUS = new Set(['pending', 'in_progress', 'completed'])
const asTodo = (id: string, text: unknown, status: unknown, blockedBy: unknown = []): Todo | undefined =>
  typeof text === 'string' && typeof status === 'string' && TODO_STATUS.has(status)
    ? {
        id,
        text: oneLine(text, 200),
        status: status as Todo['status'],
        blockedBy: Array.isArray(blockedBy) ? blockedBy.filter((b): b is string => typeof b === 'string') : [],
      }
    : undefined

/**
 * The task list a session's task tools leave behind: TaskCreate adds one,
 * TaskUpdate moves (or deletes) it, TaskList answers the whole list.
 */
export const replayTasks = (
  tasks: Map<string, Todo>,
  tool: string,
  input: Record<string, unknown>,
  result: unknown,
): void => {
  const r = (typeof result === 'object' && result !== null ? result : {}) as Record<string, unknown>
  if (tool === 'TaskCreate') {
    const task = r.task as { id?: unknown; subject?: unknown } | undefined
    const id = typeof task?.id === 'string' ? task.id : String(tasks.size + 1)
    const todo = asTodo(id, task?.subject ?? input.subject, 'pending')
    if (todo) tasks.set(id, todo)
  } else if (tool === 'TaskUpdate') {
    const id = typeof r.taskId === 'string' ? r.taskId : typeof input.taskId === 'string' ? input.taskId : ''
    const change = r.statusChange as { to?: unknown } | undefined
    const status = change?.to ?? input.status
    if (id === '') return
    if (status === 'deleted') {
      tasks.delete(id)
      return
    }
    const known = tasks.get(id)
    const next = asTodo(id, input.subject ?? known?.text ?? `Task ${id}`, status ?? known?.status ?? 'pending',
      known?.blockedBy ?? [])
    if (next) {
      const blockers = Array.isArray(input.addBlockedBy) ? input.addBlockedBy.filter((b): b is string => typeof b === 'string') : []
      next.blockedBy = [...new Set([...next.blockedBy, ...blockers])]
      tasks.set(id, next)
    }
  } else if (tool === 'TaskList' && Array.isArray(r.tasks)) {
    tasks.clear()
    for (const task of r.tasks as Record<string, unknown>[]) {
      const id = typeof task?.id === 'string' ? task.id : ''
      const todo = id === '' ? undefined : asTodo(id, task.subject, task.status, task.blockedBy)
      if (todo) tasks.set(id, todo)
    }
  }
}

const emptyQuality = (): Quality => ({
  rejected: 0,
  rejectedWithFeedback: 0,
  lastFeedback: '',
  interrupts: 0,
  toolErrors: 0,
  compactions: 0,
  plansRevised: 0,
  plansRejected: 0,
  clarified: 0,
})

const emptyDelegation = (): Delegation => ({
  agents: {},
  background: 0,
  completed: 0,
  failed: 0,
  killed: 0,
  messages: 0,
  skills: 0,
})

/**
 * Builds the report of one transcript from its JSONL text. `isPartial` says
 * the text is the head and tail of a file too large to read whole, so counts
 * are lower bounds.
 */
export const parseTranscript = (
  id: string,
  text: string,
  isPartial: boolean,
  fallbackCwd: string,
  // filled, when given, with the prompts and replies the search can find
  entries?: SearchEntry[],
): SessionReport | undefined => {
  // The search's turns: a prompt opens one, and every entry of a turn gets
  // the uuid of the last chain entry before the next prompt as its `cut`.
  let lastUuid = ''
  let turnStart = 0
  const closeTurn = (uuid: string) => {
    if (!entries) return
    for (let i = turnStart; i < entries.length; i++) entries[i]!.cut = uuid
    turnStart = entries.length
  }
  let title = ''
  let customTitle = ''
  let firstPrompt = ''
  let lastPrompt = ''
  let lastReply = ''
  let startedAt = ''
  let endedAt = ''
  let cwd = ''
  let branch = ''
  let model = ''
  let turns = 0
  let toolCalls = 0
  let contextTokens = 0
  let parent = ''
  let aiTitle = ''
  let inheritedFirst = ''
  let activeMs = 0
  let commits = 0
  const files = new Map<string, FileDiff>()
  const usageById = new Map<string, Usage>()
  let unnamed = 0
  const touch = (path: string, added = 0, removed = 0) => {
    const known = files.get(path) ?? { path, added: 0, removed: 0 }
    known.added += added
    known.removed += removed
    files.set(path, known)
  }

  const quality = emptyQuality()
  const delegation = emptyDelegation()
  const wip: Wip = { summary: '', open: [], todos: [], todoSource: '' }
  // Each tool call by id, to read its result by the tool it answers.
  const calls = new Map<string, { name: string; input: Record<string, unknown> }>()
  // Background work by task id; how each ended, by task id.
  const launched = new Map<string, OpenWork>()
  const ended = new Map<string, string>()
  const tasks = new Map<string, Todo>()
  const plans = new Map<string, PlanRef>()
  const mentions = new Set<string>()
  // The plan file this session last wrote or was pointed at.
  let planFile = ''
  const activity: number[] = []
  // each reply's effort, once per message id (a reply is written one line per block)
  const efforts = new Map<string, string>()
  // The line a refusal stopped the turn at: the interrupt it writes next is the same event.
  let stopAt = -10
  let index = 0
  // Format checks: what was recognised, and what looked like a signal but was not.
  let version = ''
  let linkedResults = 0
  let resultsSeen = 0
  const unknown = { refusals: 0, interrupts: 0, notifications: 0 }

  const mention = (value: string) => {
    for (const match of value.matchAll(PLAN_PATH)) mentions.add(match[1]!)
  }

  for (const raw of text.split('\n')) {
    if (raw.trim() === '') continue
    let line: Line
    try {
      line = JSON.parse(raw) as Line
    } catch {
      continue // a line cut at a read boundary
    }
    index += 1
    if (typeof line.version === 'string' && line.version !== '') version = line.version

    if (line.type === 'summary' && line.summary) title = line.summary
    if (line.type === 'custom-title' && line.customTitle) customTitle = line.customTitle
    // a fork's copy of its parent's title names the parent, not this session
    if (line.type === 'ai-title' && line.aiTitle && line.forkedFrom === undefined) aiTitle = line.aiTitle
    if (line.isSidechain) continue
    const beforeUuid = lastUuid
    if ((line.type === 'user' || line.type === 'assistant') && typeof line.uuid === 'string') lastUuid = line.uuid
    // A fork starts as a copy of its parent's lines, each marked with
    // `forkedFrom`. Those say where it came from and where it stood, but the
    // turns, tokens and edits in them are the parent's, not counted here.
    const isInherited = line.forkedFrom !== undefined
    if (isInherited && typeof line.forkedFrom?.sessionId === 'string' && line.forkedFrom.sessionId !== id) {
      parent = line.forkedFrom.sessionId
    }
    if (line.timestamp) {
      if (!isInherited && startedAt === '') startedAt = line.timestamp
      endedAt = line.timestamp
    }
    if (line.cwd) cwd = line.cwd
    if (line.gitBranch) branch = line.gitBranch

    if (line.type === 'system' && !isInherited) {
      if (line.subtype === 'compact_boundary') quality.compactions += 1
      if (line.subtype === 'turn_duration' && typeof line.durationMs === 'number' && line.durationMs > 0) {
        activeMs += line.durationMs
        activity.push(line.durationMs)
      }
      if (line.subtype === 'away_summary' && typeof line.content === 'string') {
        wip.summary = oneLine(line.content.replace(/\s*\(disable recaps[^)]*\)\s*$/i, ''), 400)
      }
      continue
    }
    if (line.type === 'attachment' && typeof line.attachment?.planFilePath === 'string') {
      mentions.add(lastPart(line.attachment.planFilePath))
      if (!isInherited) planFile = line.attachment.planFilePath
      continue
    }
    // A notification queued while the model worked, delivered later as a user row.
    if (line.type === 'queue-operation' && typeof line.content === 'string' && !isInherited) {
      for (const n of parseNotifications(line.content)) ended.set(n.taskId || n.toolUseId, n.status)
      continue
    }

    if (!isInherited) {
      for (const diff of diffsOf(line.toolUseResult)) touch(diff.path, diff.added, diff.removed)
    }

    const message = line.message
    if (!message) continue

    if (line.type === 'user' && !line.isMeta) {
      const said = textOf(message.content)
      if (!isInherited && /^\s*\[Request interrupted by user/.test(said)) {
        const isToolStop = /for tool use\]/.test(said)
        if (!(isToolStop && index - stopAt <= 3)) quality.interrupts += 1
      } else if (!isInherited && /^\s*\[[^\]]*\binterrupt/i.test(said)) {
        unknown.interrupts += 1
      }
      if (!isInherited && /^\s*<task-notification>/.test(said)) {
        const found = parseNotifications(said)
        if (found.length === 0) unknown.notifications += 1
        for (const n of found) ended.set(n.taskId || n.toolUseId, n.status)
      }
      if (said !== '' && !isNoise(said)) {
        if (isInherited) {
          if (inheritedFirst === '') inheritedFirst = said
        } else {
          turns += 1
          if (firstPrompt === '') firstPrompt = said
          mention(said)
          if (entries) {
            closeTurn(beforeUuid)
            entries.push({ role: 'user', text: said, at: line.timestamp ?? '', cut: '' })
          }
        }
        lastPrompt = said
      }
      if (!isInherited && Array.isArray(message.content)) {
        for (const block of message.content) {
          if (block.type !== 'tool_result' || typeof block.tool_use_id !== 'string') continue
          const call = calls.get(block.tool_use_id)
          const tool = call?.name ?? ''
          const said = resultText(block.content)
          const kind = classifyResult(tool, said, block.is_error === true)
          resultsSeen += 1
          if (call) linkedResults += 1
          if (kind === 'error' && looksRefused(said)) unknown.refusals += 1
          if (kind === 'rejected' || kind === 'rejected-feedback') quality.rejected += 1
          if (kind === 'rejected-feedback') quality.rejectedWithFeedback += 1
          if (kind === 'plan-revised') quality.plansRevised += 1
          if (kind === 'plan-rejected') quality.plansRejected += 1
          if (kind === 'clarify') quality.clarified += 1
          if (kind === 'error') quality.toolErrors += 1
          if (kind === 'rejected' || kind === 'plan-rejected') stopAt = index
          if (kind === 'rejected-feedback' || kind === 'plan-revised') {
            const words = feedbackOf(said)
            if (words !== '') quality.lastFeedback = oneLine(words, 400)
          }
          const result = line.toolUseResult
          const r = (typeof result === 'object' && result !== null ? result : {}) as Record<string, unknown>
          // background work: a command's task id, or an async agent's id
          const taskId =
            typeof r.backgroundTaskId === 'string'
              ? r.backgroundTaskId
              : r.isAsync === true && typeof r.agentId === 'string'
                ? r.agentId
                : ''
          if (taskId !== '' && call) {
            const isAgent = call.name === 'Agent' || call.name === 'Task'
            const label = String(call.input.description ?? call.input.command ?? call.name)
            launched.set(taskId, { id: taskId, kind: isAgent ? 'agent' : 'command', label: oneLine(label, 60) })
            delegation.background += 1
          }
          if (call && ['TaskCreate', 'TaskUpdate', 'TaskList'].includes(tool)) {
            replayTasks(tasks, tool, call.input, result)
            wip.todoSource = 'tasks'
          }
          if (call && tool === 'TodoWrite' && Array.isArray(r.newTodos)) {
            wip.todos = (r.newTodos as Record<string, unknown>[])
              .map((todo, i) => asTodo(String(i + 1), todo?.content, todo?.status))
              .filter((todo): todo is Todo => todo !== undefined)
          }
          if (call && tool === 'ExitPlanMode') {
            const plan = String(call.input.plan ?? r.plan ?? '')
            // a refused plan's result names no file: the plan file it wrote last does
            const path = String(r.filePath ?? call.input.planFilePath ?? planFile)
            const name = path !== '' ? lastPart(path) : `plan-${block.tool_use_id.slice(-6)}`
            let known = plans.get(name)
            // revisions sent before its file was known belong to it
            if (path !== '') {
              for (const [other, ref] of plans) {
                if (!other.startsWith('plan-')) continue
                known = known ? { ...known, revisions: known.revisions + ref.revisions } : ref
                plans.delete(other)
              }
            }
            const status: PlanRef['status'] =
              kind === 'plan-revised' ? 'revised' : kind === 'plan-rejected' ? 'rejected' : 'approved'
            plans.set(name, {
              name,
              path: path || known?.path || '',
              title: plan !== '' ? planTitle(plan) : known?.title ?? name,
              status,
              at: line.timestamp ?? '',
              revisions: (known?.revisions ?? 0) + (kind === 'plan-revised' ? 1 : 0),
              files: plan !== '' ? planFiles(plan) : known?.files ?? [],
              isPartial,
            })
          }
        }
      }
    }

    if (line.type === 'assistant') {
      if (message.model && message.model !== '<synthetic>') model = message.model
      // a turn's own effort (set for that turn) wins over the session's
      const level = line.perTurnEffort || line.effort
      if (!isInherited && typeof level === 'string' && level !== '') efforts.set(message.id ?? `#e${index}`, level)
      const usage = message.usage
      if (usage) {
        if (!isInherited) usageById.set(message.id ?? `#${unnamed++}`, usage)
        const used =
          (usage.input_tokens ?? 0) +
          (usage.cache_creation_input_tokens ?? 0) +
          (usage.cache_read_input_tokens ?? 0)
        if (used > 0) contextTokens = used
      }
      if (!isInherited && Array.isArray(message.content)) {
        for (const block of message.content) {
          if (block.type !== 'tool_use') continue
          toolCalls += 1
          const input = block.input ?? {}
          const name = block.name ?? ''
          if (typeof block.id === 'string') calls.set(block.id, { name, input })
          const path = input.file_path ?? input.notebook_path
          if (EDIT_TOOLS.has(name) && typeof path === 'string') {
            touch(path)
            if (/[\\/]plans[\\/]+[^\\/]+\.md$/i.test(path)) planFile = path
          }
          if (name === 'Agent' || name === 'Task') {
            const type = typeof input.subagent_type === 'string' && input.subagent_type !== '' ? input.subagent_type : 'general-purpose'
            delegation.agents[type] = (delegation.agents[type] ?? 0) + 1
          }
          if (name === 'SendMessage') delegation.messages += 1
          if (name === 'Skill') delegation.skills += 1
          if (name === 'TodoWrite' && Array.isArray(input.todos)) {
            wip.todoSource = 'todos'
            wip.todos = (input.todos as Record<string, unknown>[])
              .map((todo, i) => asTodo(String(i + 1), todo?.content, todo?.status))
              .filter((todo): todo is Todo => todo !== undefined)
          }
          if (name === 'Bash' || name === 'PowerShell') {
            const command = String(input.command ?? '')
            if (/\bgit\b(?:\s+-[cC]\s+\S+)*\s+commit\b(?![^\n]*--dry-run)/.test(command)) commits += 1
          }
          // a plan file it reads, edits or names in a command
          if (name !== 'ExitPlanMode') mention(JSON.stringify(input))
        }
      }
      const said = textOf(message.content)
      if (said.trim() !== '') {
        lastReply = said
        if (entries && !isInherited) entries.push({ role: 'agent', text: said, at: line.timestamp ?? '', cut: '' })
      }
    }
  }

  closeTurn(lastUuid)
  if (turns === 0 && lastReply === '') return undefined
  // A fork with nothing of its own yet starts where its copy ends.
  if (startedAt === '') startedAt = endedAt

  // Every ending counts, even one whose launch a partial read did not see.
  for (const status of ended.values()) {
    if (status === 'completed') delegation.completed += 1
    else if (status === 'failed') delegation.failed += 1
    else if (status === 'killed' || status === 'stopped') delegation.killed += 1
  }
  wip.open = [...launched.values()].filter(work => !ended.has(work.id)).slice(0, 12)
  if (wip.todoSource === 'tasks') wip.todos = [...tasks.values()]
  for (const plan of plans.values()) mentions.delete(plan.name)

  const unrecognised: string[] = []
  if (unknown.refusals > 0) unrecognised.push(`${unknown.refusals} refusals in an unknown wording`)
  if (unknown.interrupts > 0) unrecognised.push(`${unknown.interrupts} interrupts in an unknown wording`)
  if (unknown.notifications > 0) unrecognised.push(`${unknown.notifications} task notifications not readable`)
  // most tool calls answered by a result tied to them; a partial read cuts some pairs
  if (!isPartial && toolCalls >= SCORE.minToolCalls && linkedResults < toolCalls * 0.5) {
    unrecognised.push(resultsSeen === 0 ? 'no tool results found' : 'tool results not tied to their calls')
  }
  const signals: Signals = { version, linkedResults, unrecognised }

  const contextWindow =
    contextTokens > 200_000 || /\[1m\]/i.test(model) ? 1_000_000 : 200_000
  const durationMs =
    startedAt && endedAt ? Date.parse(endedAt) - Date.parse(startedAt) : 0

  return {
    id,
    transcript: '',
    // As /resume names it: the title set by hand, then Claude Code's own
    // (an older build wrote it as a slug), then a summary or the first prompt.
    title: oneLine(
      customTitle ||
        (/\s/.test(aiTitle) ? aiTitle : aiTitle.replace(/-/g, ' ')) ||
        title ||
        firstPrompt ||
        inheritedFirst ||
        '(no prompt)',
      80,
    ),
    parent,
    firstPrompt: clipText(firstPrompt, 800),
    lastPrompt: clipText(lastPrompt, 800),
    // the reply's end, enough for the report to scroll through; cut at a word
    lastReply: tailOf(lastReply.trim(), 1600),
    startedAt,
    endedAt,
    durationMs: Number.isFinite(durationMs) ? Math.max(0, durationMs) : 0,
    activeMs,
    cwd: cwd || fallbackCwd,
    branch,
    model,
    turns,
    toolCalls,
    contextTokens,
    contextWindow,
    files: [...files.values()],
    added: [...files.values()].reduce((sum, file) => sum + file.added, 0),
    removed: [...files.values()].reduce((sum, file) => sum + file.removed, 0),
    usage: sumUsage(usageById),
    agents: { count: 0, usage: emptyUsage(), isPartial: false, maxDepth: 0, unfinished: 0 },
    quality,
    delegation,
    wip,
    plans: [...plans.values()],
    mentions: [...mentions],
    commits,
    series: {
      activity: downsample(activity, 24, 'sum'),
    },
    effort: [...efforts.values()].at(-1) ?? '',
    effortMix: [...efforts.values()].reduce<Record<string, number>>((mix, e) => ({ ...mix, [e]: (mix[e] ?? 0) + 1 }), {}),
    signals,
    isPartial,
  }
}

// ---------------------------------------------------------------------------
// The score: three sub-scores read from the transcript alone, so a session's
// grade is the same in the list and in its report. Every number the score
// uses is here, and the help page is written from this table.

export const SCORE = {
  /** Fewer turns or tool calls than this: too little to judge (—). */
  minTurns: 5,
  minToolCalls: 10,
  flow: {
    /** Points off per event, per 10 turns. */
    perTenTurns: { rejected: 12, interrupt: 8, planRejected: 10, planRevised: 3 },
    /** Points off for a 100% tool failure rate (scaled down linearly). */
    errorRate: 60,
  },
  autonomy: {
    /** Tool calls per turn that score 20 and 100; log scale between. */
    low: 1,
    high: 30,
  },
  delegation: {
    /** The subagents' share of tokens (in + out) that counts as full use. */
    fullShare: 0.4,
  },
  /** Weights of the overall grade. */
  weights: { flow: 0.5, autonomy: 0.25, delegation: 0.25 },
  /**
   * The Claude Code release (major.minor) whose transcript wording these
   * signals were checked against; a newer one marks the score with ~.
   */
  testedWith: '2.1',
  /** Lowest overall for each grade; below the last, E. */
  grades: [
    ['A', 85],
    ['B', 70],
    ['C', 55],
    ['D', 40],
  ] as [string, number][],
} as const

export type Score = {
  /** `undefined` when the session is too short to judge, or its format was not recognised. */
  overall?: number
  /** Why there is no score: too short, or the transcript's wording was not recognised. */
  reason?: string
  /** Written by a newer Claude Code than the signals were checked with: `~` before the score. */
  isNewer?: boolean
  grade: string
  flow?: number
  autonomy?: number
  delegation?: number
  /** A partial read: the counts are lower bounds. */
  isPartial: boolean
}

/** Whether `version` (`2.2.4`) is a later major.minor than `tested` (`2.1`). */
export const isNewerThan = (version: string, tested: string): boolean => {
  const [a = 0, b = 0] = version.split('.').map(Number)
  const [c = 0, d = 0] = tested.split('.').map(Number)
  if (!Number.isFinite(a) || !Number.isFinite(b) || version === '') return false
  return a > c || (a === c && b > d)
}

// The oldest Claude Code the pane draws on: earlier builds take only a string
// inside a Button, refuse the list's styled rows and skip the whole drawing.
// Keep in step with `engines` in plugin.json (which builds before 2.1.323 ignore).
export const MIN_ENGINE = '2.1.329'

/** Whether `version` (`2.1.286`) is an earlier release than `min` (`2.1.329`); false when unreadable. */
export const isOlderThan = (version: string, min: string): boolean => {
  const parts = (text: string) => /^(\d+)\.(\d+)\.(\d+)/.exec(text)?.slice(1).map(Number)
  const v = parts(version)
  const m = parts(min)
  if (!v || !m) return false
  for (let i = 0; i < 3; i++) if (v[i] !== m[i]) return v[i]! < m[i]!
  return false
}

const clamp = (n: number) => Math.round(Math.max(0, Math.min(100, n)))

export const gradeOf = (overall: number | undefined): string => {
  if (overall === undefined) return '—'
  for (const [grade, min] of SCORE.grades) if (overall >= min) return grade
  return 'E'
}

export const scoreOf = (report: SessionReport): Score => {
  const { turns, toolCalls, quality: q, delegation: d } = report
  if (turns < SCORE.minTurns || toolCalls < SCORE.minToolCalls) {
    return { grade: '—', reason: 'too short to score', isPartial: report.isPartial }
  }
  // Counts read from wording Claude Code may change: when some of it was not
  // recognised, zero rejections may mean the phrase changed, not a smooth
  // session. No score then, rather than a perfect one.
  const unrecognised = report.signals?.unrecognised ?? []
  if (unrecognised.length > 0) {
    return { grade: '?', reason: `format not recognised: ${unrecognised.join(', ')}`, isPartial: report.isPartial }
  }
  const isNewer = isNewerThan(report.signals?.version ?? '', SCORE.testedWith)
  const w = SCORE.flow.perTenTurns
  const events =
    w.rejected * q.rejected +
    w.interrupt * q.interrupts +
    w.planRejected * q.plansRejected +
    w.planRevised * q.plansRevised
  const flow = clamp(100 - (events * 10) / turns - SCORE.flow.errorRate * (q.toolErrors / toolCalls))

  const perTurn = toolCalls / turns
  const { low, high } = SCORE.autonomy
  const autonomy = clamp(
    perTurn <= low ? 20 * (perTurn / low) : 20 + (80 * Math.log(perTurn / low)) / Math.log(high / low),
  )

  // Delegation judges what was handed off: subagents drive its use half, and
  // all background work (agents and commands) its success half. A session that
  // handed nothing off has nothing to judge here: left out, not scored 50.
  const agentTokens = report.agents.usage.input + report.agents.usage.output
  const ownTokens = report.usage.input + report.usage.output
  const hasAgents = Object.values(d.agents).some(n => n > 0) || report.agents.count > 0
  const finished = d.completed + d.failed + d.killed
  const success = finished > 0 ? d.completed / finished : 1
  let delegation: number | undefined
  if (hasAgents) {
    const share = agentTokens + ownTokens > 0 ? agentTokens / (agentTokens + ownTokens) : 0
    const use = Math.min(1, share / SCORE.delegation.fullShare)
    delegation = clamp(100 * (0.5 * use + 0.5 * success))
  } else if (finished > 0) {
    delegation = clamp(100 * success)
  }

  // the weighted mean of the sub-scores there are, the weights renormalised
  const { weights } = SCORE
  const parts: [number, number][] = [
    [weights.flow, flow],
    [weights.autonomy, autonomy],
    ...(delegation === undefined ? [] : [[weights.delegation, delegation] as [number, number]]),
  ]
  const weightSum = parts.reduce((sum, [w]) => sum + w, 0)
  const overall = clamp(parts.reduce((sum, [w, v]) => sum + w * v, 0) / weightSum)
  return { overall, grade: gradeOf(overall), flow, autonomy, delegation, isNewer, isPartial: report.isPartial }
}

// ---------------------------------------------------------------------------
// Drawing helpers. Every glyph here is one cell wide in any terminal: no
// emoji, nothing of ambiguous width.

const SPARKS = '▁▂▃▄▅▆▇█'

/** Effort levels in order, low to max. */
export const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const
/**
 * The cells of a distribution bar: `width` cells split among `counts` by their
 * share, like `stackBar`, but a level that occurs keeps at least one cell (taken
 * from the widest), so a few replies at max among hundreds still show. The
 * session's length never changes the width: every reply counts, none is dropped.
 */
export const distributionBar = (counts: number[], width: number): number[] => {
  const cells = stackBar(counts, width)
  for (let i = 0; i < counts.length; i++) {
    if (counts[i]! <= 0 || cells[i]! > 0) continue
    const widest = cells.indexOf(Math.max(...cells))
    if (cells[widest]! <= 1) break
    cells[widest]! -= 1
    cells[i] = 1
  }
  return cells
}

/** `values` as a sparkline of at most `width` cells, scaled to their max. */
export const spark = (values: number[], width: number): string => {
  const points = downsample(values, Math.max(1, width), 'last')
  const max = Math.max(...points, 0)
  if (max <= 0) return ''
  return points.map(v => SPARKS[Math.min(7, Math.max(0, Math.round((v / max) * 7)))]).join('')
}

/** Cells of a bar split into `parts`, each rounded, together `width` cells (or fewer). */
export const stackBar = (parts: number[], width: number): number[] => {
  const total = parts.reduce((a, b) => a + b, 0)
  if (total <= 0) return parts.map(() => 0)
  const cells = parts.map(p => Math.floor((p / total) * width))
  // hand the cells lost to rounding to the largest remainders
  let left = width - cells.reduce((a, b) => a + b, 0)
  const order = parts
    .map((p, i) => ({ i, rest: (p / total) * width - cells[i]! }))
    .sort((a, b) => b.rest - a.rest)
  for (const { i } of order) {
    if (left <= 0) break
    if (parts[i]! > 0) {
      cells[i]! += 1
      left -= 1
    }
  }
  return cells
}

/** A file path relative to `root` when inside it, compared without case or slash style. */
export const relativeTo = (file: string, root: string): string => {
  const norm = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '')
  const f = norm(file)
  const r = norm(root)
  return f.toLowerCase().startsWith(`${r.toLowerCase()}/`) ? f.slice(r.length + 1) : ''
}

/** Whether a path a plan names is the edited file `edited` (suffix match on whole segments). */
export const isSameFile = (named: string, edited: string): boolean => {
  const a = named.replace(/\\/g, '/').toLowerCase().replace(/^\/+/, '')
  const b = edited.replace(/\\/g, '/').toLowerCase()
  return b === a || b.endsWith(`/${a}`)
}

/** A plan title as a file name: lower case, dashes, at most 60 characters. */
export const slug = (text: string): string =>
  text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/, '') || 'plan'

export const ago = (iso: string, now: number): string => {
  const then = Date.parse(iso)
  if (!Number.isFinite(then)) return '?'
  const minutes = Math.max(0, Math.round((now - then) / 60_000))
  if (minutes < 60) return `${minutes}m`
  const hours = Math.round(minutes / 60)
  if (hours < 48) return `${hours}h`
  return `${Math.round(hours / 24)}d`
}

export const duration = (ms: number): string => {
  const minutes = Math.round(ms / 60_000)
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  return `${hours}h${String(minutes % 60).padStart(2, '0')}`
}

export const tokens = (n: number): string =>
  n >= 1_000_000
    ? `${(n / 1_000_000).toFixed(1)}M`
    : n >= 1000
      ? `${Math.round(n / 1000)}k`
      : String(n)

/** A bar of `width` cells, `filled` of them on, as the status line draws it. */
export const bar = (ratio: number, width: number): { on: string; off: string } => {
  const filled = Math.round(Math.min(1, Math.max(0, ratio)) * width)
  return { on: '█'.repeat(filled), off: '░'.repeat(width - filled) }
}

export const levelColor = (ratio: number): 'success' | 'warning' | 'error' =>
  ratio < 0.5 ? 'success' : ratio < 0.8 ? 'warning' : 'error'

/** `text` on one line in exactly `width` cells: cut with … or padded. */
export const fit = (text: string, width: number): string => {
  const flat = text.replace(/\s+/g, ' ').trim()
  if (width <= 0) return ''
  return flat.length > width ? `${flat.slice(0, width - 1)}…` : flat.padEnd(width)
}

/** A model id as the status line names it: `claude-opus-5-5` → `Opus 5.5`. */
export const modelName = (id: string): string => {
  const is1m = /\[1m\]/i.test(id)
  const parts = id
    .replace(/\[1m\]/i, '')
    .replace(/^claude-/, '')
    .split('-')
    .filter(part => !/^\d{8}$/.test(part))
  const [family, ...version] = parts
  if (!family) return id
  const name = `${family[0]!.toUpperCase()}${family.slice(1)}${version.length ? ` ${version.join('.')}` : ''}`
  return is1m ? `${name} 1M` : name
}

/**
 * `text` word-wrapped into at most `maxLines` lines of `width` cells, the
 * markdown marks (`**`, backticks, `#` heads) dropped. Too long, it keeps the
 * start (`'start'`) or the end (`'end'`, where a reply stopped) and marks the
 * cut with `…`. The terminal draws each line as given: nothing spills.
 */
export const wrapText = (
  text: string,
  width: number,
  maxLines: number,
  keep: 'start' | 'end' = 'start',
): string[] => {
  const flat = text
    .replace(/\*\*|__|`/g, '')
    .replace(/^#+\s*/gm, '')
    .replace(/\s+/g, ' ')
    .trim()
  if (flat === '' || width < 4 || maxLines < 1) return flat === '' ? [] : [fit(flat, Math.max(1, width)).trimEnd()]
  const lines: string[] = []
  let current = ''
  for (const word of flat.split(' ')) {
    let rest = word
    while (rest.length > width) {
      // a word longer than a line (a path, a URL) is cut across lines
      const room = width - (current === '' ? 0 : current.length + 1)
      if (room < 8 && current !== '') {
        lines.push(current)
        current = ''
        continue
      }
      lines.push(current === '' ? rest.slice(0, room) : `${current} ${rest.slice(0, room)}`)
      current = ''
      rest = rest.slice(room)
    }
    if (current === '') current = rest
    else if (current.length + 1 + rest.length <= width) current = `${current} ${rest}`
    else {
      lines.push(current)
      current = rest
    }
  }
  if (current !== '') lines.push(current)
  return cutLines(lines, width, maxLines, keep)
}

/** At most `maxLines` of `lines`, the start or the end kept, the cut marked `…`. */
const cutLines = (lines: string[], width: number, maxLines: number, keep: 'start' | 'end'): string[] => {
  if (lines.length <= maxLines) return lines
  if (keep === 'end') {
    const kept = lines.slice(-maxLines)
    kept[0] = `…${kept[0]!.slice(kept[0]!.length >= width ? 1 : 0)}`
    return kept
  }
  const kept = lines.slice(0, maxLines)
  const last = kept[maxLines - 1]!
  kept[maxLines - 1] = `${last.length >= width ? last.slice(0, -1) : last}…`
  return kept
}

const LIST_ITEM = /^(\s*)([-*+•]|\d{1,3}[.)])\s+(.*)$/

/**
 * Like `wrapText`, but the text keeps its shape: each paragraph and each list
 * item starts its own line, an item as `• ` (or its number) with the lines
 * after it hung under its text, nested items indented. Blank lines and code
 * fences are dropped (a row is dear in the pane); code lines are cut, not
 * wrapped. A reply that is one long paragraph reads the same as before.
 */
export const wrapBlocks = (
  text: string,
  width: number,
  maxLines: number,
  keep: 'start' | 'end' = 'start',
): string[] => {
  if (width < 8 || maxLines < 1) return wrapText(text, width, maxLines, keep)
  const lines: string[] = []
  let inFence = false
  for (const raw of text.split('\n')) {
    const line = raw.trimEnd()
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence
      continue
    }
    if (line.trim() === '') continue
    if (inFence) {
      // code keeps its spacing and indent, cut at the edge
      const code = line.replace(/\t/g, '  ')
      lines.push(code.length > width ? `${code.slice(0, width - 1)}…` : code)
      continue
    }
    const item = LIST_ITEM.exec(line)
    if (item) {
      const indent = '  '.repeat(Math.min(2, Math.floor(item[1]!.replace(/\t/g, '  ').length / 2)))
      const marker = /\d/.test(item[2]!) ? item[2]! : '•'
      const hang = indent + ' '.repeat(marker.length + 1)
      wrapText(item[3]!, width - hang.length, Number.MAX_SAFE_INTEGER).forEach((part, i) =>
        lines.push(`${i === 0 ? `${indent}${marker} ` : hang}${part}`),
      )
    } else {
      lines.push(...wrapText(line, width, Number.MAX_SAFE_INTEGER))
    }
  }
  return cutLines(lines, width, maxLines, keep)
}

/** `text` in at most `width` cells, cut at the start with `…` (a path's end matters). */
export const fitStart = (text: string, width: number): string =>
  text.length > width ? `…${text.slice(text.length - Math.max(0, width - 1))}` : text

/**
 * A path in lines of at most `width` cells, each broken after a slash when one
 * falls in its last two thirds, else at the width. Past `maxLines` it keeps
 * the end (the file name matters most) and marks the cut with `…`.
 */
export const wrapPath = (path: string, width: number, maxLines: number): string[] => {
  if (width < 8 || path.length <= width) return [path]
  const lines: string[] = []
  let rest = path
  while (rest.length > width) {
    const head = rest.slice(0, width)
    const slash = Math.max(head.lastIndexOf('/'), head.lastIndexOf('\\'))
    const cut = slash >= width / 3 ? slash + 1 : width
    lines.push(rest.slice(0, cut))
    rest = rest.slice(cut)
  }
  if (rest !== '') lines.push(rest)
  if (lines.length <= maxLines) return lines
  const kept = lines.slice(-maxLines)
  kept[0] = fitStart(`…${kept[0]}`, width)
  return kept
}

/**
 * A plan's text as a transcript holds it, for a plan whose file is gone: the
 * last ExitPlanMode call whose result names `name`, or a plan reference
 * attachment for it. With no file named, the last plan sent.
 */
export const planTextFrom = (text: string, name: string): string => {
  const inputs = new Map<string, string>()
  let found = ''
  let last = ''
  for (const raw of text.split('\n')) {
    if (!raw.includes('ExitPlanMode') && !raw.includes('plan_file_reference') && !raw.includes('"plan"')) continue
    let line: Line & { attachment?: { planContent?: unknown } }
    try {
      line = JSON.parse(raw)
    } catch {
      continue
    }
    const attachment = line.attachment
    if (attachment?.type === 'plan_file_reference' && typeof attachment.planFilePath === 'string' &&
      lastPart(attachment.planFilePath) === name && typeof attachment.planContent === 'string') {
      found = attachment.planContent
    }
    const content = line.message?.content
    if (!Array.isArray(content)) continue
    for (const block of content) {
      if (block.type === 'tool_use' && block.name === 'ExitPlanMode' && typeof block.input?.plan === 'string') {
        inputs.set(block.id ?? '', block.input.plan)
        last = block.input.plan
      }
      if (block.type === 'tool_result' && typeof block.tool_use_id === 'string' && inputs.has(block.tool_use_id)) {
        const r = line.toolUseResult as { filePath?: unknown } | undefined
        if (typeof r?.filePath === 'string' && lastPart(r.filePath) === name) found = inputs.get(block.tool_use_id)!
      }
    }
  }
  return found || (name.startsWith('plan-') ? last : '')
}

// ---------------------------------------------------------------------------
// Search: words matched in prompts and replies, without case or accents.

const ASCII_LOWER = Array.from({ length: 128 }, (_, code) => String.fromCharCode(code).toLowerCase())

/**
 * The text in lower case and without accents, one UTF-16 unit for one, so a
 * position in it is the same position in the text (a snippet cuts both alike).
 */
export const fold = (text: string): string => {
  let out = ''
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i)
    if (code < 128) {
      out += ASCII_LOWER[code]
      continue
    }
    const unit = text[i]!
    const bare = unit.normalize('NFD').charAt(0).toLowerCase()
    out += bare.length === 1 ? bare : unit
  }
  return out
}

/** The query's words, folded: every one must appear in a message, in any order. */
export const searchTerms = (query: string): string[] => fold(query).split(/\s+/).filter(term => term !== '')

export const matchesAll = (folded: string, terms: string[]): boolean =>
  terms.length > 0 && terms.every(term => folded.includes(term))

/**
 * One line of `width` around the first word's first match: the text before
 * it, the match, the text after, white space turned into single spaces.
 */
export const snippetOf = (
  text: string,
  folded: string,
  terms: string[],
  width: number,
): { before: string; hit: string; after: string } => {
  const term = terms[0] ?? ''
  const at = Math.max(0, folded.indexOf(term))
  const flat = (part: string) => part.replace(/\s/g, ' ')
  const lead = Math.max(0, Math.floor((width - term.length) / 3))
  const start = Math.max(0, at - lead)
  const before = (start > 0 ? '…' : '') + flat(text.slice(start, at)).replace(/^ +/, '')
  const hit = flat(text.slice(at, at + term.length))
  const room = Math.max(0, width - before.length - hit.length)
  const tail = flat(text.slice(at + term.length, at + term.length + room + 1))
  const after = tail.length > room ? `${tail.slice(0, Math.max(0, room - 1))}…` : tail
  return { before, hit, after }
}
