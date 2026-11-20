import { atom, read, update } from 'claude-code'
import type { Atom, EngineInterface as Engine, Register, RenderSurface } from 'claude-code'

import type { GitInfo, ListMode, Listing, Panel, PlanRow, Scope, SessionReport, Settings, TreeNode } from '../types'
import {
  ago,
  bar,
  duration,
  fit,
  fitStart,
  isSameFile,
  lastPart,
  levelColor,
  modelName,
  parseAgentMeta,
  parseAgentUsage,
  parseTranscript,
  planTextFrom,
  planTitle,
  projectFolderName,
  relativeTo,
  scoreOf,
  slug,
  tokens,
  wrapPath,
  wrapBlocks,
  wrapText,
} from './parse'
import {
  DEFAULT_SETTINGS,
  EXPORT_DIRS,
  SECTIONS,
  activeLabel,
  agentLines,
  badge,
  chartLines,
  effortMeter,
  enabled,
  healthLine,
  helpLines,
  isDirty,
  openLines,
  planLines,
  planStatus,
  qualityLines,
  summaryLines,
  todoLines,
  uncommittedLines,
} from './sections'

const PANE = 'super-resume'
const TITLE = 'Super Resume'

const scopeAtom = atom({ plugin: 'super-resume', key: 'scope' } as const, 'project' as Scope)
const selectedAtom = atom({ plugin: 'super-resume', key: 'selected' } as const, '')
const selectedPlanAtom = atom({ plugin: 'super-resume', key: 'selectedPlan' } as const, '')
// How far the report is scrolled, and for which session (or 'help'): picking
// another starts its report at the top.
const reportTopAtom = atom({ plugin: 'super-resume', key: 'reportTop' } as const, { id: '', top: 0 })
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
    plans: [],
    isLoading: false,
    error: '',
  } as Listing,
  { shape: 'listing-5' },
)
// What git says of each session's files, by session id: read on selection.
const gitAtom = atom({ plugin: 'super-resume', key: 'git' } as const, {} as Record<string, GitInfo>)
// The sections shown; kept across sessions in $.store under 'settings'.
// (typed by hand: the state contract reads Settings as a plain record)
const settingsAtom = atom({ plugin: 'super-resume', key: 'settings' } as const, DEFAULT_SETTINGS) as unknown as Atom<Settings>
// The settings row the cursor is on.
const settingsAtAtom = atom({ plugin: 'super-resume', key: 'settingsAt' } as const, 0)
const listModeAtom = atom({ plugin: 'super-resume', key: 'listMode' } as const, 'sessions' as ListMode)
const panelAtom = atom({ plugin: 'super-resume', key: 'panel' } as const, 'report' as Panel)
// Plans exported into a project: plan file name -> exported path. Kept in $.store too.
const exportsAtom = atom({ plugin: 'super-resume', key: 'exports' } as const, {} as Record<string, string>)

// Files above this size are read as head + tail, never whole. Long sessions
// grow past several MB within hours, and the quality and plan signals sit in
// their middle, so a file is read whole up to 16 MB (parsing that is ~0.1 s).
const WHOLE_LIMIT = 16_000_000
const HEAD_BYTES = 2_000_000
const TAIL_BYTES = 8_000_000
const MAX_SESSIONS = 50
const MAX_ORPHAN_PLANS = 60

// Parsed reports by path and mtime; a reload starts it over, which is fine.
const cache = new Map<string, SessionReport | null>()
// A selected plan's text, by plan name: read on demand, never kept in state.
const planTexts = new Map<string, string>()

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
  if (report) {
    report.transcript = path
    report.agents = await readAgents($, path.slice(0, -'.jsonl'.length))
  }
  cache.set(key, report ?? null)
  return report
}

// A session's subagents write their own transcripts beside it, in
// <id>/subagents/agent-*.jsonl, each with an agent-*.meta.json. Their tokens
// are added up apart from the session's; one too large to read whole is read
// as its tail, a lower bound.
async function readAgents($: Engine, sessionDir: string): Promise<SessionReport['agents']> {
  const agents: SessionReport['agents'] = {
    count: 0,
    usage: { input: 0, output: 0, cache: 0 },
    isPartial: false,
    maxDepth: 0,
    unfinished: 0,
  }
  const dir = `${sessionDir}/subagents`
  const entries = await $.fs.list(dir).catch(() => [])
  for (const entry of entries) {
    if (entry.kind !== 'file') continue
    if (entry.name.endsWith('.meta.json')) {
      const meta = parseAgentMeta(await $.fs.read(`${dir}/${entry.name}`).catch(() => ''))
      if (meta) {
        agents.maxDepth = Math.max(agents.maxDepth, meta.depth)
        if (!meta.finished) agents.unfinished += 1
      }
      continue
    }
    if (!entry.name.endsWith('.jsonl')) continue
    const isWhole = entry.size <= WHOLE_LIMIT
    const path = `${dir}/${entry.name}`
    const text = await (isWhole
      ? $.fs.read(path)
      : $.fs.read(path, { offset: entry.size - TAIL_BYTES, length: TAIL_BYTES })
    ).catch(() => '')
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

/**
 * Every plan of the listing, by plan file name: the session that wrote it,
 * the later sessions that named its file (or the file it was exported to),
 * and the plan files on disk no listed session wrote.
 */
async function joinPlans(
  $: Engine,
  sessions: SessionReport[],
  plansDir: string,
  exported: Record<string, string>,
): Promise<PlanRow[]> {
  const onDisk = await $.fs.list(plansDir).catch(() => [])
  const files = new Map(onDisk.filter(e => e.kind === 'file' && e.name.endsWith('.md')).map(e => [e.name, e]))
  const alias = new Map(Object.entries(exported).map(([plan, path]) => [lastPart(path), plan]))
  const rows = new Map<string, PlanRow>()

  // newest session first: the first to write a plan is its latest writer
  for (const session of sessions) {
    for (const plan of session.plans) {
      const known = rows.get(plan.name)
      if (known && known.at >= plan.at) continue
      rows.set(plan.name, {
        name: plan.name,
        path: plan.path,
        title: plan.title,
        status: plan.status,
        at: plan.at,
        revisions: plan.revisions + (known?.revisions ?? 0),
        origin: session.id,
        linked: [],
        files: plan.files,
        touched: [],
        exists: files.has(plan.name),
        isPartial: plan.isPartial,
      })
    }
  }
  // plan files no listed session wrote: the newest, titled from their head
  const orphans = [...files.values()]
    .filter(entry => !rows.has(entry.name))
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .slice(0, MAX_ORPHAN_PLANS)
  for (const entry of orphans) {
    const head = await $.fs.read(`${plansDir}/${entry.name}`, { length: 4000 }).catch(() => '')
    rows.set(entry.name, {
      name: entry.name,
      path: `${plansDir}/${entry.name}`,
      title: planTitle(head) || entry.name,
      status: 'file',
      at: new Date(entry.mtimeMs).toISOString(),
      revisions: 0,
      origin: '',
      linked: [],
      files: [],
      touched: [],
      exists: true,
      isPartial: false,
    })
  }
  for (const session of sessions) {
    for (const mention of session.mentions) {
      const row = rows.get(alias.get(mention) ?? mention)
      if (row && row.origin !== session.id && !row.linked.includes(session.id)) row.linked.push(session.id)
    }
  }
  const byId = new Map(sessions.map(session => [session.id, session]))
  for (const row of rows.values()) {
    // a plan file kept elsewhere (a custom plans folder): ask the disk
    if (!row.exists && row.path !== '' && !files.has(row.name)) {
      row.exists = await $.fs.exists(row.path).catch(() => false)
    }
    const edited = [row.origin, ...row.linked].flatMap(id => byId.get(id)?.files.map(f => f.path) ?? [])
    row.touched = row.files.filter(named => edited.some(path => isSameFile(named, path)))
  }
  return [...rows.values()].sort((a, b) => b.at.localeCompare(a.at))
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

    const exported = ((await $.store.get('exports').catch(() => undefined)) ?? {}) as Record<string, string>
    const plans = await joinPlans($, sessions, `${parentOf(base)}/plans`, exported).catch(() => [])

    // A later load() (another scope switch) may have started and already
    // painted its own result while this one was still reading files; its
    // state stands, so this now-stale one is dropped instead of clobbering it.
    if (seq !== loadSeq) return

    await update($, exportsAtom, () => exported)
    await update($, listingAtom, () => ({
      scope,
      root,
      branch,
      sessions,
      tree,
      plans,
      isLoading: false,
      error: sessions.length === 0 ? `No sessions found under ${base}` : '',
    }))
    const selected = await read($, selectedAtom)
    const target = sessions.some(session => session.id === selected) ? selected : sessions[0]?.id ?? ''
    await select($, target)
    const selectedPlan = await read($, selectedPlanAtom)
    if (!plans.some(plan => plan.name === selectedPlan)) {
      await update($, selectedPlanAtom, () => plans[0]?.name ?? '')
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

// ---------------------------------------------------------------------------
// Git: of the files a session edited inside its repository, what is still not
// committed now, and what a commit since the session started touched.

const GIT_EMPTY: GitInfo = { state: 'ok', total: 0, dirty: [], untracked: 0, added: 0, removed: 0, committed: 0, commits: 0 }

async function readGit($: Engine, session: SessionReport): Promise<GitInfo> {
  if (!(await $.fs.exists(session.cwd).catch(() => true))) return { ...GIT_EMPTY, state: 'gone' }
  const run = (cwd: string, args: string[]) => $.process.run(['git', ...args], { cwd, timeoutMs: 10_000 })
  const top = await run(session.cwd, ['rev-parse', '--show-toplevel'])
  if (top.exitCode !== 0) return { ...GIT_EMPTY, state: 'no-repo' }
  const root = top.stdout.trim()
  const rel = [...new Set(session.files.map(file => relativeTo(file.path, root)).filter(path => path !== ''))].slice(0, 200)
  if (rel.length === 0) return GIT_EMPTY

  const status = await run(root, ['status', '--porcelain', '--untracked-files=all', '--', ...rel])
  const dirty: string[] = []
  const untracked: string[] = []
  for (const line of status.stdout.split('\n')) {
    if (line.length < 4) continue
    const code = line.slice(0, 2)
    let path = line.slice(3).replace(/^.* -> /, '')
    if (path.startsWith('"') && path.endsWith('"')) path = path.slice(1, -1)
    dirty.push(path)
    if (code === '??') untracked.push(path)
  }

  let added = 0
  let removed = 0
  const numstat = await run(root, ['diff', '--numstat', 'HEAD', '--', ...rel])
  for (const line of numstat.stdout.split('\n')) {
    const [a, r] = line.split('\t')
    if (a && /^\d+$/.test(a)) added += Number(a)
    if (r && /^\d+$/.test(r)) removed += Number(r)
  }
  for (const path of untracked.slice(0, 30)) {
    const text = await $.fs.read(`${root}/${path}`).catch(() => '')
    if (text !== '') added += text.replace(/\n$/, '').split('\n').length
  }

  const log = await run(root, ['log', `--since=${session.startedAt}`, '--format=%H', '--name-only', '--', ...rel])
  const touched = new Set<string>()
  let commits = 0
  for (const line of log.stdout.split('\n')) {
    const text = line.trim()
    if (text === '') continue
    if (/^[0-9a-f]{40}$/.test(text)) commits += 1
    else touched.add(text.toLowerCase())
  }
  const committed = rel.filter(path => touched.has(path.toLowerCase())).length
  return { state: 'ok', total: rel.length, dirty, untracked: untracked.length, added, removed, committed, commits }
}

async function loadGit($: Engine, session: SessionReport, force = false): Promise<void> {
  const settings = await read($, settingsAtom)
  if (!enabled(settings, 'uncommitted') && !enabled(settings, 'score')) return
  if (session.files.length === 0) return
  const known = (await read($, gitAtom))[session.id]
  if (known && !force) return
  await update($, gitAtom, all => ({ ...all, [session.id]: { ...GIT_EMPTY, state: 'loading' as const } }))
  const info = await readGit($, session).catch((): GitInfo => ({ ...GIT_EMPTY, state: 'error' }))
  await update($, gitAtom, all => ({ ...all, [session.id]: info }))
}

// Select a session: the report follows, and git is asked about its files.
async function select($: Engine, id: string): Promise<void> {
  const current = await read($, selectedAtom)
  if (current !== id) await update($, selectedAtom, () => id)
  const { sessions } = await read($, listingAtom)
  const session = sessions.find(s => s.id === id)
  if (session) void loadGit($, session)
}

// ---------------------------------------------------------------------------
// Settings, kept across sessions.

async function loadSettings($: Engine): Promise<void> {
  const stored = (await $.store.get('settings').catch(() => undefined)) as Partial<Settings> | undefined
  await update($, settingsAtom, () => ({ ...DEFAULT_SETTINGS, ...(stored ?? {}) }))
}

async function changeSettings($: Engine, change: (old: Settings) => Settings): Promise<void> {
  await update($, settingsAtom, change)
  await $.store.set('settings', await read($, settingsAtom)).catch(() => undefined)
}

// The settings rows: each section, then the export folder.
const SETTING_ROWS = [...SECTIONS.map(s => s.key as string), 'exportDir']

async function pressSetting($: Engine, key: string): Promise<void> {
  if (key === 'exportDir') {
    await changeSettings($, old => {
      const at = EXPORT_DIRS.indexOf(old.exportDir)
      return { ...old, exportDir: EXPORT_DIRS[(at + 1) % EXPORT_DIRS.length]! }
    })
    return
  }
  await changeSettings($, old => ({ ...old, [key]: old[key as keyof Settings] === false }))
  const selected = await read($, selectedAtom)
  const session = (await read($, listingAtom)).sessions.find(s => s.id === selected)
  if (session) void loadGit($, session)
}

async function moveSetting($: Engine, delta: number): Promise<void> {
  await update($, settingsAtAtom, at => Math.max(0, Math.min(SETTING_ROWS.length - 1, at + (Number.isFinite(delta) ? delta : delta > 0 ? 99 : -99))))
  const at = await read($, settingsAtAtom)
  await $.ui.focus({ requestId: PANE, key: `setting:${SETTING_ROWS[at]}` }).catch(() => undefined)
}

async function togglePanel($: Engine, panel: Panel): Promise<void> {
  const current = await read($, panelAtom)
  await update($, panelAtom, () => (current === panel ? 'report' : panel))
  if (current !== panel && panel === 'settings') await moveSetting($, 0)
}

async function setListMode($: Engine, mode: ListMode): Promise<void> {
  await update($, listModeAtom, () => mode)
  await update($, panelAtom, () => 'report')
  if (mode === 'plans') {
    const name = await read($, selectedPlanAtom)
    await $.ui.focus({ requestId: PANE, key: `plan:${name}` }).catch(() => undefined)
    void loadPlanText($, name)
  } else {
    const id = await read($, selectedAtom)
    await $.ui.focus({ requestId: PANE, key: `session:${id}` }).catch(() => undefined)
  }
}

// ---------------------------------------------------------------------------
// Plans: their text, read on demand; copy, resume, export.

async function planText($: Engine, row: PlanRow): Promise<string> {
  const known = planTexts.get(row.name)
  if (known !== undefined) return known
  let text = row.exists && row.path !== '' ? await $.fs.read(row.path).catch(() => '') : ''
  if (text === '') {
    const { sessions } = await read($, listingAtom)
    for (const id of [row.origin, ...row.linked]) {
      const session = sessions.find(s => s.id === id)
      if (!session || session.transcript === '') continue
      text = planTextFrom(await $.fs.read(session.transcript).catch(() => ''), row.name)
      if (text !== '') break
    }
  }
  planTexts.set(row.name, text)
  return text
}

// Bumped when a plan's text arrives, so the report draws it.
const planTextAtom = atom({ plugin: 'super-resume', key: 'planTextAt' } as const, 0)
async function loadPlanText($: Engine, name: string): Promise<void> {
  const row = (await read($, listingAtom)).plans.find(plan => plan.name === name)
  if (!row || planTexts.has(name)) return
  await planText($, row)
  await update($, planTextAtom, n => n + 1)
}

async function selectPlan($: Engine, name: string): Promise<void> {
  await update($, selectedPlanAtom, () => name)
  void loadPlanText($, name)
}

/** The latest session of a plan: the one to resume to carry on with it. */
const latestOf = (row: PlanRow, sessions: SessionReport[]): SessionReport | undefined =>
  sessions
    .filter(s => s.id === row.origin || row.linked.includes(s.id))
    .sort((a, b) => b.endedAt.localeCompare(a.endedAt))[0]

async function copyPlan($: Engine, row: PlanRow, surface: RenderSurface): Promise<void> {
  const text = row.exists ? row.path : await planText($, row)
  const copied = await $.ui.copy({ text: text || row.path, surface })
  $.ui.toast(copied.isCopied ? (row.exists ? 'Plan path copied' : 'Plan file lost: its text copied') : 'Could not copy')
}

/**
 * Writes the plan into its project, `<cwd>/<exportDir>/<date>-<title>.md`,
 * under a header saying where it came from. Never overwrites: the same plan
 * already there is left alone, another file of that name gets a -2, -3.
 */
async function exportPlan($: Engine, row: PlanRow): Promise<void> {
  const { sessions } = await read($, listingAtom)
  const session = sessions.find(s => s.id === row.origin) ?? latestOf(row, sessions)
  const root = session?.cwd ?? (await $.session.root())
  // a removed worktree: writing would bring its folder back
  if (!(await $.fs.exists(root).catch(() => true))) {
    $.ui.toast('Project folder gone: c copies the plan instead')
    return
  }
  const text = await planText($, row)
  if (text === '') {
    $.ui.toast('No text found for this plan')
    return
  }
  const settings = await read($, settingsAtom)
  const dir = `${root.replace(/[\\/]+$/, '')}/${settings.exportDir}`
  const date = (row.at || new Date().toISOString()).slice(0, 10)
  const stem = `${date}-${slug(row.title)}`
  const header = [
    '<!-- Exported by Super Resume',
    `plan: ${row.title}`,
    `status: ${row.status}`,
    `source: ${row.path || row.name}`,
    `session: ${row.origin || '-'}`,
    `linked sessions: ${row.linked.join(', ') || '-'}`,
    '-->',
    '',
  ].join('\n')
  const entries = await $.fs.list(dir).catch(() => [])
  const names = new Set(entries.map(e => e.name))
  let name = `${stem}.md`
  for (let n = 2; names.has(name); n++) {
    const existing = await $.fs.read(`${dir}/${name}`).catch(() => '')
    if (existing.includes(text.trim())) {
      $.ui.toast(`Already exported: ${settings.exportDir}/${name}`)
      return
    }
    name = `${stem}-${n}.md`
  }
  await $.fs.write(`${dir}/${name}`, `${header}${text}`)
  const exported = { ...(await read($, exportsAtom)), [row.name]: `${settings.exportDir}/${name}` }
  await update($, exportsAtom, () => exported)
  await $.store.set('exports', exported).catch(() => undefined)
  $.ui.toast(`Plan exported to ${settings.exportDir}/${name}`)
}

// ---------------------------------------------------------------------------

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

// What the last drawing showed of the list, for the key hooks: which rows were
// on screen (the window), where the window starts, and the cells the list
// takes, to tell a wheel tick over the list from one over the report.
// Module state: a reload starts it over, and the next drawing fills it in.
const view = {
  ids: [] as string[],
  prefix: 'session:',
  start: 0,
  listColumns: 0,
  listRowEnd: 0,
  // The report's subject, its rows that fit, and the furthest it scrolls.
  reportId: '',
  reportSlots: 1,
  reportMax: 0,
}
// The element the focus ring last landed on in the pane.
let ringAt = ''

// Scroll the report by `delta` rows (±Infinity: top/bottom).
async function scrollReport($: Engine, delta: number): Promise<void> {
  await update($, reportTopAtom, at => {
    const from = at.id === view.reportId ? at.top : 0
    const top = Math.max(0, Math.min(view.reportMax, from + delta))
    return { id: view.reportId, top: Number.isFinite(top) ? top : 0 }
  })
}

// Move the selection by `delta` rows (±Infinity: first/last), and the focus
// ring with it so Enter acts on the row the ▶ points at.
async function move($: Engine, delta: number): Promise<void> {
  const mode = await read($, listModeAtom)
  const listing = await read($, listingAtom)
  const ids = mode === 'plans' ? listing.plans.map(p => p.name) : listing.sessions.map(s => s.id)
  if (ids.length === 0) return
  const selected = mode === 'plans' ? await read($, selectedPlanAtom) : await read($, selectedAtom)
  const from = Math.max(0, ids.indexOf(selected))
  const to = Math.min(ids.length - 1, Math.max(0, from + delta))
  const target = ids[to]
  if (target === undefined) return
  if (to !== from) {
    if (mode === 'plans') await selectPlan($, target)
    else await select($, target)
  }
  await $.ui.focus({ requestId: PANE, key: `${mode === 'plans' ? 'plan' : 'session'}:${target}` }).catch(() => undefined)
}

// A transcript path with the config folder written as ~/.claude, for display.
const homeShort = (path: string): string => path.replace(/^.*?([\\/])\.claude[\\/]/, '~$1.claude$1')

/**
 * What another conversation needs to find this one: its title, id and the
 * full transcript path, which Claude can read to pick up what was done there.
 */
const referenceOf = (session: SessionReport): string =>
  `Claude Code session "${session.title}" (id ${session.id}), project ${session.cwd}, transcript ${session.transcript}`

const copyReference = (
  $: Engine,
  session: SessionReport | undefined,
  surface: RenderSurface,
) => {
  if (!session) {
    $.ui.toast('No session here to reference')
    return
  }
  void $.ui
    .copy({ text: referenceOf(session), surface })
    .then(result => $.ui.toast(result.isCopied ? 'Session reference copied: paste it in another conversation' : 'Could not copy'))
}

const copyCommand = ($: Engine, session: SessionReport, surface: RenderSurface) =>
  void $.ui
    .copy({ text: `cd "${session.cwd}" && claude --resume ${session.id}`, surface })
    .then(result => $.ui.toast(result.isCopied ? 'Resume command copied' : 'Could not copy'))

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'super-resume',
      description: 'Browse past sessions with a report for each (args: branch | project | all | plans)',
    })
    return next(e)
  })

  on('command.run', { command: 'super-resume' }, async ($, e) => {
    const wanted = e.args.trim().toLowerCase()
    const scope = isScope(wanted) ? wanted : await read($, scopeAtom)
    await loadSettings($)
    await update($, listModeAtom, () => (wanted === 'plans' ? 'plans' : 'sessions'))
    await update($, panelAtom, () => 'report')
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
  // the list moves it a row; over the report it scrolls the report, as PgUp/PgDn do.
  // With the settings open, the arrows move over its rows.
  on('ui.scroll', { component: 'Pane', requestId: PANE }, async ($, e, next) => {
    if (e.origin.kind !== 'person') return next(e)
    let delta: number
    if (e.pointer) {
      const overList =
        e.pointer.column >= 0 &&
        e.pointer.column < view.listColumns &&
        e.pointer.row < view.listRowEnd
      if (!overList) {
        void scrollReport($, e.by)
        return {}
      }
      delta = Math.sign(e.by)
    } else if (Math.abs(e.by) === e.bodyRows) {
      // PgUp/PgDn page the report, leaving a row of the last page in view
      void scrollReport($, Math.sign(e.by) * Math.max(1, view.reportSlots - 1))
      return {}
    } else if (e.contentRows > 0 && Math.abs(e.by) >= e.contentRows) {
      delta = Math.sign(e.by) * Infinity
    } else {
      delta = e.by
    }
    if (delta === 0) return {}
    if (!e.pointer && (await read($, panelAtom)) === 'settings') void moveSetting($, delta)
    else void move($, delta)
    return {}
  })

  // Tab/arrows move the site's own focus ring over the Buttons without
  // calling their onPress (that's Enter/click), so follow the ring onto
  // whichever row it lands on: the ▶ and the report go with it. Leaving the
  // window's first or last row for a control outside the list while more rows
  // lie that way slides the window instead.
  on('ui.focus', { component: 'Pane', requestId: PANE }, async ($, e, next) => {
    const element = e.element ?? ''
    const prefix = view.prefix
    if (e.origin.kind === 'person' && ringAt.startsWith(prefix) && !element.startsWith(prefix)) {
      const from = ringAt.slice(prefix.length)
      const at = view.ids.indexOf(from)
      const listing = await read($, listingAtom)
      const ids = prefix === 'plan:' ? listing.plans.map(p => p.name) : listing.sessions.map(s => s.id)
      const index = ids.indexOf(from)
      const isAbove = element.startsWith('scope:')
      if (!element.startsWith('setting:')) {
        if (at === view.ids.length - 1 && !isAbove && index >= 0 && index < ids.length - 1) {
          void move($, 1)
          return {}
        }
        if (at === 0 && isAbove && index > 0) {
          void move($, -1)
          return {}
        }
      }
    }
    const result = await next(e)
    if (!result.deny) {
      ringAt = element
      if (element.startsWith('session:')) await select($, element.slice('session:'.length))
      if (element.startsWith('plan:')) await selectPlan($, element.slice('plan:'.length))
      if (element.startsWith('setting:')) {
        const at = SETTING_ROWS.indexOf(element.slice('setting:'.length))
        if (at >= 0) await update($, settingsAtAtom, () => at)
      }
    }
    return result
  }).catch(($, e, next) => next(e))

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const T = { Box, Text }
    const listing = await read($, listingAtom)
    const scope = await read($, scopeAtom)
    const selectedId = await read($, selectedAtom)
    const selectedPlanName = await read($, selectedPlanAtom)
    const reportTopAt = await read($, reportTopAtom)
    const settings = await read($, settingsAtom)
    const settingsAt = await read($, settingsAtAtom)
    const mode = await read($, listModeAtom)
    const panel = await read($, panelAtom)
    const gitAll = await read($, gitAtom)
    const exported = await read($, exportsAtom)
    await read($, planTextAtom) // redraw when a plan's text arrives
    const thisSession = await $.session.id()
    const now = Date.now()
    const columns = e.props.bodyColumns
    const bodyRows = e.props.scroll.bodyRows
    const show = (key: Parameters<typeof enabled>[1]) => enabled(settings, key)
    // Side by side when the pane spans the terminal (inline) and has room;
    // docked (45% at most) or narrow, the list sits above the report.
    const isSplit = e.props.placement === 'inline' && columns >= 80
    const sessions = listing.sessions
    const selectedIndex = Math.max(0, sessions.findIndex(session => session.id === selectedId))
    const selected = sessions[selectedIndex]
    const plans = listing.plans
    const planIndex = Math.max(0, plans.findIndex(plan => plan.name === selectedPlanName))
    const selectedPlan = plans[planIndex]
    const isPlans = mode === 'plans'
    const rowCount = isPlans ? plans.length : sessions.length
    const activeIndex = isPlans ? planIndex : selectedIndex

    // Rows: header 1 + a blank, a blank + footer 1, and in split each column's border 2 + its
    // heading 1 + a blank. Stacked: a hint row when docked, the list box, then the report.
    const hintRows = isSplit ? 0 : 1
    const boxRows = Math.max(8, bodyRows - 4 - hintRows)
    const listBoxRows = isSplit ? boxRows : Math.min(boxRows - 6, Math.max(6, Math.min(15, rowCount + 4)))
    const listSlots = Math.max(1, listBoxRows - 4)
    const reportBoxRows = isSplit ? boxRows : Math.max(6, boxRows - listBoxRows)

    const listOuter = isSplit ? Math.floor(columns / 2) : columns
    const reportOuter = isSplit ? columns - listOuter : columns
    const listInner = Math.max(10, listOuter - 4)
    const reportInner = Math.max(10, reportOuter - 4)

    // The window over the list: every row when they fit, else the rows that
    // fit with a line above and below saying how many are out of view, moved
    // the least that keeps the selected row showing.
    const overflows = rowCount > listSlots
    const slots = overflows ? Math.max(1, listSlots - 2) : listSlots
    const prefix = isPlans ? 'plan:' : 'session:'
    let start = view.prefix === prefix ? Math.min(view.start, Math.max(0, rowCount - slots)) : 0
    if (activeIndex < start) start = activeIndex
    if (activeIndex >= start + slots) start = activeIndex - slots + 1
    start = Math.max(0, start)
    const shownSessions = isPlans ? [] : sessions.slice(start, start + slots)
    const shownPlans = isPlans ? plans.slice(start, start + slots) : []
    view.ids = isPlans ? shownPlans.map(plan => plan.name) : shownSessions.map(session => session.id)
    view.prefix = prefix
    view.start = start
    view.listColumns = listOuter
    // Rows from the body's top through the list box's bottom.
    view.listRowEnd = 2 + hintRows + listBoxRows

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
          <Button
            key="mode:plans"
            hotkey="l"
            plain
            dimColor={!isPlans}
            onPress={() => void setListMode($, isPlans ? 'sessions' : 'plans')}
          >
            {isPlans ? <Text bold color="claude">● plans</Text> : <Text>plans</Text>}
          </Button>
        </Box>
        <Text dimColor>
          {listing.isLoading ? 'loading…' : isPlans ? `${plans.length} plans` : `${sessions.length} sessions`}
        </Text>
      </Box>
    )

    // A row: ▶, the title, its age, its grade, ◌ while work runs, • on this
    // session. The context bar is the report's alone: in every row it was noise.
    const showBadge = show('badge') && show('score')
    const titleWidth = Math.max(4, listInner - 2 - 5 - 2 - (showBadge ? 4 : 0))
    const row = (session: SessionReport) => {
      const isSelected = session.id === selected?.id
      return (
        <Button
          key={`session:${session.id}`}
          plain
          autoFocus={(!isPlans && isSelected && panel !== 'settings') || undefined}
          onPress={press => void choose($, session, press.surface)}
        >
          <Text color="claude">{isSelected ? '▶ ' : '  '}</Text>
          {session.parent !== '' && <Text dimColor>↳ </Text>}
          <Text bold={isSelected} color={isSelected ? 'claude' : undefined}>
            {fit(session.title, session.parent !== '' ? titleWidth - 2 : titleWidth)}
          </Text>
          <Text dimColor> {ago(session.endedAt, now).padStart(4)}</Text>
          {showBadge && <Text> </Text>}
          {showBadge && badge(T, scoreOf(session).grade)}
          <Text color="suggestion">{session.wip.open.length > 0 ? '◌' : ' '}{session.id === thisSession ? '•' : ' '}</Text>
        </Button>
      )
    }
    const planTitleWidth = Math.max(4, listInner - 2 - 2 - 5 - 3)
    const planRow = (plan: PlanRow) => {
      const isSelected = plan.name === selectedPlan?.name
      const sessionCount = (plan.origin !== '' ? 1 : 0) + plan.linked.length
      return (
        <Button
          key={`plan:${plan.name}`}
          plain
          autoFocus={(isPlans && isSelected && panel !== 'settings') || undefined}
          onPress={() => {
            const latest = latestOf(plan, sessions)
            if (latest) void choose($, latest, e.surface)
            else $.ui.toast('No listed session holds this plan: c copies it')
          }}
        >
          <Text color="claude">{isSelected ? '▶ ' : '  '}</Text>
          {planStatus(T, plan.status)}
          <Text bold={isSelected} color={isSelected ? 'claude' : plan.exists ? undefined : 'subtle'}>
            {fit(plan.title, planTitleWidth)}
          </Text>
          <Text dimColor> {ago(plan.at, now).padStart(4)}</Text>
          <Text dimColor>{String(sessionCount).padStart(3)}</Text>
        </Button>
      )
    }

    const above = start
    const below = rowCount - start - (isPlans ? shownPlans.length : shownSessions.length)
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
        <Text bold color="subtle">{isPlans ? 'Plans' : 'Sessions'}</Text>
        <Text> </Text>
        {rowCount === 0 && (
          <Text dimColor>
            {listing.error || (listing.isLoading ? 'Reading…' : isPlans ? 'No plans in this scope.' : 'No sessions.')}
          </Text>
        )}
        {overflows && <Text dimColor>{above > 0 ? `  ↑ ${above} more` : ' '}</Text>}
        {isPlans ? shownPlans.map(planRow) : shownSessions.map(row)}
        {overflows && <Text dimColor>{below > 0 ? `  ↓ ${below} more` : ' '}</Text>}
      </Box>
    )

    // Statusline-style: one-word labels, values set apart by a dim ` | `.
    const rule = <Text dimColor>{'─'.repeat(reportInner)}</Text>
    const SEP = <Text dimColor> | </Text>
    const heading = (text: string) => <Text bold color="subtle">{text}</Text>
    // `user  › ` / `agent › ` then the text, wrapped by hand to the column's
    // width (the terminal's own wrap under maxLines spilled over the rows
    // below), the lines after the first indented under it.
    const said = (who: string, color: string, text: string, lines: number, keep: 'start' | 'end') => {
      const prefix = `${who.padEnd(5)} › `
      const wrapped = wrapBlocks(text, reportInner - prefix.length, lines, keep)
      if (wrapped.length === 0) wrapped.push('—')
      return wrapped.map((line, i) => (
        <Text key={`${who}:${i}`} wrap="truncate-end">
          <Text color={color}>{i === 0 ? prefix : ' '.repeat(prefix.length)}</Text>
          {line}
        </Text>
      ))
    }
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
      const out = []
      if (session.parent !== '') {
        out.push(
          <Text key="tree:parent" wrap="truncate-end">
            <Text dimColor>↳ </Text>
            <Text>{nameOf(session.parent)}</Text>
            {parent ? (
              <Text>{SEP}<Text dimColor>{ago(parent.endedAt, now)} ago</Text></Text>
            ) : (
              <Text>{SEP}<Text dimColor>{short(session.parent)} gone</Text></Text>
            )}
          </Text>,
        )
      }
      if (chain.length > 1) {
        out.push(
          <Text key="tree:chain" wrap="truncate-end">
            <Text dimColor>Chain </Text>
            <Text dimColor>{chain.map(id => fit(nameOf(id), 20).trimEnd()).join(' › ')} › </Text>
            <Text>this</Text>
          </Text>,
        )
      }
      if (forks.length > 0) {
        out.push(
          <Text key="tree:forks" wrap="truncate-end">
            <Text dimColor>Forks </Text>
            <Text>{forks.length}</Text>
            {forks.slice(0, 3).map(([id, node]) => (
              <Text key={`fork:${id}`}>{SEP}<Text dimColor>{fit(node.title, 28).trimEnd()}</Text></Text>
            ))}
          </Text>,
        )
      }
      return out
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
    const blank = (key: string) => <Text key={key}> </Text>

    // The report as a list of one-row lines, so it scrolls a row at a time:
    // the wheel over it or j/k move it, and a dim line at either edge says
    // how many rows are out of view.
    const lines: ReturnType<typeof Text>[] = []
    let reportSubject = ''

    const sessionReport = (s: SessionReport) => {
      const git = gitAll[s.id]
      const ratio = s.contextTokens / s.contextWindow
      const cells = bar(ratio, 10)
      const atLeast = s.isPartial ? '≥' : ''
      lines.push(
        <Text key="title" bold color="claude" wrap="truncate-end">
          {s.parent !== '' && <Text dimColor>↳ </Text>}
          {s.title}
        </Text>,
        <Text key="meta" wrap="truncate-end">
          <Text>{lastPart(s.cwd)}</Text>
          {s.branch !== '' && <Text>{SEP}<Text color="merged">⎇ {s.branch}</Text></Text>}
          {s.model !== '' && <Text>{SEP}<Text color="suggestion">{modelName(s.model)}</Text></Text>}
          {s.effort !== '' && (
            <Text>{SEP}{effortMeter(T, s.effort)}</Text>
          )}
        </Text>,
        // what names this conversation from another one: its id and transcript (i copies both)
        <Text key="ref" wrap="truncate-end">
          <Text dimColor>id </Text>
          <Text color="suggestion">{s.id}</Text>
          <Text dimColor>  i copy reference</Text>
        </Text>,
        // the whole path, broken after a slash where it is too long for the column
        ...wrapPath(homeShort(s.transcript), reportInner, 3).map((part, i) => (
          <Text key={`path:${i}`} dimColor wrap="truncate-end">{part}</Text>
        )),
      )
      if (show('tree')) lines.push(...treeLines(s))
      if (show('score')) lines.push(healthLine(T, scoreOf(s), git))
      if (show('wip')) lines.push(...summaryLines(T, s, reportInner))
      lines.push(
        blank('b1'),
        <Text key="ctx" wrap="truncate-end">
          <Text dimColor>Ctx </Text>
          <Text color={levelColor(ratio)}>{cells.on}</Text>
          <Text dimColor>{cells.off}</Text>
          <Text> {Math.round(ratio * 100)}% </Text>
          <Text dimColor>{tokens(s.contextTokens)}</Text>
          {SEP}<Text dimColor>Turns </Text><Text>{atLeast}{s.turns}</Text>
          {SEP}<Text dimColor>Tools </Text><Text>{atLeast}{s.toolCalls}</Text>
          {SEP}<Text dimColor>Files </Text><Text>{s.files.length}</Text>
        </Text>,
      )
      if (show('tokens')) {
        lines.push(<Box key="tokens">{tokenLine('Tokens', s.usage, s.isPartial)}</Box>)
        if (s.agents.count > 0) {
          lines.push(
            <Box key="agents">
              {tokenLine(`Agents ${s.agents.count}`, s.agents.usage, s.agents.isPartial, 'Tokens ')}
            </Box>,
          )
        }
      }
      lines.push(
        <Text key="time" wrap="truncate-end">
          <Text dimColor>Started </Text><Text>{ago(s.startedAt, now)} ago</Text>
          {SEP}<Text dimColor>Ended </Text><Text>{ago(s.endedAt, now)} ago</Text>
          {SEP}<Text dimColor>{s.activeMs > 0 ? 'Active ' : 'Ran '}</Text><Text>{activeLabel(s)}</Text>
        </Text>,
      )
      if (show('charts')) lines.push(...chartLines(T, s, reportInner))
      lines.push(blank('b2'), <Box key="rule">{rule}</Box>)
      if (show('conversation')) {
        lines.push(
          blank('b3'),
          <Box key="h:last">{heading('Last')}</Box>,
          ...said('user', 'suggestion', s.lastPrompt, 6, 'start'),
          blank('b4'),
          ...said('agent', 'claude', s.lastReply, 12, 'end'),
        )
        if (s.firstPrompt !== '' && s.firstPrompt !== s.lastPrompt) {
          lines.push(
            blank('b5'),
            <Box key="h:first">{heading('First')}</Box>,
            ...wrapBlocks(s.firstPrompt, reportInner, 4).map((text, i) => (
              <Text key={`first:${i}`} dimColor wrap="truncate-end">{text}</Text>
            )),
          )
        }
      }
      if (show('quality')) lines.push(...qualityLines(T, s, reportInner))
      if (show('agents')) lines.push(...agentLines(T, s, reportInner))
      if (show('wip')) lines.push(...openLines(T, s, reportInner))
      if (show('todos')) lines.push(...todoLines(T, s, reportInner, show('todoHint')))
      if (show('plans')) lines.push(...planLines(T, s, plans, reportInner))
      if (show('uncommitted')) lines.push(...uncommittedLines(T, s, git))
      if (show('files') && s.files.length > 0) {
        lines.push(
          blank('b6'),
          <Box key="h:diff">{heading('Diff')}</Box>,
          <Text key="diff" wrap="truncate-end">
            {plusMinus(s.added, s.removed)}
            <Text dimColor>  {s.files.length} {s.files.length === 1 ? 'file' : 'files'}</Text>
          </Text>,
          blank('b7'),
          <Box key="h:files">{heading('Files')}</Box>,
          ...s.files.slice(0, 30).map(file => {
            const counts = `+${file.added} -${file.removed}  `
            const dirty = isDirty(git, file.path, '')
            return (
              <Text key={`file:${file.path}`} wrap="truncate-end">
                {plusMinus(file.added, file.removed)}
                <Text dimColor>  {fitStart(relative(file.path, s.cwd), reportInner - counts.length - (dirty ? 2 : 0))}</Text>
                {dirty && <Text color="warning"> ●</Text>}
              </Text>
            )
          }),
        )
        if (s.files.length > 30) {
          lines.push(<Text key="files:more" dimColor>+{s.files.length - 30} more</Text>)
        }
      }
    }

    const planReport = (p: PlanRow) => {
      const origin = sessions.find(s => s.id === p.origin)
      const text = planTexts.get(p.name)
      lines.push(
        <Text key="plan:title" bold color="claude" wrap="truncate-end">{p.title}</Text>,
        <Text key="plan:status" wrap="truncate-end">
          {planStatus(T, p.status)}
          <Text>{p.status === 'file' ? 'plan file, no listed session wrote it' : p.status}</Text>
          {p.revisions > 0 && <Text dimColor> | revised {p.revisions}x</Text>}
          {SEP}<Text dimColor>{ago(p.at, now)} ago</Text>
          {p.isPartial && <Text dimColor> | partial read</Text>}
        </Text>,
        <Text key="plan:path" wrap="truncate-end">
          <Text color={p.exists ? 'subtle' : 'warning'}>{p.exists ? 'File ' : 'Lost '}</Text>
          <Text dimColor>{fitStart(p.path || p.name, reportInner - 5)}</Text>
        </Text>,
      )
      if (exported[p.name]) {
        lines.push(
          <Text key="plan:exported" wrap="truncate-end">
            <Text color="success">Exported </Text>
            <Text dimColor>{exported[p.name]}</Text>
          </Text>,
        )
      }
      lines.push(blank('p1'), <Box key="plan:h:sessions">{heading('Sessions')}</Box>)
      if (origin) {
        lines.push(
          <Text key="plan:origin" wrap="truncate-end">
            <Text dimColor>wrote  </Text>
            <Text>{fit(origin.title, reportInner - 14).trimEnd()}</Text>
            <Text dimColor> {ago(origin.endedAt, now)}</Text>
          </Text>,
        )
      }
      for (const id of p.linked.slice(0, 6)) {
        const s = sessions.find(x => x.id === id)
        lines.push(
          <Text key={`plan:linked:${id}`} wrap="truncate-end">
            <Text dimColor>named  </Text>
            <Text>{fit(s?.title ?? id.slice(0, 8), reportInner - 14).trimEnd()}</Text>
            {s && <Text dimColor> {ago(s.endedAt, now)}</Text>}
          </Text>,
        )
      }
      if (!origin && p.linked.length === 0) {
        lines.push(<Text key="plan:none" dimColor>no listed session; try the all scope</Text>)
      }
      if (p.files.length > 0) {
        const cells = bar(p.touched.length / p.files.length, 12)
        lines.push(
          blank('p2'),
          <Box key="plan:h:files">{heading('Files it names')}</Box>,
          <Text key="plan:touched" wrap="truncate-end">
            <Text color="claude">{cells.on}</Text>
            <Text dimColor>{cells.off}</Text>
            <Text> {p.touched.length}/{p.files.length} touched</Text>
          </Text>,
          ...p.files.slice(0, 20).map(file => {
            const isTouched = p.touched.includes(file)
            return (
              <Text key={`plan:file:${file}`} wrap="truncate-end">
                <Text color={isTouched ? 'success' : 'subtle'}>{isTouched ? '✓ ' : '□ '}</Text>
                <Text dimColor={!isTouched}>{fitStart(file, reportInner - 2)}</Text>
              </Text>
            )
          }),
        )
      }
      lines.push(blank('p3'), <Box key="plan:h:text">{heading('Plan')}</Box>)
      if (text === undefined) lines.push(<Text key="plan:loading" dimColor>reading…</Text>)
      else if (text === '') lines.push(<Text key="plan:empty" dimColor>no text found</Text>)
      else {
        text
          .split('\n')
          .slice(0, 60)
          .flatMap(line => (line.trim() === '' ? [''] : wrapText(line, reportInner, 3)))
          .slice(0, 40)
          .forEach((line, i) =>
            lines.push(<Text key={`plan:text:${i}`} dimColor={!/^#/.test(line)} wrap="truncate-end">{line || ' '}</Text>),
          )
      }
      lines.push(blank('p4'), <Text key="plan:keys" dimColor>Enter resume · c copy · e export to {settings.exportDir}/</Text>)
    }

    if (panel === 'help') {
      reportSubject = 'help'
      lines.push(...helpLines(T, reportInner))
    } else if (panel === 'settings') {
      reportSubject = 'settings'
      lines.push(
        <Text key="settings:title" bold color="claude">Settings</Text>,
        <Text key="settings:hint" dimColor wrap="truncate-end">↑↓ move · Enter toggle · s back. Kept across sessions.</Text>,
        blank('s1'),
      )
      SETTING_ROWS.forEach((key, i) => {
        const isAt = i === settingsAt
        const section = SECTIONS.find(s => s.key === key)
        const isOn = key === 'exportDir' ? true : settings[key as keyof Settings] !== false
        lines.push(
          <Button
            key={`setting:${key}`}
            plain
            autoFocus={isAt || undefined}
            onPress={() => void pressSetting($, key)}
          >
            <Text color="claude">{isAt ? '▶ ' : '  '}</Text>
            {key === 'exportDir' ? (
              <Text>
                <Text>{fit('Export to', 14)}</Text>
                <Text color="suggestion">{settings.exportDir}/</Text>
                <Text dimColor>
                  {fit(`  Enter cycles: ${EXPORT_DIRS.join(', ')}`, Math.max(0, reportInner - 2 - 14 - settings.exportDir.length - 1)).trimEnd()}
                </Text>
              </Text>
            ) : (
              <Text>
                <Text color={isOn ? 'success' : 'subtle'}>{isOn ? '● ' : '○ '}</Text>
                <Text bold={isAt}>{fit(section?.label ?? key, 14)}</Text>
                <Text dimColor>{fit(section?.about ?? '', Math.max(4, reportInner - 18)).trimEnd()}</Text>
              </Text>
            )}
          </Button>,
        )
      })
    } else if (isPlans) {
      reportSubject = selectedPlan ? `plan:${selectedPlan.name}` : ''
      if (selectedPlan) planReport(selectedPlan)
      else lines.push(<Text key="none" dimColor>No plan selected.</Text>)
    } else {
      reportSubject = selected?.id ?? ''
      if (selected) sessionReport(selected)
      else lines.push(<Text key="none" dimColor>No session selected.</Text>)
    }

    // Rows inside the border; when the report is taller, the edge rows give
    // way to the ↑/↓ counts.
    const reportRows = Math.max(1, reportBoxRows - 2)
    const reportFits = lines.length <= reportRows
    const reportSlots = reportFits ? reportRows : Math.max(1, reportRows - 2)
    const reportMax = Math.max(0, lines.length - reportSlots)
    let reportTop = reportTopAt.id === reportSubject ? Math.min(reportTopAt.top, reportMax) : 0
    // the settings cursor stays in view
    if (panel === 'settings' && !reportFits) {
      const at = 3 + settingsAt
      if (at < reportTop) reportTop = at
      if (at >= reportTop + reportSlots) reportTop = at - reportSlots + 1
    }
    view.reportId = reportSubject
    view.reportSlots = reportSlots
    view.reportMax = reportMax
    const reportAbove = reportTop
    const reportBelow = lines.length - reportTop - reportSlots

    const report = (
      <Box
        flexDirection="column"
        width={reportOuter}
        height={reportBoxRows}
        borderStyle="round"
        borderColor={panel === 'report' ? 'subtle' : 'claude'}
        paddingX={1}
        overflow="hidden"
      >
        {!reportFits && (
          <Text dimColor>{reportAbove > 0 ? `↑ ${reportAbove} more · PgUp` : ' '}</Text>
        )}
        {reportFits ? lines : lines.slice(reportTop, reportTop + reportSlots)}
        {!reportFits && (
          <Text dimColor>{reportBelow > 0 ? `↓ ${reportBelow} more · PgDn` : ' '}</Text>
        )}
      </Box>
    )

    const footer = (
      <Box flexDirection="row" gap={2}>
        <Text dimColor wrap="truncate-end">
          {isSplit ? '↑↓ move · Home/End · PgUp/PgDn report · Enter resume' : '↑↓ move · PgUp/PgDn · Enter'}
        </Text>
        <Button
          key="copy-resume"
          hotkey="c"
          plain
          dimColor
          onPress={press => {
            if (isPlans) {
              if (selectedPlan) void copyPlan($, selectedPlan, press.surface)
            } else if (selected) copyCommand($, selected, press.surface)
          }}
        >
          copy
        </Button>
        <Button
          key="copy-reference"
          hotkey="i"
          plain
          dimColor
          onPress={press => {
            const session = isPlans && selectedPlan ? latestOf(selectedPlan, sessions) : selected
            copyReference($, session, press.surface)
          }}
        >
          ref
        </Button>
        <Button
          key="export-plan"
          hotkey="e"
          plain
          dimColor
          onPress={() => {
            const plan = isPlans ? selectedPlan : plans.find(p => p.origin === selected?.id)
            if (plan) void exportPlan($, plan)
            else $.ui.toast('No plan to export here')
          }}
        >
          export
        </Button>
        <Button
          key="refresh"
          hotkey="r"
          plain
          dimColor
          onPress={() => {
            planTexts.clear()
            void update($, gitAtom, () => ({})).then(() => load($, scope))
          }}
        >
          refresh
        </Button>
        <Button key="settings" hotkey="s" plain dimColor={panel !== 'settings'} onPress={() => void togglePanel($, 'settings')}>
          settings
        </Button>
        <Button key="help" hotkey="h" plain dimColor={panel !== 'help'} onPress={() => void togglePanel($, 'help')}>
          help
        </Button>
        <Text dimColor>Esc close</Text>
      </Box>
    )

    return (
      <Box flexDirection="column">
        <Box marginBottom={1}>{header}</Box>
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
        <Box marginTop={1}>{footer}</Box>
      </Box>
    )
  })
}
