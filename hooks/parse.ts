import type { FileDiff, SessionReport, TokenUsage } from '../types'

// Claude Code names a project's transcript folder after its path, every
// character outside [A-Za-z0-9] turned into "-".
export const projectFolderName = (path: string): string =>
  path.replace(/[^A-Za-z0-9]/g, '-')

type Block = {
  type?: string
  text?: string
  name?: string
  input?: Record<string, unknown>
}

type Line = {
  type?: string
  isMeta?: boolean
  isSidechain?: boolean
  timestamp?: string
  cwd?: string
  gitBranch?: string
  summary?: string
  customTitle?: string
  aiTitle?: string
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

/** The tokens of one subagent's transcript, as `sumUsage` counts them. */
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

const oneLine = (text: string, max: number): string => {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}

// The last `max` characters, from a word's start, marked … when cut.
const tailOf = (text: string, max: number): string =>
  text.length > max ? `…${text.slice(-max).replace(/^\S*\s*/, '')}` : text

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
): SessionReport | undefined => {
  let title = ''
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
  const files = new Map<string, FileDiff>()
  const usageById = new Map<string, Usage>()
  let unnamed = 0
  const touch = (path: string, added = 0, removed = 0) => {
    const known = files.get(path) ?? { path, added: 0, removed: 0 }
    known.added += added
    known.removed += removed
    files.set(path, known)
  }

  for (const raw of text.split('\n')) {
    if (raw.trim() === '') continue
    let line: Line
    try {
      line = JSON.parse(raw) as Line
    } catch {
      continue // a line cut at a read boundary
    }

    if (line.type === 'summary' && line.summary) title = line.summary
    if (line.type === 'custom-title' && line.customTitle) title = line.customTitle
    if (line.type === 'ai-title' && line.aiTitle) aiTitle = line.aiTitle
    if (line.isSidechain) continue
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

    if (!isInherited) {
      for (const diff of diffsOf(line.toolUseResult)) touch(diff.path, diff.added, diff.removed)
    }

    const message = line.message
    if (!message) continue

    if (line.type === 'user' && !line.isMeta) {
      const said = textOf(message.content)
      if (said !== '' && !isNoise(said)) {
        if (isInherited) {
          if (inheritedFirst === '') inheritedFirst = said
        } else {
          turns += 1
          if (firstPrompt === '') firstPrompt = said
        }
        lastPrompt = said
      }
    }

    if (line.type === 'assistant') {
      if (message.model && message.model !== '<synthetic>') model = message.model
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
          const path = block.input?.file_path ?? block.input?.notebook_path
          if (EDIT_TOOLS.has(block.name ?? '') && typeof path === 'string') {
            touch(path)
          }
        }
      }
      const said = textOf(message.content)
      if (said.trim() !== '') lastReply = said
    }
  }

  if (turns === 0 && lastReply === '') return undefined
  // A fork with nothing of its own yet starts where its copy ends.
  if (startedAt === '') startedAt = endedAt

  const contextWindow =
    contextTokens > 200_000 || /\[1m\]/i.test(model) ? 1_000_000 : 200_000
  const durationMs =
    startedAt && endedAt ? Date.parse(endedAt) - Date.parse(startedAt) : 0

  return {
    id,
    title: oneLine(title || firstPrompt || inheritedFirst || aiTitle.replace(/-/g, ' ') || '(no prompt)', 80),
    parent,
    firstPrompt: oneLine(firstPrompt, 800),
    lastPrompt: oneLine(lastPrompt, 800),
    // the reply's end, enough for the report to scroll through; cut at a word
    lastReply: tailOf(lastReply.trim(), 1600),
    startedAt,
    endedAt,
    durationMs: Number.isFinite(durationMs) ? Math.max(0, durationMs) : 0,
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
    agents: { count: 0, usage: emptyUsage(), isPartial: false },
    isPartial,
  }
}

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

export const lastPart = (path: string): string =>
  path.split(/[\\/]/).filter(Boolean).at(-1) ?? path

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

/** `text` in at most `width` cells, cut at the start with `…` (a path's end matters). */
export const fitStart = (text: string, width: number): string =>
  text.length > width ? `…${text.slice(text.length - Math.max(0, width - 1))}` : text
