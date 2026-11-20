import type { ElementTable } from 'claude-code'

import type { GitInfo, PlanRow, SectionKey, SessionReport, Settings } from '../types'
import { EFFORTS, SCORE, bar, distributionBar, duration, fit, fitStart, gradeOf, relativeTo, scoreOf, spark, stackBar, wrapText } from './parse'
import type { Score } from './parse'

// The report's sections, each a list of one-row lines (so the report scrolls a
// row at a time), drawn from the elements of the surface and a column width.

type Els = Pick<ElementTable, 'Text' | 'Box'>
type El = ReturnType<Els['Text']>

export const SECTIONS: { key: SectionKey; label: string; about: string }[] = [
  { key: 'score', label: 'Score', about: 'grade and sub-scores under the title' },
  { key: 'badge', label: 'List grade', about: 'each session row shows its grade' },
  { key: 'charts', label: 'Charts', about: 'activity and effort charts' },
  { key: 'conversation', label: 'Conversation', about: 'last and first prompt, last reply' },
  { key: 'quality', label: 'Quality', about: 'rejections, interrupts, errors, compactions' },
  { key: 'agents', label: 'Agents', about: 'subagents by type, background work' },
  { key: 'wip', label: 'WIP', about: 'the session recap and work still running' },
  { key: 'todos', label: 'Todos', about: 'the todo or task list it kept' },
  { key: 'todoHint', label: 'Todo hint', about: 'nudge to use tasks on long sessions' },
  { key: 'plans', label: 'Plans', about: 'plans it wrote and their status' },
  { key: 'uncommitted', label: 'Uncommitted', about: 'git: its files still not committed' },
  { key: 'tokens', label: 'Tokens', about: 'tokens in, out, cached; subagents' },
  { key: 'files', label: 'Files', about: 'diff and files edited' },
  { key: 'tree', label: 'Tree', about: 'fork parent, chain and forks' },
]

export const EXPORT_DIRS = ['docs/plans', 'plans', 'docs']

export const DEFAULT_SETTINGS: Settings = {
  score: true,
  badge: true,
  charts: true,
  conversation: true,
  quality: true,
  agents: true,
  wip: true,
  todos: true,
  todoHint: true,
  plans: true,
  uncommitted: true,
  tokens: true,
  files: true,
  tree: true,
  exportDir: EXPORT_DIRS[0]!,
}

const gradeColor = (grade: string): string =>
  grade === 'A' || grade === 'B'
    ? 'success'
    : grade === 'C' || grade === '?'
      ? 'warning'
      : grade === '—'
        ? 'subtle'
        : 'error'

const num = (n: number | undefined, partial: boolean) => (n === undefined ? '—' : `${partial ? '≥' : ''}${n}`)

/** Of the session files inside the repository, the share some commit since it started touched. */
export const deliveryOf = (git: GitInfo | undefined): number | undefined =>
  git?.state === 'ok' && git.total > 0 ? Math.round((100 * git.committed) / git.total) : undefined

/** ` B ` in the grade's color, inverse: three cells. */
export const badge = (T: Els, grade: string, key?: string) => (
  <T.Text key={key} inverse color={gradeColor(grade)}>{` ${grade} `}</T.Text>
)

export const healthLine = (T: Els, score: Score, git: GitInfo | undefined): El => {
  const SEP = <T.Text dimColor> | </T.Text>
  const delivery = deliveryOf(git)
  const sub = (label: string, value: number | undefined) => (
    <T.Text>
      <T.Text dimColor>{label} </T.Text>
      <T.Text color={value === undefined ? 'subtle' : gradeColor(gradeOf(value))}>{num(value, score.isPartial)}</T.Text>
    </T.Text>
  )
  return (
    <T.Text key="health" wrap="truncate-end">
      {badge(T, score.grade)}
      {score.overall === undefined ? (
        <T.Text color={score.grade === '?' ? 'warning' : 'subtle'}> {score.reason ?? 'no score'}</T.Text>
      ) : (
        <T.Text bold> {score.isNewer ? '~' : ''}{num(score.overall, score.isPartial)}</T.Text>
      )}
      {score.overall !== undefined && (
        <T.Text>
          <T.Text>  </T.Text>
          {sub('Flow', score.flow)}{SEP}{sub('Auton', score.autonomy)}{SEP}{sub('Deleg', score.delegation)}
        </T.Text>
      )}
      {delivery !== undefined && <T.Text>{SEP}{sub('Deliv', delivery)}</T.Text>}
      <T.Text dimColor>  h help</T.Text>
    </T.Text>
  )
}

export const summaryLines = (T: Els, report: SessionReport, width: number): El[] => {
  if (report.wip.summary === '') return []
  const prefix = 'WIP › '
  return wrapText(report.wip.summary, width - prefix.length, 2).map((text, i) => (
    <T.Text key={`recap:${i}`} wrap="truncate-end">
      <T.Text color="suggestion">{i === 0 ? prefix : ' '.repeat(prefix.length)}</T.Text>
      <T.Text italic>{text}</T.Text>
    </T.Text>
  ))
}

/** A colour per effort level, low to max. */
export const EFFORT_COLOR: Record<string, string> = {
  low: 'subtle',
  medium: 'suggestion',
  high: 'claude',
  xhigh: 'warning',
  max: 'error',
}

/** The five effort steps as a meter, the spark's glyphs low to max. */
export const EFFORT_METER = ['▁', '▃', '▅', '▆', '█']

/**
 * The main agent's effort now, its last reply, as the /effort picker shows
 * it: the whole scale low to max, `effort ▁▃▅▆█ high`, only the step it is on
 * lit (in the level's colour, bold), the others dim. A snapshot, like the
 * model beside it: what a resume picks up, not how the session went (the
 * Effort chart says that). Subagents never count: their lines are apart.
 */
export const effortMeter = (T: Els, effort: string): El => {
  const at = EFFORTS.indexOf(effort as (typeof EFFORTS)[number])
  const color = EFFORT_COLOR[effort] ?? 'subtle'
  return (
    <T.Text key="effort:meter">
      <T.Text dimColor>effort </T.Text>
      {at >= 0 &&
        EFFORT_METER.map((step, i) =>
          i === at ? (
            <T.Text key={String(i)} bold color={color}>{step}</T.Text>
          ) : (
            <T.Text key={String(i)} dimColor>{step}</T.Text>
          ),
        )}
      <T.Text color={color}>{at >= 0 ? ' ' : ''}{effort}</T.Text>
    </T.Text>
  )
}

/**
 * How the main agent's replies spread over the effort levels: one bar of fixed
 * width, a segment per level in its colour (low to max, left to right), sized
 * by its share of every reply, then each level's share. One line however long
 * the session: it is the distribution, not a timeline.
 */
export const effortLines = (T: Els, report: SessionReport, width: number): El[] => {
  const mix = report.effortMix ?? {}
  const total = Object.values(mix).reduce((a, b) => a + b, 0)
  if (total === 0) return []
  const present = EFFORTS.filter(e => (mix[e] ?? 0) > 0)
  const shares = present.map(e => `${e} ${Math.round((100 * (mix[e] ?? 0)) / total)}%`)
  const label = 'Effort   '
  const legend = shares.join(' | ').length
  const cells = distributionBar(
    present.map(e => mix[e] ?? 0),
    Math.max(6, Math.min(24, width - label.length - 2 - legend)),
  )
  return [
    <T.Text key="effort:mix" wrap="truncate-end">
      <T.Text dimColor>{label}</T.Text>
      {present.map((e, i) => (
        <T.Text key={`bar:${e}`} color={EFFORT_COLOR[e]}>{'█'.repeat(cells[i] ?? 0)}</T.Text>
      ))}
      <T.Text>  </T.Text>
      {present.map((e, i) => (
        <T.Text key={e}>
          {i > 0 && <T.Text dimColor> | </T.Text>}
          <T.Text color={EFFORT_COLOR[e]}>{e} </T.Text>
          <T.Text dimColor>{shares[i]!.slice(e.length + 1)}</T.Text>
        </T.Text>
      ))}
    </T.Text>,
  ]
}

export const chartLines = (T: Els, report: SessionReport, width: number): El[] => {
  const { activity } = report.series
  const effort = effortLines(T, report, width)
  if (activity.length < 2) return effort
  return [
    <T.Text key="charts" wrap="truncate-end">
      <T.Text dimColor>Activity </T.Text>
      <T.Text color="claude">{spark(activity, Math.max(6, width - 9))}</T.Text>
    </T.Text>,
    ...effort,
  ]
}

const heading = (T: Els, key: string, text: string) => (
  <T.Text key={`h:${key}`} bold color="subtle">{text}</T.Text>
)
const blank = (T: Els, key: string) => <T.Text key={`b:${key}`}> </T.Text>

/** Parts joined by a dim ` | `, the empty ones left out. */
const joined = (T: Els, parts: (El | false)[]) => {
  const shown = parts.filter((p): p is El => p !== false)
  return shown.map((part, i) => (
    <T.Text key={String(i)}>
      {i > 0 && <T.Text dimColor> | </T.Text>}
      {part}
    </T.Text>
  ))
}

export const qualityLines = (T: Els, report: SessionReport, width: number): El[] => {
  const q = report.quality
  const atLeast = report.isPartial ? '≥' : ''
  const count = (n: number, glyph: string, color: string, label: string) =>
    n > 0 && (
      <T.Text>
        <T.Text color={color}>{glyph} </T.Text>
        <T.Text>{atLeast}{n}</T.Text>
        <T.Text dimColor> {label}</T.Text>
      </T.Text>
    )
  const isSmooth = q.rejected + q.interrupts + q.toolErrors + q.plansRejected === 0
  const out: El[] = [blank(T, 'quality'), heading(T, 'quality', 'Quality')]
  out.push(
    <T.Text key="quality" wrap="truncate-end">
      {isSmooth && <T.Text color="success">✓ no rejections, interrupts or errors</T.Text>}
      {isSmooth && (q.plansRevised + q.clarified + q.compactions > 0) && <T.Text dimColor> | </T.Text>}
      {joined(T, [
        count(q.rejected, '✗', 'error', q.rejectedWithFeedback > 0 ? `rejected (${q.rejectedWithFeedback} with feedback)` : 'rejected'),
        count(q.plansRejected, '✗', 'error', 'plans rejected'),
        count(q.interrupts, '◌', 'warning', 'interrupts'),
        count(q.toolErrors, '!', 'warning', 'tool errors'),
        count(q.plansRevised, '◐', 'suggestion', 'plan revisions'),
        count(q.clarified, '?', 'suggestion', 'clarified'),
        count(q.compactions, '○', 'subtle', q.compactions === 1 ? 'compaction' : 'compactions'),
      ])}
    </T.Text>,
  )
  if (q.lastFeedback !== '') {
    const prefix = 'feedback › '
    wrapText(q.lastFeedback, width - prefix.length, 2).forEach((text, i) =>
      out.push(
        <T.Text key={`feedback:${i}`} wrap="truncate-end">
          <T.Text color="warning">{i === 0 ? prefix : ' '.repeat(prefix.length)}</T.Text>
          <T.Text dimColor>{text}</T.Text>
        </T.Text>,
      ),
    )
  }
  return out
}

const PALETTE = ['claude', 'suggestion', 'merged', 'success', 'warning', 'remember']

export const agentLines = (T: Els, report: SessionReport, width: number): El[] => {
  const d = report.delegation
  const types = Object.entries(d.agents).sort((a, b) => b[1] - a[1])
  const hasAny = types.length + d.background + d.messages + d.skills + report.agents.count > 0
  if (!hasAny) return []
  const out: El[] = [blank(T, 'agents'), heading(T, 'agents', 'Agents')]
  if (types.length > 0) {
    // one bar for every subagent started, a colour per type, and the legend under it
    const total = types.reduce((a, [, n]) => a + n, 0)
    const cells = stackBar(types.map(([, n]) => n), Math.min(30, Math.max(8, width - 20)))
    out.push(
      <T.Text key="agents:bar" wrap="truncate-end">
        {types.map(([type, n], i) => (
          <T.Text key={type} color={PALETTE[i % PALETTE.length]}>{'█'.repeat(cells[i] ?? 0)}</T.Text>
        ))}
        <T.Text> {total} started</T.Text>
      </T.Text>,
      <T.Text key="agents:legend" wrap="truncate-end">
        {types.slice(0, 6).map(([type, n], i) => (
          <T.Text key={type}>
            {i > 0 && <T.Text dimColor> | </T.Text>}
            <T.Text color={PALETTE[i % PALETTE.length]}>■ </T.Text>
            <T.Text>{fit(type.replace(/^.*:/, ''), 18).trimEnd()} </T.Text>
            <T.Text dimColor>{n}</T.Text>
          </T.Text>
        ))}
      </T.Text>,
    )
  }
  const agentTokens = report.agents.usage.input + report.agents.usage.output
  const ownTokens = report.usage.input + report.usage.output
  const share = agentTokens + ownTokens > 0 ? Math.round((100 * agentTokens) / (agentTokens + ownTokens)) : 0
  out.push(
    <T.Text key="agents:work" wrap="truncate-end">
      {joined(T, [
        d.background > 0 && (
          <T.Text>
            <T.Text dimColor>Background </T.Text>
            <T.Text>{d.background}</T.Text>
            {d.completed > 0 && <T.Text color="success"> ✓{d.completed}</T.Text>}
            {d.failed > 0 && <T.Text color="error"> ✗{d.failed}</T.Text>}
            {d.killed > 0 && <T.Text color="warning"> ■{d.killed}</T.Text>}
            {report.wip.open.length > 0 && <T.Text color="suggestion"> ◌{report.wip.open.length}</T.Text>}
          </T.Text>
        ),
        report.agents.maxDepth > 1 && (
          <T.Text><T.Text dimColor>Depth </T.Text><T.Text>{report.agents.maxDepth}</T.Text></T.Text>
        ),
        d.messages > 0 && <T.Text><T.Text dimColor>Messages </T.Text><T.Text>{d.messages}</T.Text></T.Text>,
        d.skills > 0 && <T.Text><T.Text dimColor>Skills </T.Text><T.Text>{d.skills}</T.Text></T.Text>,
        report.agents.count > 0 && (
          <T.Text><T.Text dimColor>Agent tokens </T.Text><T.Text>{share}%</T.Text></T.Text>
        ),
      ])}
    </T.Text>,
  )
  return out
}

export const openLines = (T: Els, report: SessionReport, width: number): El[] => {
  const open = report.wip.open
  if (open.length === 0) return []
  return [
    blank(T, 'open'),
    heading(T, 'open', 'Running'),
    ...open.slice(0, 6).map(work => (
      <T.Text key={`open:${work.id}`} wrap="truncate-end">
        <T.Text color="suggestion">◌ </T.Text>
        <T.Text dimColor>{work.kind === 'agent' ? 'agent   ' : 'command '}</T.Text>
        <T.Text>{fit(work.label, Math.max(8, width - 12)).trimEnd()}</T.Text>
      </T.Text>
    )),
    ...(open.length > 6 ? [<T.Text key="open:more" dimColor>+{open.length - 6} more</T.Text>] : []),
  ]
}

const TODO_GLYPH = { completed: '✓', in_progress: '◐', pending: '□' } as const

export const todoLines = (T: Els, report: SessionReport, width: number, showHint: boolean): El[] => {
  const todos = report.wip.todos
  if (todos.length === 0) {
    const isLong = report.turns >= 15 || report.activeMs >= 30 * 60_000
    if (!showHint || !isLong) return []
    return [
      blank(T, 'todos'),
      heading(T, 'todos', 'Todos'),
      <T.Text key="todos:hint" dimColor wrap="truncate-end">
        No todos or tasks. Long work? Ask Claude to track it with tasks.
      </T.Text>,
    ]
  }
  const done = todos.filter(t => t.status === 'completed').length
  const cells = bar(done / todos.length, 12)
  const out: El[] = [
    blank(T, 'todos'),
    heading(T, 'todos', report.wip.todoSource === 'tasks' ? 'Tasks' : 'Todos'),
    <T.Text key="todos:bar" wrap="truncate-end">
      <T.Text color="success">{cells.on}</T.Text>
      <T.Text dimColor>{cells.off}</T.Text>
      <T.Text> {done}/{todos.length} done</T.Text>
    </T.Text>,
  ]
  // the ones not done first, in their order
  const ordered = [...todos.filter(t => t.status !== 'completed'), ...todos.filter(t => t.status === 'completed')]
  for (const todo of ordered.slice(0, 12)) {
    const blocked = todo.blockedBy.length > 0 && todo.status !== 'completed'
    out.push(
      <T.Text key={`todo:${todo.id}`} wrap="truncate-end">
        <T.Text color={todo.status === 'completed' ? 'success' : todo.status === 'in_progress' ? 'claude' : 'subtle'}>
          {TODO_GLYPH[todo.status]}{' '}
        </T.Text>
        <T.Text dimColor={todo.status === 'completed'} bold={todo.status === 'in_progress'}>
          {fit(todo.text, Math.max(8, width - 2 - (blocked ? 10 : 0))).trimEnd()}
        </T.Text>
        {blocked && <T.Text color="warning"> (blocked)</T.Text>}
      </T.Text>,
    )
  }
  if (ordered.length > 12) out.push(<T.Text key="todos:more" dimColor>+{ordered.length - 12} more</T.Text>)
  return out
}

const PLAN_GLYPH = { approved: '✓', revised: '◐', rejected: '✗', file: '○' } as const
const PLAN_COLOR = { approved: 'success', revised: 'suggestion', rejected: 'error', file: 'subtle' } as const

export const planStatus = (T: Els, status: PlanRow['status']) => (
  <T.Text color={PLAN_COLOR[status]}>{PLAN_GLYPH[status]} </T.Text>
)

export const planLines = (T: Els, report: SessionReport, rows: PlanRow[], width: number): El[] => {
  if (report.plans.length === 0) return []
  const byName = new Map(rows.map(row => [row.name, row]))
  const out: El[] = [blank(T, 'plans'), heading(T, 'plans', 'Plans')]
  for (const plan of report.plans.slice(0, 6)) {
    const row = byName.get(plan.name)
    out.push(
      <T.Text key={`plan:${plan.name}`} wrap="truncate-end">
        {planStatus(T, plan.status)}
        <T.Text>{fit(plan.title, Math.max(10, width - 30)).trimEnd()}</T.Text>
        {plan.revisions > 0 && <T.Text dimColor> | revised {plan.revisions}x</T.Text>}
        {row && row.linked.length > 0 && <T.Text dimColor> | in {row.linked.length + 1} sessions</T.Text>}
        {row && !row.exists && <T.Text color="warning"> | file lost</T.Text>}
      </T.Text>,
    )
    if (row && row.files.length > 0) {
      const cells = bar(row.touched.length / row.files.length, 10)
      out.push(
        <T.Text key={`plan:${plan.name}:files`} wrap="truncate-end">
          <T.Text>  </T.Text>
          <T.Text color="claude">{cells.on}</T.Text>
          <T.Text dimColor>{cells.off}</T.Text>
          <T.Text> {row.touched.length}/{row.files.length} files touched</T.Text>
          <T.Text dimColor>  {fitStart(plan.name, Math.max(8, width - 36))}</T.Text>
        </T.Text>,
      )
    }
  }
  out.push(<T.Text key="plans:hint" dimColor>l plans view · e export</T.Text>)
  return out
}

export const uncommittedLines = (T: Els, report: SessionReport, git: GitInfo | undefined): El[] => {
  if (report.files.length === 0 && report.commits === 0) return []
  const out: El[] = [blank(T, 'git'), heading(T, 'git', 'Uncommitted')]
  const line = (key: string, body: El | El[]) => <T.Text key={`git:${key}`} wrap="truncate-end">{body}</T.Text>
  if (!git || git.state === 'loading') out.push(line('state', <T.Text dimColor>checking git…</T.Text>))
  else if (git.state === 'gone') out.push(line('state', <T.Text color="warning">folder gone (a removed worktree?)</T.Text>))
  else if (git.state === 'no-repo') out.push(line('state', <T.Text dimColor>not a git repository</T.Text>))
  else if (git.state === 'error') out.push(line('state', <T.Text color="warning">git did not answer</T.Text>))
  else if (git.total === 0) out.push(line('state', <T.Text dimColor>no files of this repository edited</T.Text>))
  else {
    const isClean = git.dirty.length === 0
    out.push(
      line(
        'dirty',
        isClean ? (
          <T.Text color="success">✓ nothing left uncommitted</T.Text>
        ) : (
          <T.Text>
            <T.Text color="success">+{git.added}</T.Text>
            <T.Text> </T.Text>
            <T.Text color="error">-{git.removed}</T.Text>
            <T.Text> in {git.dirty.length} of {git.total} files</T.Text>
            {git.untracked > 0 && <T.Text dimColor> | {git.untracked} untracked</T.Text>}
          </T.Text>
        ),
      ),
    )
    const ratio = git.committed / git.total
    const cells = bar(ratio, 12)
    out.push(
      line(
        'committed',
        <T.Text>
          <T.Text dimColor>Committed </T.Text>
          <T.Text color="success">{cells.on}</T.Text>
          <T.Text dimColor>{cells.off}</T.Text>
          <T.Text> {Math.round(ratio * 100)}%</T.Text>
          <T.Text dimColor> | {git.committed} files in {git.commits} {git.commits === 1 ? 'commit' : 'commits'}</T.Text>
        </T.Text>,
      ),
    )
  }
  if (report.commits > 0) {
    out.push(line('runs', <T.Text dimColor>The session ran git commit {report.commits}x</T.Text>))
  }
  return out
}

/** Whether `file` (absolute) is one git reports dirty: `dirty` holds repo-relative paths. */
export const isDirty = (git: GitInfo | undefined, file: string, root: string): boolean => {
  if (!git || git.state !== 'ok' || git.dirty.length === 0) return false
  const norm = (p: string) => p.replace(/\\/g, '/').toLowerCase()
  const f = norm(file)
  return git.dirty.some(d => f.endsWith(`/${norm(d)}`)) || (root !== '' && git.dirty.includes(relativeTo(file, root)))
}

/**
 * One point of the help: a `term` (a name, a glyph, a key) set apart in bold,
 * what it means, and the points under it.
 */
export type HelpItem = { term?: string; text: string; sub?: string[] }
/** A section of the help; `keys` lays it out as a table, the terms aligned. */
export type HelpBlock = { title: string; items: HelpItem[]; keys?: boolean }

/**
 * The help page, written from the score's own table so it says what the code
 * does: what each section shows and how each number is reached. Short points,
 * one idea each, so it reads in a narrow column.
 */
export const helpText = (): HelpBlock[] => {
  const w = SCORE.flow.perTenTurns
  const g = SCORE.grades.map(([grade, min]) => `${grade} ${min}+`).join(', ')
  const pct = (n: number) => `${Math.round(n * 100)}%`
  return [
    {
      title: 'Score',
      items: [
        { text: 'Three sub-scores from 0 to 100, read from the transcript alone. The grade is their weighted mean.' },
        { term: 'Weights', text: `Flow ${pct(SCORE.weights.flow)} · Autonomy ${pct(SCORE.weights.autonomy)} · Delegation ${pct(SCORE.weights.delegation)}` },
        { term: 'Grades', text: `${g}, else E.` },
        {
          term: 'Flow',
          text: 'how smoothly it went. Starts at 100; per 10 turns it loses:',
          sub: [
            `${w.rejected} for each action you rejected`,
            `${w.interrupt} for each interrupt (Esc)`,
            `${w.planRejected} for each plan rejected without comment`,
            `${w.planRevised} for each plan sent back with comments`,
            `up to ${SCORE.flow.errorRate} more for tool failures, by their share of tool calls`,
            'a question you answered by asking back: nothing',
          ],
        },
        {
          term: 'Autonomy',
          text: 'work per message of yours: tool calls per turn, on a log scale.',
          sub: [`${SCORE.autonomy.low} per turn scores 20`, `${SCORE.autonomy.high} or more scores 100`],
        },
        {
          term: 'Delegation',
          text: 'use of other agents.',
          sub: [
            `half: the subagents' share of tokens (${pct(SCORE.delegation.fullShare)} or more is full use)`,
            'half: the share of background work (agents and commands) that completed',
            'background commands and no subagent: only that share',
            'nothing handed off: no Delegation (—), the grade comes from the other two, their weights scaled up',
          ],
        },
        { term: 'Deliv', text: 'beside the score, not in the grade: of the files the session edited in its repository, the share a commit since it started touched. Read from git now, for the selected session only.' },
      ],
    },
    {
      title: 'Score marks',
      items: [
        { term: '—', text: `too short to judge: fewer than ${SCORE.minTurns} turns or ${SCORE.minToolCalls} tool calls.` },
        { term: '≥', text: 'the transcript was too large to read whole: counts are lower bounds.' },
        {
          term: '?',
          text: 'the transcript\'s wording was not recognised, so the score does not judge instead of reading zero problems as a perfect session.',
          sub: [
            'the counts come from text Claude Code writes for itself (refusal and interrupt phrases, task notifications), not a public format',
            'an update that changes it shows as refusal-like errors, unreadable notifications or tool results not tied to their calls',
          ],
        },
        { term: '~', text: `written by a Claude Code newer than ${SCORE.testedWith}, the release these signals were checked with.` },
        { text: 'If ? or ~ shows up, update the plugin.' },
      ],
    },
    {
      title: 'Model and effort',
      items: [
        {
          term: 'Effort',
          text: 'beside the model, the main agent\'s last reply on the /effort scale, the step it is on lit:',
          sub: ['▁ low  ▃ medium  ▅ high  ▆ xhigh  █ max', 'a snapshot, like the model: what a resume picks up now'],
        },
        {
          term: 'Effort chart',
          text: '(Charts) how the session went: one bar split by the share of replies at each level.',
          sub: [
            'low to max, left to right, in their colours; the shares after it',
            'every reply counts; a level that occurs keeps at least one cell',
            'a session can end on max after running on medium: a high score there came from medium',
          ],
        },
        { text: 'Subagents count in neither: their replies are apart from the main agent\'s.' },
      ],
    },
    {
      title: 'Quality',
      items: [
        { term: '✗ rejected', text: 'tool calls you turned down; "with feedback" when you said why. The last correction is quoted under it.' },
        { term: '◌ interrupts', text: 'turns you stopped. A rejection that also stopped the turn counts once.' },
        { term: '! tool errors', text: 'calls that failed on their own.' },
        { term: '◐ revisions  ? clarified', text: 'normal back and forth: shown, not penalised.' },
        { term: '○ compactions', text: 'times the context was summarised.' },
      ],
    },
    {
      title: 'Agents',
      items: [
        { term: 'Bar', text: 'every subagent started, a colour per type, the legend under it.' },
        { term: 'Background', text: 'work started in the background: ✓ completed, ✗ failed, ■ killed or stopped, ◌ still open.' },
        { term: 'Depth', text: 'the deepest subagent of a subagent.' },
        { term: 'Agent tokens', text: 'their share of tokens in and out.' },
      ],
    },
    {
      title: 'WIP, Running, Todos',
      items: [
        { term: 'WIP ›', text: 'the last recap Claude Code wrote of the session.' },
        { term: 'Running', text: 'background work started and never reported done (◌ also marks the session row).' },
        {
          term: 'Todos / Tasks',
          text: 'the last todo list (TodoWrite) or task list (TaskCreate, TaskUpdate, TaskList): ✓ done, ◐ in progress, □ pending.',
          sub: ['a long session without one shows a hint'],
        },
      ],
    },
    {
      title: 'Plans',
      items: [
        { text: 'Each plan the session sent for approval: ✓ approved, ◐ sent back with comments, ✗ rejected.' },
        { term: 'Files touched', text: 'of the files the plan names, the ones edited by its session or any later session that named the plan file.' },
        {
          term: 'l',
          text: 'lists every plan of the scope, with the plan files in ~/.claude/plans no session names (○).',
          sub: ['Enter resumes the latest session of the plan', 'c copies its path (its text when the file is lost)', 'e exports it into the project'],
        },
      ],
    },
    {
      title: 'Uncommitted',
      items: [
        { text: 'Git, now, for the files the selected session edited inside its repository:' },
        { term: '+ -', text: 'lines added and removed, not yet committed; untracked files.' },
        { term: 'Committed', text: 'the share a commit since the session started touched.' },
        { term: '●', text: 'marks a dirty file in Files.' },
      ],
    },
    {
      title: 'Keys',
      keys: true,
      items: [
        { term: '↑↓', text: 'move' },
        { term: 'Enter', text: 'resume' },
        { term: 'PgUp/PgDn', text: 'scroll the report' },
        { term: 'b p a', text: 'scope' },
        { term: 'l', text: 'plans' },
        { term: 's', text: 'settings' },
        { term: 'h', text: 'help' },
        { term: 'c', text: 'copy' },
        { term: 'i', text: 'copy session reference' },
        { term: 'e', text: 'export plan' },
        { term: 'r', text: 'refresh' },
        { term: 'Esc', text: 'close' },
      ],
    },
  ]
}

/** Every word of the help as plain text, for search and tests. */
export const helpPlain = (): string =>
  helpText()
    .flatMap(b => [b.title, ...b.items.flatMap(i => [`${i.term ?? ''} ${i.text}`.trim(), ...(i.sub ?? [])])])
    .join('\n')

export const helpLines = (T: Els, width: number): El[] => {
  const out: El[] = [<T.Text key="help:title" bold color="claude">Super Resume help</T.Text>]
  for (const block of helpText()) {
    const k = `help:${block.title}`
    out.push(blank(T, k), heading(T, k, block.title))
    if (block.keys) {
      // a table: the keys in one column, what they do beside them
      const col = Math.max(...block.items.map(i => (i.term ?? '').length)) + 2
      block.items.forEach((item, n) =>
        out.push(
          <T.Text key={`${k}:${n}`} wrap="truncate-end">
            <T.Text color="suggestion">{`  ${(item.term ?? '').padEnd(col)}`}</T.Text>
            <T.Text>{item.text}</T.Text>
          </T.Text>,
        ),
      )
      continue
    }
    block.items.forEach((item, n) => {
      // `• term text…`, the lines after the first hung under the text
      const lead = item.term ? `${item.term} ` : ''
      wrapText(`${lead}${item.text}`, width - 2, 8).forEach((text, i) =>
        out.push(
          <T.Text key={`${k}:${n}:${i}`} wrap="truncate-end">
            <T.Text color="claude">{i === 0 ? '• ' : '  '}</T.Text>
            {i === 0 && lead !== '' && text.startsWith(item.term!) ? (
              <T.Text>
                <T.Text bold>{item.term}</T.Text>
                <T.Text>{text.slice(item.term!.length)}</T.Text>
              </T.Text>
            ) : (
              <T.Text>{text}</T.Text>
            )}
          </T.Text>,
        ),
      )
      for (const [s, sub] of (item.sub ?? []).entries()) {
        wrapText(sub, width - 4, 4).forEach((text, i) =>
          out.push(
            <T.Text key={`${k}:${n}:s${s}:${i}`} wrap="truncate-end">
              <T.Text dimColor>{i === 0 ? '  ◦ ' : '    '}</T.Text>
              <T.Text>{text}</T.Text>
            </T.Text>,
          ),
        )
      }
    })
  }
  out.push(blank(T, 'help:end'), <T.Text key="help:back" dimColor>h again to go back</T.Text>)
  return out
}

export const activeLabel = (report: SessionReport) =>
  report.activeMs > 0 ? `${duration(report.activeMs)} of ${duration(report.durationMs)}` : duration(report.durationMs)

export const enabled = (settings: Settings, key: SectionKey) => settings[key] !== false

export { scoreOf }
