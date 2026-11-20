import { expect, test } from 'claude-code/testing'

import {
  SCORE,
  classifyResult,
  feedbackOf,
  MIN_ENGINE,
  isNewerThan,
  isOlderThan,
  looksRefused,
  parseNotifications,
  parseTranscript,
  planFiles,
  planTextFrom,
  planTitle,
  scoreOf,
  slug,
  spark,
  distributionBar,
  stackBar,
  wrapBlocks,
  wrapPath,
} from '../hooks/parse'
import { helpPlain } from '../hooks/sections'

const ROOT = '/work/omega'
const BASE = '/home/me/.claude/projects'
const PLANS = '/home/me/.claude/plans'
const FOLDER = '-work-omega'
const posix = (path: string) => path.replace(/^[A-Za-z]:/, '').replace(/\\/g, '/')
const line = (o: unknown) => JSON.stringify(o)

// The wording Claude Code writes today, copied from real transcripts.
const STOP =
  "The user doesn't want to proceed with this tool use. The tool use was rejected (eg. if it was a file edit, the new_string was NOT written to the file). STOP what you are doing and wait for the user to tell you how to proceed."
const SAID = (words: string) =>
  `The user doesn't want to proceed with this tool use. The tool use was rejected (eg. if it was a file edit, the new_string was NOT written to the file). To tell you how to proceed, the user said:\n${words}\n\nNote: The user's next message may contain a correction or preference.`
const NOTIFY = (taskId: string, toolUseId: string, status: string) =>
  `<task-notification>\n<task-id>${taskId}</task-id>\n<tool-use-id>${toolUseId}</tool-use-id>\n<output-file>/tmp/${taskId}.output</output-file>\n<status>${status}</status>\n<summary>Agent "x" ${status}</summary>\n</task-notification>`

let clock = 0
const at = () => `2026-11-18T10:${String(clock++ % 60).padStart(2, '0')}:00Z`
const user = (content: unknown, extra: object = {}) =>
  line({ type: 'user', timestamp: at(), cwd: ROOT, gitBranch: 'main', version: '2.1.329', message: { role: 'user', content }, ...extra })
const call = (id: string, name: string, input: object, msg = `m-${id}`) =>
  line({ type: 'assistant', timestamp: at(), cwd: ROOT, gitBranch: 'main', version: '2.1.329',
    message: { id: msg, role: 'assistant', model: 'claude-opus-5-5', usage: { input_tokens: 100, output_tokens: 50 },
      content: [{ type: 'tool_use', id, name, input }] } })
const result = (id: string, content: string, toolUseResult: unknown = {}, isError = false) =>
  user([{ type: 'tool_result', tool_use_id: id, content, is_error: isError }], { toolUseResult })
const system = (subtype: string, extra: object) =>
  line({ type: 'system', subtype, timestamp: at(), cwd: ROOT, version: '2.1.329', ...extra })

const PLAN_TEXT = '# Faster retries\n\n## Context\nTouch `src/retry.ts` and `hooks/parse.ts:12`, not `npm test` or https://x.dev/a.ts.'

/** A session with one of each signal, in the shapes real transcripts hold. */
const rich = (): string =>
  [
    line({ type: 'summary', summary: 'Retry work' }),
    user('make retries faster'),
    // a refused edit that stopped the turn: the interrupt it writes is the same event
    call('t1', 'Edit', { file_path: `${ROOT}/src/retry.ts` }),
    result('t1', STOP, undefined, true),
    user([{ type: 'text', text: '[Request interrupted by user for tool use]' }]),
    user('try again'),
    call('t2', 'Bash', { command: 'rm -rf build' }),
    result('t2', SAID('use the existing helper instead'), undefined, true),
    // a question answered by asking back, and a plan sent back with comments: not friction
    call('t3', 'AskUserQuestion', { questions: [] }),
    result('t3', SAID('The user wants to clarify these questions.'), undefined, true),
    call('t4', 'ExitPlanMode', { plan: PLAN_TEXT }),
    result('t4', SAID('add tests to the plan'), undefined, true),
    call('t5', 'ExitPlanMode', { plan: PLAN_TEXT }),
    result('t5', 'User has approved your plan.', { plan: PLAN_TEXT, filePath: `${PLANS}/happy-plan.md` }),
    // a tool that failed on its own
    call('t6', 'Bash', { command: 'npm test' }),
    result('t6', 'Exit code 1: 3 tests failed', undefined, true),
    user([{ type: 'text', text: '[Request interrupted by user]' }]),
    system('compact_boundary', {}),
    system('turn_duration', { durationMs: 60_000 }),
    system('turn_duration', { durationMs: 120_000 }),
    system('away_summary', { content: 'Making retries faster; tests still red. (disable recaps in /config)' }),
    // background work: an agent that finishes, a command that never reports
    call('t7', 'Agent', { subagent_type: 'Explore', run_in_background: true, description: 'Scan the repo' }),
    result('t7', 'Async agent launched', { isAsync: true, status: 'async_launched', agentId: 'ag1' }),
    call('t8', 'Bash', { command: 'npm run watch', run_in_background: true, description: 'watch build' }),
    result('t8', 'Command running in background', { stdout: '', backgroundTaskId: 'bg1' }),
    user(NOTIFY('ag1', 't7', 'completed')),
    call('t9', 'SendMessage', { to: 'x', message: 'hi' }),
    result('t9', 'sent'),
    // a task list: two made, one done
    call('t10', 'TaskCreate', { subject: 'Parse retries', description: 'd' }),
    result('t10', 'Task #1 created', { task: { id: '1', subject: 'Parse retries' } }),
    call('t11', 'TaskCreate', { subject: 'Render retries', description: 'd' }),
    result('t11', 'Task #2 created', { task: { id: '2', subject: 'Render retries' } }),
    call('t12', 'TaskUpdate', { taskId: '1', status: 'completed' }),
    result('t12', 'Updated', { success: true, taskId: '1', updatedFields: ['status'], statusChange: { from: 'pending', to: 'completed' } }),
    call('t13', 'Bash', { command: 'git add -A && git commit -m "retry"' }),
    result('t13', '[main abc123] retry'),
    // reading another plan file links this session to it
    call('t14', 'Read', { file_path: `${PLANS}/older-plan.md` }),
    result('t14', '# Older plan'),
    user('ship it'),
    line({ type: 'assistant', timestamp: at(), cwd: ROOT, gitBranch: 'main', version: '2.1.329',
      message: { id: 'end', role: 'assistant', model: 'claude-opus-5-5', usage: { input_tokens: 10, output_tokens: 10 },
        content: [{ type: 'text', text: 'Shipped.' }] } }),
  ].join('\n')

test('rejections are told apart by the tool they answer, and their words are kept', () => {
  expect(classifyResult('Edit', STOP, true)).toBe('rejected')
  expect(classifyResult('Bash', SAID('no'), true)).toBe('rejected-feedback')
  expect(classifyResult('AskUserQuestion', SAID('The user wants to clarify these questions.'), true)).toBe('clarify')
  expect(classifyResult('ExitPlanMode', SAID('more tests'), true)).toBe('plan-revised')
  expect(classifyResult('ExitPlanMode', STOP, true)).toBe('plan-rejected')
  expect(classifyResult('Bash', 'Exit code 1', true)).toBe('error')
  expect(classifyResult('Bash', 'ok', false)).toBe('ok')
  expect(feedbackOf(SAID('use the helper'))).toBe('use the helper')
})

test('a session reads its quality, delegation, tasks, plans and recap', () => {
  const r = parseTranscript('rich', rich(), false, ROOT)!
  expect(r.quality.rejected).toBe(2)
  expect(r.quality.rejectedWithFeedback).toBe(1)
  expect(r.quality.lastFeedback).toBe('add tests to the plan')
  // the refusal's own stop counts once; the plain Esc counts
  expect(r.quality.interrupts).toBe(1)
  expect(r.quality.toolErrors).toBe(1)
  expect(r.quality.clarified).toBe(1)
  expect(r.quality.plansRevised).toBe(1)
  expect(r.quality.compactions).toBe(1)
  expect(r.activeMs).toBe(180_000)
  expect(r.wip.summary).toBe('Making retries faster; tests still red.')
  expect(r.delegation.agents).toEqual({ Explore: 1 })
  expect(r.delegation.background).toBe(2)
  expect(r.delegation.completed).toBe(1)
  expect(r.delegation.messages).toBe(1)
  expect(r.wip.open.map(w => w.id)).toEqual(['bg1'])
  expect(r.wip.todoSource).toBe('tasks')
  expect(r.wip.todos.map(t => `${t.id}:${t.status}`)).toEqual(['1:completed', '2:pending'])
  expect(r.commits).toBe(1)
  expect(r.plans.length).toBe(1)
  expect(r.plans[0]!.name).toBe('happy-plan.md')
  expect(r.plans[0]!.status).toBe('approved')
  // the revision sent before the file was named is folded into it
  expect(r.plans[0]!.revisions).toBe(1)
  expect(r.plans[0]!.title).toBe('Faster retries')
  expect(r.mentions).toEqual(['older-plan.md'])
  expect(r.signals.unrecognised).toEqual([])
  expect(r.signals.version).toBe('2.1.329')
})

test('TodoWrite keeps the last list, TaskList replaces the replay, a deleted task leaves', () => {
  const todos = [
    user('go'),
    call('a', 'TodoWrite', { todos: [{ content: 'one', status: 'completed', activeForm: 'x' }, { content: 'two', status: 'pending', activeForm: 'y' }] }),
    result('a', 'ok', { oldTodos: [], newTodos: [{ content: 'one', status: 'completed', activeForm: 'x' }, { content: 'two', status: 'in_progress', activeForm: 'y' }] }),
  ].join('\n')
  const r = parseTranscript('todos', todos, false, ROOT)!
  expect(r.wip.todoSource).toBe('todos')
  expect(r.wip.todos.map(t => `${t.text}:${t.status}`)).toEqual(['one:completed', 'two:in_progress'])

  const tasks = [
    user('go'),
    call('a', 'TaskCreate', { subject: 'A', description: '' }),
    result('a', 'ok', { task: { id: '7', subject: 'A' } }),
    call('b', 'TaskUpdate', { taskId: '7', status: 'deleted' }),
    result('b', 'ok', { success: true, taskId: '7', updatedFields: ['status'] }),
    call('c', 'TaskList', {}),
    result('c', 'ok', { tasks: [{ id: '9', subject: 'B', status: 'in_progress', blockedBy: ['3'] }] }),
  ].join('\n')
  const t = parseTranscript('tasks', tasks, false, ROOT)!
  expect(t.wip.todos).toEqual([{ id: '9', text: 'B', status: 'in_progress', blockedBy: ['3'] }])
})

test('a changed wording is reported, and the score declines instead of reading it as perfect', () => {
  // a refusal in words this version does not know: no rejection counted, but flagged
  const lines = [user('go')]
  for (let i = 0; i < 6; i++) {
    lines.push(call(`e${i}`, 'Edit', { file_path: `${ROOT}/a${i}.ts` }), result(`e${i}`, 'ok'))
    lines.push(user(`turn ${i}`))
  }
  lines.push(call('x', 'Edit', { file_path: `${ROOT}/b.ts` }), result('x', 'The user rejected this edit.', undefined, true))
  lines.push(user([{ type: 'text', text: '[Interrupted by the user]' }]))
  lines.push(user('<task-notification>\n<id>z</id>\n</task-notification>'))
  for (let i = 0; i < 6; i++) lines.push(call(`f${i}`, 'Read', { file_path: `${ROOT}/c${i}.ts` }), result(`f${i}`, 'ok'))
  const r = parseTranscript('drift', lines.join('\n'), false, ROOT)!
  expect(r.quality.rejected).toBe(0)
  expect(r.signals.unrecognised.length).toBe(3)
  const score = scoreOf(r)
  expect(score.grade).toBe('?')
  expect(score.overall).toBeUndefined()
  expect(score.reason).toContain('format not recognised')

  expect(looksRefused('The user rejected this edit.')).toBe(true)
  expect(looksRefused(STOP)).toBe(false)
  expect(looksRefused('Exit code 1: the user config file is missing')).toBe(false)

  // tool results no longer tied to their calls
  const unlinked = [user('go')]
  for (let i = 0; i < 12; i++) {
    unlinked.push(call(`u${i}`, 'Read', { file_path: `${ROOT}/a.ts` }), result(`other${i}`, 'ok'))
    if (i % 2 === 0) unlinked.push(user(`turn ${i}`))
  }
  expect(parseTranscript('unlinked', unlinked.join('\n'), false, ROOT)!.signals.unrecognised).toEqual([
    'tool results not tied to their calls',
  ])
})

test('the score: too short is —, a newer Claude Code is marked, sub-scores follow the table', () => {
  const r = parseTranscript('rich', rich(), false, ROOT)!
  expect(scoreOf(r).grade).toBe('—')
  // 5 turns, 15 tool calls (as the fixture)
  const big = { ...r, turns: 5, toolCalls: 15 }
  const score = scoreOf(big)
  // flow: 100 - (12*2 + 8*1 + 3*1) * 10 / 5 - 60 * 1/15 = 100 - 70 - 4 = 26
  expect(score.flow).toBe(26)
  // autonomy: 3 per turn: 20 + 80 * ln 3 / ln 30
  expect(score.autonomy).toBe(Math.round(20 + (80 * Math.log(3)) / Math.log(30)))
  expect(score.grade).not.toBe('—')
  expect(score.isNewer).toBe(false)
  expect(scoreOf({ ...big, signals: { ...big.signals, version: '2.2.0' } }).isNewer).toBe(true)
  expect(isNewerThan('3.0.1', '2.1')).toBe(true)
  expect(isNewerThan('2.1.999', '2.1')).toBe(false)
  // a clean, busy session with no agents
  const clean = {
    ...big,
    turns: 10,
    toolCalls: 100,
    quality: { ...big.quality, rejected: 0, rejectedWithFeedback: 0, interrupts: 0, toolErrors: 0, plansRevised: 0, plansRejected: 0 },
    delegation: { ...big.delegation, agents: {}, background: 0, completed: 0 },
  }
  const s = scoreOf(clean)
  expect(s.flow).toBe(100)
  // nothing handed off: no Delegation, the grade from Flow and Autonomy alone
  expect(s.delegation).toBeUndefined()
  const autonomy = Math.round(20 + (80 * Math.log(10)) / Math.log(30))
  expect(s.overall).toBe(Math.round((0.5 * 100 + 0.25 * autonomy) / 0.75))
  expect(s.grade).toBe('A')
  // background commands alone: Delegation is their success, not a penalty for using no subagent
  const bg = scoreOf({ ...clean, delegation: { ...clean.delegation, background: 4, completed: 3, failed: 1 } })
  expect(bg.delegation).toBe(75)
})

test('the help states the same thresholds the score uses', () => {
  const text = helpPlain()
  for (const [grade, min] of SCORE.grades) expect(text).toContain(`${grade} ${min}+`)
  expect(text).toContain(`fewer than ${SCORE.minTurns} turns or ${SCORE.minToolCalls} tool calls`)
  expect(text).toContain(`${SCORE.flow.perTenTurns.rejected} for each action you rejected`)
  expect(text).toContain(`${SCORE.autonomy.high} or more scores 100`)
})

test('plan helpers: title, named files, text from a transcript, slug; drawing helpers', () => {
  expect(planTitle(PLAN_TEXT)).toBe('Faster retries')
  expect(planFiles(PLAN_TEXT)).toEqual(['src/retry.ts', 'hooks/parse.ts'])
  expect(planTextFrom(rich(), 'happy-plan.md')).toBe(PLAN_TEXT)
  expect(slug('Choreography Lab: estágio 1!')).toBe('choreography-lab-estagio-1')
  expect(spark([0, 1, 2, 4], 4)).toBe('▁▃▅█')
  expect(stackBar([6, 2, 1], 9)).toEqual([6, 2, 1])
  expect(stackBar([1, 1, 1], 10).reduce((a, b) => a + b, 0)).toBe(10)
  expect(parseNotifications(NOTIFY('a', 'b', 'failed'))).toEqual([{ taskId: 'a', toolUseId: 'b', status: 'failed', summary: 'Agent "x" failed' }])
})

// ---------------------------------------------------------------------------
// The pane

const INLINE = {
  plugin: 'super-resume',
  component: 'Pane',
  requestId: 'super-resume',
  props: {
    title: 'Super Resume',
    isFocused: true,
    bodyColumns: 160,
    placement: 'inline',
    scroll: { offset: 0, bodyRows: 90 },
    view: {},
  },
} as const

const settle = async () => {
  for (let i = 0; i < 400; i++) await Promise.resolve()
}

type Git = (argv: readonly string[]) => string
const open = async ($: any, on: any, transcripts: Record<string, string>, opts: { git?: Git; plans?: Record<string, string>; store?: Record<string, unknown> } = {}) => {
  const writes: { path: string; text: string }[] = []
  const toasts: string[] = []
  const store: Record<string, unknown> = { ...(opts.store ?? {}) }
  on('store.get', (_: unknown, e: { key: string }) => ({ value: store[e.key] }))
  on('store.set', (_: unknown, e: { key: string; value: unknown }) => {
    store[e.key] = JSON.parse(JSON.stringify(e.value))
    return { value: undefined }
  })
  on('command.register', () => ({ value: { command: 'super-resume' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.focus', () => ({}))
  on('ui.toast', (_: unknown, e: { text: string }) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  on('session.start', (_: unknown, e: { cwd: string }) => ({ cwd: e.cwd }))
  on('session.root', () => ({ value: ROOT }))
  on('session.id', () => ({ value: 'current' }))
  on('session.version', () => ({ value: { version: '2.1.329', base: '2.1.329' } }))
  on('env.get', (_: unknown, e: { name: string }) => ({ value: e.name === 'HOME' ? '/home/me' : undefined }))
  on('process.run', (_: unknown, e: { argv: readonly string[] }) => {
    const out = opts.git ? opts.git(e.argv) : 'main\n'
    return { value: { exitCode: out === '!' ? 128 : 0, stdout: out === '!' ? '' : out, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  const plans = opts.plans ?? {}
  on('fs.exists', (_: unknown, e: { path: string }) => ({ value: posix(e.path) !== '/gone' }))
  on('fs.list', (_: unknown, e: { path: string }) => {
    const path = posix(e.path)
    if (path === `${BASE}/${FOLDER}`) {
      return { value: Object.keys(transcripts).map((id, i) => ({ name: `${id}.jsonl`, kind: 'file', size: 2000, mtimeMs: 100 - i, isLink: false })) }
    }
    if (path === PLANS) {
      return { value: Object.keys(plans).map(name => ({ name, kind: 'file', size: 100, mtimeMs: 1_700_000_000_000, isLink: false })) }
    }
    if (path.endsWith('/docs/plans')) {
      return { value: writes.filter(w => posix(w.path).startsWith(path)).map(w => ({ name: posix(w.path).split('/').pop(), kind: 'file', size: 1, mtimeMs: 1, isLink: false })) }
    }
    return { value: path === BASE ? [{ name: FOLDER, kind: 'dir', size: 0, mtimeMs: 0, isLink: false }] : [] }
  })
  on('fs.read', (_: unknown, e: { path: string }) => {
    const path = posix(e.path)
    const name = path.split('/').pop()!
    if (path.startsWith(PLANS)) return { value: plans[name] ?? '' }
    const written = writes.find(w => posix(w.path) === path)
    if (written) return { value: written.text }
    return { value: transcripts[name.replace('.jsonl', '')] ?? '' }
  })
  on('fs.write', (_: unknown, e: { path: string; text: string }) => {
    writes.push({ path: e.path, text: e.text })
    return { value: undefined }
  })
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
  await $.command.run({ command: 'super-resume', args: 'project', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 160 } })
  // the listing, and git for the first session, before a drawing mounts
  for (let i = 0; i < 10; i++) await settle()
  return { writes, toasts, store }
}

test('the report shows quality, agents, running work, tasks, plans and the recap', async ($, on) => {
  await open($, on, { rich: rich() })
  const ui = await $.ui.mount({ ...INLINE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /^ — {2}too short to score {2}h help$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^WIP › Making retries faster; tests still red\.$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /✗ 2 rejected \(1 with feedback\) \| ◌ 1 interrupts \| ! 1 tool errors \| ◐ 1 plan revisions \| \? 1 clarified \| ○ 1 compaction/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^feedback › add tests to the plan$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /Background 2 ✓1 ◌1 \| Messages 1/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /■ Explore 1/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^◌ command watch build$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: / 1\/2 done$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^□ Render retries$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^✓ Faster retries/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /Active 3m of / })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /The session ran git commit 1x/ })).toBeDefined()
  await ui.unmount()
})

test('settings hide a section, keep it in the store, and help opens with h', async ($, on) => {
  const { store } = await open($, on, { rich: rich() })
  const ui = await $.ui.mount({ ...INLINE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /^Quality$/ })).toBeDefined()

  await ui.press({ key: 'settings' })
  await settle()
  expect(await ui.find({ type: 'Text', text: /^Settings$/ })).toBeDefined()
  await ui.press({ key: 'setting:quality' })
  await settle()
  expect((store.settings as Record<string, unknown>).quality).toBe(false)
  await ui.press({ key: 'settings' })
  await settle()
  expect(await ui.find({ type: 'Text', text: /^Quality$/ })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /^Agents$/ })).toBeDefined()

  await ui.press({ key: 'help' })
  await settle()
  expect(await ui.find({ type: 'Text', text: /^Super Resume help$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^Score$/ })).toBeDefined()
  // points, not paragraphs: a bullet per term, sub-points under it
  expect(await ui.find({ type: 'Text', text: /^• Flow how smoothly it went/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^ {2}◦ \d+ for each action you rejected$/ })).toBeDefined()
  await ui.unmount()
})

test('settings saved in an earlier session apply when the pane opens', async ($, on) => {
  await open($, on, { rich: rich() }, { store: { settings: { agents: false, badge: false } } })
  const ui = await $.ui.mount({ ...INLINE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /^Agents$/ })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /^Quality$/ })).toBeDefined()
  await ui.unmount()
})

test('git: what the session left uncommitted, files outside the repo left out', async ($, on) => {
  const edits = [
    user('go'),
    call('a', 'Write', { file_path: `${ROOT}/src/a.ts` }),
    result('a', 'ok'),
    call('b', 'Edit', { file_path: `${ROOT}/src/b.ts` }),
    result('b', 'ok'),
    call('c', 'Edit', { file_path: '/elsewhere/notes.md' }),
    result('c', 'ok'),
  ].join('\n')
  const seen: string[][] = []
  await open($, on, { edits }, {
    git: argv => {
      seen.push([...argv])
      const args = argv.slice(1).join(' ')
      if (args === 'rev-parse --abbrev-ref HEAD') return 'main\n'
      if (args === 'rev-parse --show-toplevel') return `${ROOT}\n`
      if (args.startsWith('status')) return ' M src/b.ts\n?? src/a.ts\n'
      if (args.startsWith('diff')) return '4\t1\tsrc/b.ts\n'
      if (args.startsWith('log')) return `${'a'.repeat(40)}\n\nsrc/b.ts\n`
      return ''
    },
  })
  const ui = await $.ui.mount({ ...INLINE, surface: 'terminal' })
  await settle()
  // b.ts +4 -1 tracked; a.ts untracked, its lines read from disk (none here)
  expect(await ui.find({ type: 'Text', text: /^\+4 -1 in 2 of 2 files \| 1 untracked$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^Committed .* 50% \| 1 files in 1 commit$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /src\/b\.ts ●$/ })).toBeDefined()
  // only the two repository files reach git
  const status = seen.find(argv => argv[1] === 'status')!
  expect(status.slice(-2)).toEqual(['src/a.ts', 'src/b.ts'])
  await ui.unmount()
})

test('git: a removed folder says so', async ($, on) => {
  const edits = [user('go'), line({ type: 'assistant', timestamp: at(), cwd: '/gone', message: { id: 'x', role: 'assistant', content: [{ type: 'tool_use', id: 'a', name: 'Edit', input: { file_path: '/gone/a.ts' } }] } })].join('\n')
  await open($, on, { gone: edits })
  const ui = await $.ui.mount({ ...INLINE, surface: 'terminal' })
  await settle()
  expect(await ui.find({ type: 'Text', text: /folder gone/ })).toBeDefined()
  await ui.unmount()
})

test('plans view: joined across sessions, orphans listed, export never overwrites', async ($, on) => {
  // the session that wrote the plan, and a later one that read its file and edited a file it names
  const later = [
    user('implement the plan'),
    call('r', 'Read', { file_path: `${PLANS}/happy-plan.md` }),
    result('r', PLAN_TEXT),
    call('e', 'Edit', { file_path: `${ROOT}/src/retry.ts` }),
    result('e', 'ok'),
  ].join('\n')
  const { writes, toasts, store } = await open($, on, { later, rich: rich() }, {
    plans: { 'happy-plan.md': PLAN_TEXT, 'lonely-plan.md': '# Lonely idea\n' },
  })
  const ui = await $.ui.mount({ ...INLINE, surface: 'terminal' })
  await ui.press({ key: 'mode:plans' })
  await settle()
  expect(await ui.find({ type: 'Text', text: /^Plans$/ })).toBeDefined()
  expect(await ui.find({ type: 'Button', text: /✓ Faster retries/ })).toBeDefined()
  expect(await ui.find({ type: 'Button', text: /○ Lonely idea/ })).toBeDefined()
  // happy-plan is the newest: selected; written by rich, named by later
  expect(await ui.find({ type: 'Text', text: /^named  implement the plan/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: / 1\/2 touched$/ })).toBeDefined()

  await ui.press({ key: 'export-plan' })
  await settle()
  expect(writes.length).toBe(1)
  expect(posix(writes[0]!.path)).toBe(`${ROOT}/docs/plans/${writes[0]!.path.split(/[\\/]/).pop()}`)
  expect(writes[0]!.path).toMatch(/\d{4}-\d\d-\d\d-faster-retries\.md$/)
  expect(writes[0]!.text).toContain('Exported by Super Resume')
  expect(writes[0]!.text).toContain(PLAN_TEXT)
  expect(toasts.at(-1)).toMatch(/^Plan exported to docs\/plans\//)
  expect((store.exports as Record<string, string>)['happy-plan.md']).toMatch(/^docs\/plans\//)

  await ui.press({ key: 'export-plan' })
  await settle()
  expect(writes.length).toBe(1)
  expect(toasts.at(-1)).toMatch(/^Already exported/)
  await ui.unmount()
})

test('the list shows each session grade, and it does not change with the selection', async ($, on) => {
  const busy = [line({ type: 'summary', summary: 'Busy work' }), user('a')]
  for (let i = 0; i < 6; i++) {
    for (let j = 0; j < 4; j++) busy.push(call(`c${i}${j}`, 'Read', { file_path: `${ROOT}/x.ts` }), result(`c${i}${j}`, 'ok'))
    busy.push(user(`turn ${i}`))
  }
  await open($, on, { busy: busy.join('\n'), rich: rich() })
  const ui = await $.ui.mount({ ...INLINE, surface: 'terminal' })
  const before = (await ui.find({ type: 'Button', text: /Busy work/ }))?.text
  expect(String(before)).toMatch(/ [A-E] /)
  await $.ui.scroll({ component: 'Pane', requestId: 'super-resume', offset: 0, by: 1, bodyRows: 90, contentRows: 90, origin: { kind: 'person' } } as any)
  await settle()
  const after = (await ui.find({ type: 'Button', text: /Busy work/ }))?.text
  expect(String(after).replace(/^▶ |^  /, '')).toBe(String(before).replace(/^▶ |^  /, ''))
  await ui.unmount()
})


test('a pane mounted while the listing loads draws it when it lands', async ($, on) => {
  const edits = [user('go'), call('a', 'Edit', { file_path: '/gone/a.ts' }), result('a', 'ok')].join('\n')
  const store: Record<string, unknown> = {}
  on('store.get', (_: unknown, e: { key: string }) => ({ value: store[e.key] }))
  on('store.set', () => ({ value: undefined }))
  on('command.register', () => ({ value: { command: 'super-resume' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.focus', () => ({}))
  on('session.start', (_: unknown, e: { cwd: string }) => ({ cwd: e.cwd }))
  on('session.root', () => ({ value: ROOT }))
  on('session.id', () => ({ value: 'current' }))
  on('session.version', () => ({ value: { version: '2.1.329', base: '2.1.329' } }))
  on('env.get', (_: unknown, e: { name: string }) => ({ value: e.name === 'HOME' ? '/home/me' : undefined }))
  on('process.run', () => ({ value: { exitCode: 0, stdout: 'main\n', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
  on('fs.exists', () => ({ value: false }))
  on('fs.list', (_: unknown, e: { path: string }) => ({
    value: posix(e.path) === `${BASE}/${FOLDER}` ? [{ name: 'late.jsonl', kind: 'file', size: 2000, mtimeMs: 5, isLink: false }] : [],
  }))
  on('fs.read', (_: unknown, e: { path: string }) => ({ value: posix(e.path).endsWith('/late.jsonl') ? edits : '' }))
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
  await $.command.run({ command: 'super-resume', args: 'project', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 160 } })
  const ui = await $.ui.mount({ ...INLINE, surface: 'terminal' })
  for (let i = 0; i < 10; i++) await settle()
  expect(await ui.find({ type: 'Text', text: /^user {2}› go$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /folder gone/ })).toBeDefined()
  await ui.unmount()
})

test('a plan whose project folder is gone is not exported (no folder brought back)', async ($, on) => {
  const gone = [
    user('plan it'),
    line({ type: 'assistant', timestamp: at(), cwd: '/gone', version: '2.1.329', message: { id: 'p', role: 'assistant', model: 'claude-opus-5-5', content: [{ type: 'tool_use', id: 'p1', name: 'ExitPlanMode', input: { plan: PLAN_TEXT } }] } }),
    result('p1', 'User has approved your plan.', { plan: PLAN_TEXT, filePath: `${PLANS}/gone-plan.md` }),
  ].join('\n').replace(/"cwd":"\/work\/omega"/g, '"cwd":"/gone"')
  const { writes, toasts } = await open($, on, { gone }, { plans: { 'gone-plan.md': PLAN_TEXT } })
  const ui = await $.ui.mount({ ...INLINE, surface: 'terminal' })
  await ui.press({ key: 'mode:plans' })
  await settle()
  await ui.press({ key: 'export-plan' })
  await settle()
  expect(writes.length).toBe(0)
  expect(toasts.at(-1)).toBe('Project folder gone: c copies the plan instead')
  await ui.unmount()
})

test('the report names the session id and transcript, and i copies a reference to it', async ($, on) => {
  const copied: string[] = []
  on('ui.copy', (_: unknown, e: { text: string }) => {
    copied.push(e.text)
    return { value: { isCopied: true } }
  })
  const { toasts } = await open($, on, { rich: rich() })
  const ui = await $.ui.mount({ ...INLINE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /^id rich {2}i copy reference$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^~[\/]\.claude[\/]projects[\/]-work-omega[\/]rich\.jsonl$/ })).toBeDefined()
  await ui.press({ key: 'copy-reference' })
  await settle()
  expect(copied.at(-1)).toMatch(/^Claude Code session "Retry work" \(id rich\), project \/work\/omega, transcript .*rich\.jsonl$/)
  expect(toasts.at(-1)).toMatch(/^Session reference copied/)
  await ui.unmount()
})

test('a long transcript path is shown whole, broken after a slash', () => {
  const path = '~/.claude/projects/C--Users-adria-Apps-super-resume/f25a141e-2053-4f14-9068-b55782cf0cef.jsonl'
  const lines = wrapPath(path, 60, 3)
  expect(lines).toEqual(['~/.claude/projects/C--Users-adria-Apps-super-resume/', 'f25a141e-2053-4f14-9068-b55782cf0cef.jsonl'])
  expect(lines.join('')).toBe(path)
  for (const line of lines) expect(line.length).toBeLessThanOrEqual(60)
  // too narrow for the folder: cut at the width, the whole path still there
  expect(wrapPath(path, 30, 5).join('')).toBe(path)
  // more lines than allowed: the end is kept, the cut marked
  const kept = wrapPath(path, 20, 2)
  expect(kept.length).toBe(2)
  expect(kept[0]!.startsWith('…')).toBe(true)
  expect(kept.join('').endsWith('b55782cf0cef.jsonl')).toBe(true)
})

test('effort: the last reply\'s level after the model, and its distribution over the session', async ($, on) => {
  const reply = (id: string, effort: string, perTurn: string | null = null) =>
    line({ type: 'assistant', timestamp: at(), cwd: ROOT, gitBranch: 'main', version: '2.1.329', effort, perTurnEffort: perTurn,
      message: { id, role: 'assistant', model: 'claude-opus-5-5', usage: { input_tokens: 10, output_tokens: 10 }, content: [{ type: 'text', text: `r ${id}` }] } })
  const t = [
    user('a'), reply('1', 'medium'), reply('1', 'medium'), // one reply, two lines: counted once
    user('b'), reply('2', 'medium', 'high'), // a turn set to high
    user('c'), reply('3', 'medium'),
    user('d'), reply('4', 'low', 'max'),
  ].join('\n')
  const r = parseTranscript('eff', t, false, ROOT)!
  expect(r.effort).toBe('max')
  expect(r.effortMix).toEqual({ medium: 2, high: 1, max: 1 })
  // the bar splits its width by share
  expect(distributionBar([2, 1, 1], 8)).toEqual([4, 2, 2])
  // a long session keeps the same width, and a rare level keeps a cell
  expect(distributionBar([997, 3], 24)).toEqual([23, 1])
  expect(distributionBar([500, 0, 2], 10)).toEqual([9, 0, 1])

  await open($, on, { eff: t })
  const ui = await $.ui.mount({ ...INLINE, surface: 'terminal' })
  // the snapshot: the last reply's level, all five steps lit at max
  expect(await ui.find({ type: 'Text', text: /^omega \| ⎇ main \| Opus 5\.5 \| effort ▁▃▅▆█ max$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^Effort {3}█{6,24} {2}medium 50% \| high 25% \| max 25%$/ })).toBeDefined()
  await ui.unmount()
})

test('the effort snapshot comes from the main agent alone, its last reply', () => {
  const reply = (id: string, effort: string, extra: object = {}) =>
    line({ type: 'assistant', timestamp: at(), cwd: ROOT, version: '2.1.329', effort, ...extra,
      message: { id, role: 'assistant', model: 'claude-opus-5-5', usage: { input_tokens: 1 }, content: [{ type: 'text', text: id }] } })
  const t = [
    user('a'), reply('1', 'max'),
    user('b'), reply('2', 'high'),
    // a subagent's reply inside the main transcript, at another effort: not the main agent's
    reply('3', 'low', { isSidechain: true }),
  ].join('\n')
  const r = parseTranscript('main', t, false, ROOT)!
  expect(r.effort).toBe('high')
  expect(r.effortMix).toEqual({ max: 1, high: 1 })
})

test('a reply keeps its paragraphs and lists when wrapped', () => {
  const reply = [
    'Done. Changes:',
    '',
    '- first point that is long enough to wrap',
    '  - nested',
    '1. numbered',
    '',
    '```ts',
    'const x =    1',
    '```',
    'End.',
  ].join('\n')
  expect(wrapBlocks(reply, 24, 20)).toEqual([
    'Done. Changes:',
    '• first point that is',
    '  long enough to wrap',
    '  • nested',
    '1. numbered',
    'const x =    1',
    'End.',
  ])
  // too long: the end kept, the cut marked
  expect(wrapBlocks(reply, 24, 2, 'end')).toEqual(['…const x =    1', 'End.'])
  // one paragraph reads as before
  expect(wrapBlocks('a b c', 24, 3)).toEqual(['a b c'])
})

test('the engine check: a build before the minimum is older, a later or unreadable one is not', () => {
  expect(isOlderThan('2.1.286', MIN_ENGINE)).toBe(true)
  expect(isOlderThan('2.0.999', '2.1.0')).toBe(true)
  expect(isOlderThan(MIN_ENGINE, MIN_ENGINE)).toBe(false)
  expect(isOlderThan('2.1.330', MIN_ENGINE)).toBe(false)
  expect(isOlderThan('3.0.0', MIN_ENGINE)).toBe(false)
  expect(isOlderThan('2.1.280-dev', '2.1.281')).toBe(true)
  expect(isOlderThan('local', MIN_ENGINE)).toBe(false)
})
