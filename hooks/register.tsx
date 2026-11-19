import { atom, read, update } from 'claude-code'
import type { EngineInterface as Engine, Register, RenderSurface } from 'claude-code'

import type { Listing, Scope, SessionReport, TreeNode } from '../types'
import {
  ago,
  bar,
  duration,
  fit,
  lastPart,
  levelColor,
  modelName,
  parseAgentUsage,
  parseTranscript,
  projectFolderName,
  tokens,
} from './parse'

const PANE = 'super-resume'
const TITLE = 'Super Resume'

const scopeAtom = atom({ plugin: 'super-resume', key: 'scope' } as const, 'project' as Scope)
const selectedAtom = atom({ plugin: 'super-resume', key: 'selected' } as const, '')
// Change the tag when SessionReport's fields change: it declines what an
// earlier version stored, which outlives a reload.
const listingAtom = atom(
  { plugin: 'super-resume', key: 'listing' } as const,
  {
    scope: 'project',
    root: '',
    branch: '',
    sessions: [],
    tree: {},
    isLoading: false,
    error: '',
  } as Listing,
  { shape: 'listing-3' },
)

// Files above this size are read as head + tail, never whole.
const WHOLE_LIMIT = 1_500_000
const HEAD_BYTES = 256_000
const TAIL_BYTES = 1_250_000
const MAX_SESSIONS = 50

// Parsed reports by path and mtime; a reload starts it over, which is fine.
const cache = new Map<string, SessionReport | null>()

// Bumped by every load() call. A switch of scope while an earlier load is
// still reading files (branch -> all -> project, pressed quickly) must not
// let the earlier one win the final paint just because its disk reads
// happened to finish last.
let loadSeq = 0

const isScope = (text: string): text is Scope =>
  text === 'branch' || text === 'project' || text === 'all'

async function readReport(
  $: Engine,
  path: string,
  id: string,
  size: number,
  mtimeMs: number,
  fallbackCwd: string,
): Promise<SessionReport | undefined> {
  const key = `${path}:${mtimeMs}`
  const known = cache.get(key)
  if (known !== undefined) return known ?? undefined

  let text: string
  let isPartial = false
  if (size <= WHOLE_LIMIT) {
    text = await $.fs.read(path)
  } else {
    isPartial = true
    const head = await $.fs.read(path, { length: HEAD_BYTES })
    const tail = await $.fs.read(path, { offset: size - TAIL_BYTES, length: TAIL_BYTES })
    text = `${head}\n${tail}`
  }
  const report = parseTranscript(id, text, isPartial, fallbackCwd)
  if (report) report.agents = await readAgents($, path.slice(0, -'.jsonl'.length))
  cache.set(key, report ?? null)
  return report
}

// A session's subagents write their own transcripts beside it, in
// <id>/subagents/agent-*.jsonl. Their tokens are added up apart from the
// session's; one too large to read whole is read as its tail, a lower bound.
async function readAgents($: Engine, sessionDir: string): Promise<SessionReport['agents']> {
  const agents: SessionReport['agents'] = { count: 0, usage: { input: 0, output: 0, cache: 0 }, isPartial: false }
  const dir = `${sessionDir}/subagents`
  const entries = await $.fs.list(dir).catch(() => [])
  for (const entry of entries) {
    if (entry.kind !== 'file' || !entry.name.endsWith('.jsonl')) continue
    const isWhole = entry.size <= WHOLE_LIMIT
    const text = await $.fs
      .read(`${dir}/${entry.name}`, isWhole ? undefined : { offset: entry.size - TAIL_BYTES, length: TAIL_BYTES })
      .catch(() => '')
    const usage = parseAgentUsage(text)
    agents.count += 1
    agents.usage.input += usage.input
    agents.usage.output += usage.output
    agents.usage.cache += usage.cache
    if (!isWhole) agents.isPartial = true
  }
  return agents
}

const parentOf = (path: string): string => path.replace(/[\\/]+[^\\/]*[\\/]*$/, '')

// Where the transcripts live and which folder is this project's. The session's
// own transcript (<config>/projects/<folder>/<id>.jsonl) says both, whatever the
// config dir or platform; without one, fall back to the config dir and the
// folder naming rule. Windows shells often have USERPROFILE and no HOME.
async function locate($: Engine, root: string): Promise<{ base: string; current: string }> {
  const info = await $.session.info().catch(() => undefined)
  const transcript = info?.transcriptPath ?? ''
  if (transcript !== '') {
    const folder = parentOf(transcript)
    return { base: parentOf(folder), current: lastPart(folder) }
  }
  const home = (await $.env.get('HOME')) ?? (await $.env.get('USERPROFILE')) ?? ''
  const configDir = (await $.env.get('CLAUDE_CONFIG_DIR')) ?? `${home}/.claude`
  return { base: `${configDir}/projects`, current: projectFolderName(root) }
}

async function load($: Engine, scope: Scope): Promise<void> {
  const seq = ++loadSeq
  await update($, listingAtom, old => ({ ...old, scope, isLoading: true, error: '' }))
  try {
    const root = await $.session.root()
    const { base, current } = await locate($, root)
    const git = await $.process
      .run(['git', 'rev-parse', '--abbrev-ref', 'HEAD'], { cwd: root, timeoutMs: 5000 })
      .catch(() => undefined)
    const branch = git?.exitCode === 0 ? git.stdout.trim() : ''

    const folders =
      scope === 'all'
        ? (await $.fs.list(base)).filter(entry => entry.kind === 'dir').map(entry => entry.name)
        : [current]

    const files: { path: string; id: string; size: number; mtimeMs: number }[] = []
    for (const folder of folders) {
      const dir = `${base}/${folder}`
      const entries = await $.fs.list(dir).catch(() => [])
      for (const entry of entries) {
        if (entry.kind !== 'file' || !entry.name.endsWith('.jsonl')) continue
        files.push({
          path: `${dir}/${entry.name}`,
          id: entry.name.slice(0, -'.jsonl'.length),
          size: entry.size,
          mtimeMs: entry.mtimeMs,
        })
      }
    }
    files.sort((a, b) => b.mtimeMs - a.mtimeMs)

    const sessions: SessionReport[] = []
    for (const file of files) {
      if (sessions.length >= MAX_SESSIONS) break
      const report = await readReport($, file.path, file.id, file.size, file.mtimeMs, root)
        .catch(() => undefined)
      if (!report) continue
      if (scope === 'branch' && branch !== '' && report.branch !== branch) continue
      sessions.push(report)
    }

    // The tree: each listed session, and up a fork's chain the parents that
    // are not listed (another branch, past the 50), read from this listing's
    // folders. A parent whose transcript is gone stays a bare id.
    const tree: Record<string, TreeNode> = {}
    const node = (report: SessionReport): TreeNode => ({
      title: report.title,
      endedAt: report.endedAt,
      parent: report.parent,
    })
    for (const session of sessions) tree[session.id] = node(session)
    const byId = new Map(files.map(file => [file.id, file]))
    for (const session of sessions) {
      let at = session.parent
      for (let depth = 0; at !== '' && tree[at] === undefined && depth < 8; depth++) {
        const file = byId.get(at)
        const report = file
          ? await readReport($, file.path, file.id, file.size, file.mtimeMs, root).catch(() => undefined)
          : undefined
        if (!report) break
        tree[at] = node(report)
        at = report.parent
      }
    }

    // A later load() (another scope switch) may have started and already
    // painted its own result while this one was still reading files; its
    // state stands, so this now-stale one is dropped instead of clobbering it.
    if (seq !== loadSeq) return

    await update($, listingAtom, () => ({
      scope,
      root,
      branch,
      sessions,
      tree,
      isLoading: false,
      error: sessions.length === 0 ? `No sessions found under ${base}` : '',
    }))
    const selected = await read($, selectedAtom)
    if (!sessions.some(session => session.id === selected)) {
      await update($, selectedAtom, () => sessions[0]?.id ?? '')
    }
  } catch (error) {
    if (seq !== loadSeq) return
    await update($, listingAtom, old => ({
      ...old,
      isLoading: false,
      error: error instanceof Error ? error.message : String(error),
    }))
  }
}

async function setScope($: Engine, scope: Scope): Promise<void> {
  await update($, scopeAtom, () => scope)
  await load($, scope)
}

// Same folder on any platform: Windows paths differ in slashes and case.
const samePath = (a: string, b: string): boolean => {
  const norm = (path: string) => path.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
  return norm(a) === norm(b)
}

// Enter on a session row, as /resume's picker: switch this terminal to it.
// The built-in /resume swaps the conversation in place, but only for a session
// of this project's folder; one from another folder needs `cd` first, which a
// mod can't do to the running process, so that one is copied to paste instead.
async function choose($: Engine, session: SessionReport, surface: RenderSurface): Promise<void> {
  await update($, selectedAtom, () => session.id)
  if (session.id === (await $.session.id())) {
    await $.ui.close({ id: PANE })
    return
  }
  const root = await $.session.root()
  if (samePath(session.cwd, root)) {
    await $.ui.close({ id: PANE })
    await $.command.run({ command: 'resume', args: session.id })
    return
  }
  const copied = await $.ui.copy({
    text: `cd "${session.cwd}" && claude --resume ${session.id}`,
    surface,
  })
  await $.ui.close({ id: PANE })
  $.ui.toast(
    copied.isCopied
      ? `Other project: resume command copied, paste it in a terminal`
      : 'Could not copy the resume command',
  )
}

// What the last drawing showed of the list, for the key hooks: which session
// rows were on screen (the window), where the window starts, and the cells the
// list takes, to tell a wheel tick over the list from one over the report.
// Module state: a reload starts it over, and the next drawing fills it in.
const view = {
  ids: [] as string[],
  start: 0,
  listColumns: 0,
  listRowEnd: 0,
}
// The element the focus ring last landed on in the pane.
let ringAt = ''

// Move the selection by `delta` rows (±Infinity: first/last), and the focus
// ring with it so Enter acts on the row the ▶ points at.
async function move($: Engine, delta: number): Promise<void> {
  const { sessions } = await read($, listingAtom)
  if (sessions.length === 0) return
  const selected = await read($, selectedAtom)
  const from = Math.max(0, sessions.findIndex(session => session.id === selected))
  const to = Math.min(sessions.length - 1, Math.max(0, from + delta))
  const target = sessions[to]
  if (!target) return
  if (to !== from) await update($, selectedAtom, () => target.id)
  await $.ui.focus({ requestId: PANE, key: `session:${target.id}` }).catch(() => undefined)
}

// The rows a page key moves: the session rows the window shows.
const pageRows = (): number => Math.max(1, view.ids.length - 1)

const copyCommand = ($: Engine, session: SessionReport, surface: RenderSurface) =>
  void $.ui
    .copy({ text: `cd "${session.cwd}" && claude --resume ${session.id}`, surface })
    .then(result => $.ui.toast(result.isCopied ? 'Resume command copied' : 'Could not copy'))

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'super-resume',
      description: 'Browse past sessions with a report for each (args: branch | project | all)',
    })
    return next(e)
  })

  on('command.run', { command: 'super-resume' }, async ($, e) => {
    const wanted = e.args.trim().toLowerCase()
    const scope = isScope(wanted) ? wanted : await read($, scopeAtom)
    // Opened as a dialog, like /resume's picker: it takes the keys, Esc closes
    // it, and toasts wait behind it. Inline (above the prompt) it spans the
    // whole terminal, and `rows` asks for the height of the list + report;
    // docked beside a fullscreen transcript the engine caps it at 45% of the
    // columns, and `columns` asks for all of that.
    await $.ui.open({
      id: PANE,
      title: TITLE,
      focus: true,
      closeOnEscape: true,
      holdToasts: true,
      rows: 30,
      columns: 999,
    })
    void setScope($, scope)
    return { text: `Super Resume opened (${scope}).`, isTextDisplayOnly: true }
  })

  // The arrows, page keys and Home/End scroll the pane's body while its tree
  // is taller than the room; the list draws only the rows that fit, so here a
  // key moves the selection instead, and the body stays put. A wheel tick over
  // the list moves it a row; over the report it scrolls as usual.
  on('ui.scroll', { component: 'Pane', requestId: PANE }, async ($, e, next) => {
    if (e.origin.kind !== 'person') return next(e)
    let delta: number
    if (e.pointer) {
      const overList =
        e.pointer.column >= 0 &&
        e.pointer.column < view.listColumns &&
        e.pointer.row < view.listRowEnd
      if (!overList) return next(e)
      delta = Math.sign(e.by)
    } else if (Math.abs(e.by) === e.bodyRows) {
      delta = Math.sign(e.by) * pageRows()
    } else if (e.contentRows > 0 && Math.abs(e.by) >= e.contentRows) {
      delta = Math.sign(e.by) * Infinity
    } else {
      delta = e.by
    }
    if (delta !== 0) void move($, delta)
    return {}
  })

  // Tab/arrows move the site's own focus ring over the Buttons without
  // calling their onPress (that's Enter/click), so follow the ring onto
  // whichever session row it lands on: the ▶ and the report go with it.
  // Leaving the window's first or last row for a control outside the list
  // while more sessions lie that way slides the window instead.
  on('ui.focus', { component: 'Pane', requestId: PANE }, async ($, e, next) => {
    const element = e.element ?? ''
    if (e.origin.kind === 'person' && ringAt.startsWith('session:') && !element.startsWith('session:')) {
      const from = ringAt.slice('session:'.length)
      const at = view.ids.indexOf(from)
      const { sessions } = await read($, listingAtom)
      const index = sessions.findIndex(session => session.id === from)
      const isAbove = element.startsWith('scope:')
      if (at === view.ids.length - 1 && !isAbove && index >= 0 && index < sessions.length - 1) {
        void move($, 1)
        return {}
      }
      if (at === 0 && isAbove && index > 0) {
        void move($, -1)
        return {}
      }
    }
    const result = await next(e)
    if (!result.deny) {
      ringAt = element
      if (element.startsWith('session:')) {
        await update($, selectedAtom, () => element.slice('session:'.length))
      }
    }
    return result
  }).catch(($, e, next) => next(e))

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const listing = await read($, listingAtom)
    const scope = await read($, scopeAtom)
    const selectedId = await read($, selectedAtom)
    const thisSession = await $.session.id()
    const now = Date.now()
    const columns = e.props.bodyColumns
    const bodyRows = e.props.scroll.bodyRows
    // Side by side when the pane spans the terminal (inline) and has room;
    // docked (45% at most) or narrow, the list sits above the report.
    const isSplit = e.props.placement === 'inline' && columns >= 80
    const sessions = listing.sessions
    const selectedIndex = Math.max(0, sessions.findIndex(session => session.id === selectedId))
    const selected = sessions[selectedIndex]

    // Rows: header 1, footer 1, and in split each column's border 2 + its
    // heading 1. Stacked: a hint row when docked, the list box, then the report.
    const hintRows = isSplit ? 0 : 1
    const boxRows = Math.max(8, bodyRows - 2 - hintRows)
    const listBoxRows = isSplit ? boxRows : Math.min(boxRows - 6, Math.max(5, Math.min(14, sessions.length + 3)))
    const listSlots = Math.max(1, listBoxRows - 3)
    const reportBoxRows = isSplit ? boxRows : Math.max(6, boxRows - listBoxRows)

    const listOuter = isSplit ? Math.floor(columns / 2) : columns
    const reportOuter = isSplit ? columns - listOuter : columns
    const listInner = Math.max(10, listOuter - 4)
    const reportInner = Math.max(10, reportOuter - 4)

    // The window over the list: every session when they fit, else the rows
    // that fit with a line above and below saying how many are out of view,
    // moved the least that keeps the selected row showing.
    const overflows = sessions.length > listSlots
    const slots = overflows ? Math.max(1, listSlots - 2) : listSlots
    let start = Math.min(view.start, Math.max(0, sessions.length - slots))
    if (selectedIndex < start) start = selectedIndex
    if (selectedIndex >= start + slots) start = selectedIndex - slots + 1
    start = Math.max(0, start)
    const shown = sessions.slice(start, start + slots)
    view.ids = shown.map(session => session.id)
    view.start = start
    view.listColumns = listOuter
    // Rows from the body's top through the list box's bottom.
    view.listRowEnd = 1 + hintRows + listBoxRows

    const scopeButton = (value: Scope, hotkey: string, label: string) => (
      <Button
        key={`scope:${value}`}
        hotkey={hotkey}
        plain
        dimColor={scope !== value}
        onPress={() => void setScope($, value)}
      >
        {scope === value ? <Text bold color="claude">● {label}</Text> : <Text>{label}</Text>}
      </Button>
    )

    const header = (
      <Box flexDirection="row" justifyContent="space-between">
        <Box flexDirection="row" gap={2}>
          <Text bold color="claude">Super Resume</Text>
          {scopeButton('branch', 'b', listing.branch ? `branch ${listing.branch}` : 'branch')}
          {scopeButton('project', 'p', isSplit ? `project ${lastPart(listing.root)}` : 'project')}
          {scopeButton('all', 'a', 'all')}
        </Box>
        <Text dimColor>{listing.isLoading ? 'loading…' : `${sessions.length} sessions`}</Text>
      </Box>
    )

    // A row: ▶, the title, its age, • on this session. The context bar is the
    // report's alone: in every row it was noise.
    const titleWidth = Math.max(4, listInner - 2 - 5 - 2)
    const row = (session: SessionReport) => {
      const isSelected = session.id === selected?.id
      return (
        <Button
          key={`session:${session.id}`}
          plain
          autoFocus={isSelected || undefined}
          onPress={press => void choose($, session, press.surface)}
        >
          <Text color="claude">{isSelected ? '▶ ' : '  '}</Text>
          {session.parent !== '' && <Text dimColor>↳ </Text>}
          <Text bold={isSelected} color={isSelected ? 'claude' : undefined}>
            {fit(session.title, session.parent !== '' ? titleWidth - 2 : titleWidth)}
          </Text>
          <Text dimColor> {ago(session.endedAt, now).padStart(4)}</Text>
          <Text color="suggestion">{session.id === thisSession ? ' •' : '  '}</Text>
        </Button>
      )
    }

    const above = start
    const below = sessions.length - start - shown.length
    const list = (
      <Box
        flexDirection="column"
        width={listOuter}
        height={listBoxRows}
        borderStyle="round"
        borderColor="subtle"
        paddingX={1}
        overflow="hidden"
      >
        <Text bold color="subtle">Sessions</Text>
        {sessions.length === 0 && (
          <Text dimColor>{listing.error || (listing.isLoading ? 'Reading…' : 'No sessions.')}</Text>
        )}
        {overflows && <Text dimColor>{above > 0 ? `  ↑ ${above} more` : ' '}</Text>}
        {shown.map(row)}
        {overflows && <Text dimColor>{below > 0 ? `  ↓ ${below} more` : ' '}</Text>}
      </Box>
    )

    // Statusline-style: one-word labels, values set apart by a dim ` | `.
    const rule = <Text dimColor>{'─'.repeat(reportInner)}</Text>
    const SEP = <Text dimColor> | </Text>
    const heading = (text: string) => <Text bold color="subtle">{text}</Text>
    // `Tokens 4.3M | In 210k | Out 95k | Cache 4.0M`; an agents line puts its
    // count first and the total after it.
    const tokenLine = (label: string, usage: SessionReport['usage'], isPartial: boolean, totalLabel = '') => {
      const atLeast = isPartial ? '≥' : ''
      const total = usage.input + usage.output + usage.cache
      return (
        <Text wrap="truncate-end">
          <Text dimColor>{label} </Text>
          {totalLabel !== '' && <Text dimColor>| {totalLabel}</Text>}
          <Text>{atLeast}{tokens(total)}</Text>
          {SEP}<Text dimColor>In </Text><Text>{atLeast}{tokens(usage.input)}</Text>
          {SEP}<Text dimColor>Out </Text><Text>{atLeast}{tokens(usage.output)}</Text>
          {SEP}<Text dimColor>Cache </Text><Text>{atLeast}{tokens(usage.cache)}</Text>
        </Text>
      )
    }
    // Where the session sits in its tree: the parent it was forked from, the
    // chain above that when the parent is itself a fork, and its own forks.
    const short = (id: string) => id.slice(0, 8)
    const nameOf = (id: string) => listing.tree[id]?.title ?? short(id)
    const treeLines = (session: SessionReport) => {
      const chain: string[] = []
      for (let at = session.parent; at !== '' && chain.length < 8 && !chain.includes(at); ) {
        chain.unshift(at)
        at = listing.tree[at]?.parent ?? ''
      }
      const forks = Object.entries(listing.tree)
        .filter(([, node]) => node.parent === session.id)
        .sort(([, a], [, b]) => b.endedAt.localeCompare(a.endedAt))
      const parent = listing.tree[session.parent]
      return (
        <>
          {session.parent !== '' && (
            <Text wrap="truncate-end">
              <Text dimColor>↳ </Text>
              <Text>{nameOf(session.parent)}</Text>
              {parent ? (
                <Text>{SEP}<Text dimColor>{ago(parent.endedAt, now)} ago</Text></Text>
              ) : (
                <Text>{SEP}<Text dimColor>{short(session.parent)} gone</Text></Text>
              )}
            </Text>
          )}
          {chain.length > 1 && (
            <Text wrap="truncate-end">
              <Text dimColor>Chain </Text>
              <Text dimColor>{chain.map(id => fit(nameOf(id), 20).trimEnd()).join(' › ')} › </Text>
              <Text>this</Text>
            </Text>
          )}
          {forks.length > 0 && (
            <Text wrap="truncate-end">
              <Text dimColor>Forks </Text>
              <Text>{forks.length}</Text>
              {forks.slice(0, 3).map(([id, node]) => (
                <Text key={`fork:${id}`}>{SEP}<Text dimColor>{fit(node.title, 28).trimEnd()}</Text></Text>
              ))}
            </Text>
          )}
        </>
      )
    }
    const plusMinus = (added: number, removed: number) => (
      <Text>
        <Text color="success">+{added}</Text>
        <Text> </Text>
        <Text color="error">-{removed}</Text>
      </Text>
    )
    const relative = (file: string, cwd: string) =>
      file.toLowerCase().startsWith(cwd.toLowerCase()) ? file.slice(cwd.length + 1) : file

    const report = (
      <Box
        flexDirection="column"
        width={reportOuter}
        height={reportBoxRows}
        borderStyle="round"
        borderColor="subtle"
        paddingX={1}
        overflow="hidden"
      >
        {!selected && <Text dimColor>No session selected.</Text>}
        {selected && (() => {
          const ratio = selected.contextTokens / selected.contextWindow
          const cells = bar(ratio, 10)
          const atLeast = selected.isPartial ? '≥' : ''
          return (
            <>
              <Text bold color="claude" wrap="truncate-end">
                {selected.parent !== '' && <Text dimColor>↳ </Text>}
                {selected.title}
              </Text>
              <Text wrap="truncate-end">
                <Text>{lastPart(selected.cwd)}</Text>
                {selected.branch !== '' && <Text>{SEP}<Text color="merged">⎇ {selected.branch}</Text></Text>}
                {selected.model !== '' && <Text>{SEP}<Text color="suggestion">{modelName(selected.model)}</Text></Text>}
              </Text>
              {treeLines(selected)}
              <Text wrap="truncate-end">
                <Text dimColor>Ctx </Text>
                <Text color={levelColor(ratio)}>{cells.on}</Text>
                <Text dimColor>{cells.off}</Text>
                <Text> {Math.round(ratio * 100)}% </Text>
                <Text dimColor>{tokens(selected.contextTokens)}</Text>
                {SEP}<Text dimColor>Turns </Text><Text>{atLeast}{selected.turns}</Text>
                {SEP}<Text dimColor>Tools </Text><Text>{atLeast}{selected.toolCalls}</Text>
                {SEP}<Text dimColor>Files </Text><Text>{selected.files.length}</Text>
              </Text>
              {tokenLine('Tokens', selected.usage, selected.isPartial)}
              {selected.agents.count > 0 &&
                tokenLine(`Agents ${selected.agents.count}`, selected.agents.usage, selected.agents.isPartial, 'Tokens ')}
              <Text wrap="truncate-end">
                <Text dimColor>Started </Text><Text>{ago(selected.startedAt, now)} ago</Text>
                {SEP}<Text dimColor>Ended </Text><Text>{ago(selected.endedAt, now)} ago</Text>
                {SEP}<Text dimColor>Ran </Text><Text>{duration(selected.durationMs)}</Text>
              </Text>
              {rule}
              {heading('Last')}
              <Text maxLines={3}>
                <Text color="suggestion">user  › </Text>
                {selected.lastPrompt.replace(/\s+/g, ' ') || '—'}
              </Text>
              <Text maxLines={isSplit ? 6 : 4}>
                <Text color="claude">agent › </Text>
                {selected.lastReply.replace(/\s+/g, ' ').slice(-600) || '—'}
              </Text>
              {selected.firstPrompt !== '' && selected.firstPrompt !== selected.lastPrompt && (
                <>
                  <Text> </Text>
                  {heading('First')}
                  <Text dimColor maxLines={2}>{selected.firstPrompt.replace(/\s+/g, ' ')}</Text>
                </>
              )}
              {selected.files.length > 0 && (
                <>
                  <Text> </Text>
                  {heading('Diff')}
                  <Text>
                    {plusMinus(selected.added, selected.removed)}
                    <Text dimColor>  {selected.files.length} {selected.files.length === 1 ? 'file' : 'files'}</Text>
                  </Text>
                  <Text> </Text>
                  {heading('Files')}
                  {selected.files.slice(0, 6).map(file => (
                    <Text key={`file:${file.path}`} wrap="truncate-start">
                      {plusMinus(file.added, file.removed)}
                      <Text dimColor>  {relative(file.path, selected.cwd)}</Text>
                    </Text>
                  ))}
                  {selected.files.length > 6 && <Text dimColor>+{selected.files.length - 6} more</Text>}
                </>
              )}
            </>
          )
        })()}
      </Box>
    )

    const footer = (
      <Box flexDirection="row" gap={2}>
        <Text dimColor wrap="truncate-end">
          {isSplit ? '↑↓ move · PgUp/PgDn page · Home/End · Enter resume' : '↑↓ move · Enter resume'}
        </Text>
        <Button
          key="copy-resume"
          hotkey="c"
          plain
          dimColor
          onPress={press => {
            if (selected) copyCommand($, selected, press.surface)
          }}
        >
          copy
        </Button>
        <Button key="refresh" hotkey="r" plain dimColor onPress={() => void load($, scope)}>
          refresh
        </Button>
        <Text dimColor>Esc close</Text>
      </Box>
    )

    return (
      <Box flexDirection="column">
        {header}
        {!isSplit && (
          <Text dimColor wrap="truncate-end">
            {e.props.placement === 'dock'
              ? 'Outside fullscreen: list and report side by side.'
              : '80+ columns: list and report side by side.'}
          </Text>
        )}
        <Box flexDirection={isSplit ? 'row' : 'column'}>
          {list}
          {report}
        </Box>
        {footer}
      </Box>
    )
  })
}
