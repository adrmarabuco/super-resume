import { expect, test } from 'claude-code/testing'

const ROOT = '/work/omega'
const BASE = '/home/me/.claude/projects'
const FOLDER = '-work-omega'

// The engine resolves a path before a test hook sees it: on Windows
// '/home/me' arrives as 'C:\home\me'. Compare in POSIX form.
const posix = (path: string) => path.replace(/^[A-Za-z]:/, '').replace(/\\/g, '/')

const line = (o: unknown) => JSON.stringify(o)
const transcript = (prompt: string, reply: string, branch: string, tokens: number) =>
  [
    line({ type: 'summary', summary: `Fix ${prompt}` }),
    line({
      type: 'user',
      timestamp: '2026-11-18T10:00:00Z',
      cwd: ROOT,
      gitBranch: branch,
      message: { role: 'user', content: prompt },
    }),
    line({
      type: 'assistant',
      timestamp: '2026-11-18T10:40:00Z',
      cwd: ROOT,
      gitBranch: branch,
      message: {
        role: 'assistant',
        model: 'claude-opus-5-5',
        usage: { input_tokens: 10, cache_read_input_tokens: tokens },
        content: [
          { type: 'tool_use', name: 'Edit', input: { file_path: `${ROOT}/src/api.ts` } },
          { type: 'text', text: reply },
        ],
      },
    }),
  ].join('\n')

const FILES: Record<string, string> = {
  [`${BASE}/${FOLDER}/aaa.jsonl`]: transcript('the retry logic', 'Retries now back off.', 'main', 150_000),
  [`${BASE}/${FOLDER}/bbb.jsonl`]: transcript('the login page', 'Login form done.', 'feature/login', 40_000),
}

const PANE = {
  plugin: 'super-resume',
  component: 'Pane',
  requestId: 'super-resume',
  props: {
    title: 'Super Resume',
    isFocused: true,
    bodyColumns: 120,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 40 },
    view: {},
  },
} as const

test('the pane lists sessions and reports where the chosen one stopped', async ($, on) => {
  on('command.register', () => ({ value: { command: 'super-resume' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.root', () => ({ value: ROOT }))
  on('session.id', () => ({ value: 'current' }))
  on('env.get', (_, e) => ({ value: e.name === 'HOME' ? '/home/me' : undefined }))
  on('process.run', () => ({ value: { exitCode: 0, stdout: 'main\n', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
  on('fs.list', (_, e) => ({
    value:
      posix(e.path) === `${BASE}/${FOLDER}`
        ? [
            { name: 'aaa.jsonl', kind: 'file', size: 2000, mtimeMs: 2, isLink: false },
            { name: 'bbb.jsonl', kind: 'file', size: 2000, mtimeMs: 1, isLink: false },
          ]
        : [{ name: FOLDER, kind: 'dir', size: 0, mtimeMs: 0, isLink: false }],
  }))
  on('fs.read', (_, e) => ({ value: FILES[posix(e.path)] ?? '' }))

  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
  await $.command.run({
    command: 'super-resume',
    args: 'project',
    origin: { kind: 'composer' },
    presentation: { isFullscreen: true, columns: 160 },
  })

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })

    expect(await ui.find({ type: 'Text', text: /Fix the retry logic/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /Retries now back off/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /Fix the login page/ })).toBeDefined()

    expect(await ui.find({ type: 'Text', text: /Retries now back off/ })).toBeDefined()
    await ui.unmount()
  }
})

test('branch scope keeps only the current branch', async ($, on) => {
  on('command.register', () => ({ value: { command: 'super-resume' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.root', () => ({ value: ROOT }))
  on('session.id', () => ({ value: 'current' }))
  on('env.get', (_, e) => ({ value: e.name === 'HOME' ? '/home/me' : undefined }))
  on('process.run', () => ({ value: { exitCode: 0, stdout: 'main\n', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
  on('fs.list', () => ({
    value: [
      { name: 'aaa.jsonl', kind: 'file', size: 2000, mtimeMs: 2, isLink: false },
      { name: 'bbb.jsonl', kind: 'file', size: 2000, mtimeMs: 1, isLink: false },
    ],
  }))
  on('fs.read', (_, e) => ({ value: FILES[posix(e.path)] ?? '' }))

  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
  await $.command.run({
    command: 'super-resume',
    args: 'branch',
    origin: { kind: 'composer' },
    presentation: { isFullscreen: true, columns: 160 },
  })

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /Fix the retry logic/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /Fix the login page/ })).toBeUndefined()
  await ui.unmount()
})

test('a scope switch that finishes late never overwrites a later one', async ($, on) => {
  const OTHER = '-work-other'
  const STALE_FILE = `${BASE}/${OTHER}/ccc.jsonl`
  let releaseStale: () => void = () => {}
  const stale = new Promise<void>(resolve => {
    releaseStale = resolve
  })

  on('command.register', () => ({ value: { command: 'super-resume' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.root', () => ({ value: ROOT }))
  on('session.id', () => ({ value: 'current' }))
  on('env.get', (_, e) => ({ value: e.name === 'HOME' ? '/home/me' : undefined }))
  on('process.run', () => ({ value: { exitCode: 0, stdout: 'main\n', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
  on('fs.list', (_, e) => {
    const path = posix(e.path)
    if (path === BASE) {
      return {
        value: [
          { name: FOLDER, kind: 'dir', size: 0, mtimeMs: 0, isLink: false },
          { name: OTHER, kind: 'dir', size: 0, mtimeMs: 0, isLink: false },
        ],
      }
    }
    if (path === `${BASE}/${OTHER}`) {
      return { value: [{ name: 'ccc.jsonl', kind: 'file', size: 2000, mtimeMs: 3, isLink: false }] }
    }
    return {
      value: [
        { name: 'aaa.jsonl', kind: 'file', size: 2000, mtimeMs: 2, isLink: false },
        { name: 'bbb.jsonl', kind: 'file', size: 2000, mtimeMs: 1, isLink: false },
      ],
    }
  })
  on('fs.read', async (_, e) => {
    const path = posix(e.path)
    if (path === STALE_FILE) await stale
    return { value: path === STALE_FILE ? transcript('a stale project', 'Stale output.', 'main', 1000) : (FILES[path] ?? '') }
  })

  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
  await $.command.run({
    command: 'super-resume',
    args: 'project',
    origin: { kind: 'composer' },
    presentation: { isFullscreen: true, columns: 160 },
  })

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })

  // 'all' starts a load that hangs on the stale project's file; 'project' is
  // pressed right after and finishes fast, with nothing to wait on.
  await ui.press({ key: 'scope:all' })
  await ui.press({ key: 'scope:project' })

  // Now let the slow 'all' load's file read through. If load() doesn't guard
  // against a stale result, this repaints the pane back to 'all' once it
  // finally finishes, even though 'project' is what was pressed last.
  releaseStale()
  await stale
  await new Promise(resolve => setTimeout(resolve, 0))
  await new Promise(resolve => setTimeout(resolve, 0))

  expect(await ui.find({ type: 'Text', text: /Stale output/ })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /● project/ })).toBeDefined()
  await ui.unmount()
})

test('arrow-key focus on a session row moves the pointer, not just the ring', async ($, on) => {
  on('command.register', () => ({ value: { command: 'super-resume' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  // Stands in for the terminal actually moving its focus ring (what sits
  // beneath our plugin's own ui.focus hook via next(e)); the real app has
  // this built in.
  on('ui.focus', () => ({ value: {} }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.root', () => ({ value: ROOT }))
  on('session.id', () => ({ value: 'current' }))
  on('env.get', (_, e) => ({ value: e.name === 'HOME' ? '/home/me' : undefined }))
  on('process.run', () => ({ value: { exitCode: 0, stdout: 'main\n', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
  on('fs.list', (_, e) => ({
    value:
      posix(e.path) === `${BASE}/${FOLDER}`
        ? [
            { name: 'aaa.jsonl', kind: 'file', size: 2000, mtimeMs: 2, isLink: false },
            { name: 'bbb.jsonl', kind: 'file', size: 2000, mtimeMs: 1, isLink: false },
          ]
        : [{ name: FOLDER, kind: 'dir', size: 0, mtimeMs: 0, isLink: false }],
  }))
  on('fs.read', (_, e) => ({ value: FILES[posix(e.path)] ?? '' }))

  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
  await $.command.run({
    command: 'super-resume',
    args: 'project',
    origin: { kind: 'composer' },
    presentation: { isFullscreen: true, columns: 160 },
  })

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /Retries now back off/ })).toBeDefined()

  // aaa (most recent mtime) is selected by default; the arrows move the
  // focus ring onto bbb without pressing it (that's Enter/click).
  await $.ui.focus({
    component: 'Pane',
    requestId: 'super-resume',
    element: 'session:bbb',
    origin: { kind: 'person' },
  })

  expect(await ui.find({ type: 'Text', text: /Login form done/ })).toBeDefined()
  await ui.unmount()
})

test('finds transcripts through the session transcript when HOME is unset', async ($, on) => {
  on('command.register', () => ({ value: { command: 'super-resume' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.root', () => ({ value: ROOT }))
  on('session.id', () => ({ value: 'current' }))
  on('session.info', () => ({
    value: { transcriptPath: `${BASE}/${FOLDER}/current.jsonl`, platform: 'windows', isHosted: false },
  }))
  on('env.get', () => ({ value: undefined }))
  on('process.run', () => ({ value: { exitCode: 0, stdout: 'main\n', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
  on('fs.list', (_, e) => ({
    value:
      posix(e.path) === `${BASE}/${FOLDER}`
        ? [{ name: 'aaa.jsonl', kind: 'file', size: 2000, mtimeMs: 2, isLink: false }]
        : [],
  }))
  on('fs.read', (_, e) => ({ value: FILES[posix(e.path)] ?? '' }))

  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
  await $.command.run({
    command: 'super-resume',
    args: 'project',
    origin: { kind: 'composer' },
    presentation: { isFullscreen: true, columns: 160 },
  })

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /Fix the retry logic/ })).toBeDefined()
  await ui.unmount()
})

test('Enter on a session resumes it here, or copies the command for another project', async ($, on) => {
  const resumed: string[] = []
  const copied: string[] = []
  let closes = 0
  on('command.register', () => ({ value: { command: 'super-resume' } }))
  on('command.run', { command: 'resume' }, (_, e) => {
    resumed.push(e.args)
    return { text: '' }
  })
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.close', () => {
    closes++
    return { value: undefined }
  })
  on('ui.copy', (_, e) => {
    copied.push(e.text)
    return { value: { isCopied: true } }
  })
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.root', () => ({ value: ROOT }))
  on('session.id', () => ({ value: 'current' }))
  on('env.get', (_, e) => ({ value: e.name === 'HOME' ? '/home/me' : undefined }))
  on('process.run', () => ({ value: { exitCode: 0, stdout: 'main\n', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
  on('fs.list', (_, e) => ({
    value:
      posix(e.path) === `${BASE}/${FOLDER}`
        ? [
            { name: 'aaa.jsonl', kind: 'file', size: 2000, mtimeMs: 2, isLink: false },
            { name: 'zzz.jsonl', kind: 'file', size: 2000, mtimeMs: 1, isLink: false },
          ]
        : [{ name: FOLDER, kind: 'dir', size: 0, mtimeMs: 0, isLink: false }],
  }))
  on('fs.read', (_, e) => {
    const path = posix(e.path)
    if (path.endsWith('/zzz.jsonl')) {
      return { value: transcript('the docs', 'Docs done.', 'main', 1000).replaceAll(ROOT, '/work/other') }
    }
    return { value: FILES[path] ?? '' }
  })

  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
  await $.command.run({
    command: 'super-resume',
    args: 'project',
    origin: { kind: 'composer' },
    presentation: { isFullscreen: true, columns: 160 },
  })

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /Fix the docs/ })).toBeDefined()

  // A row's onPress starts choose() without awaiting it; let it run out.
  const settle = async () => {
    for (let i = 0; i < 200; i++) await Promise.resolve()
  }

  await ui.press({ key: 'session:aaa' })
  await settle()
  expect(resumed).toEqual(['aaa'])
  expect(copied).toEqual([])

  await ui.press({ key: 'session:zzz' })
  await settle()
  expect(copied.length).toBe(1)
  expect(copied[0]).toContain('claude --resume zzz')
  expect(resumed).toEqual(['aaa'])
  expect(closes).toBe(2)
  await ui.unmount()
})

// N sessions s00..s(N-1), s00 the most recent, each with its own reply.
const many = (n: number) => {
  const ids = Array.from({ length: n }, (_, i) => `s${String(i).padStart(2, '0')}`)
  const files: Record<string, string> = {}
  for (const id of ids) {
    files[`${BASE}/${FOLDER}/${id}.jsonl`] = transcript(`task ${id}`, `Reply of ${id}.`, 'main', 1000)
  }
  const entries = ids.map((id, i) => ({ name: `${id}.jsonl`, kind: 'file', size: 2000, mtimeMs: n - i, isLink: false }))
  return { ids, files, entries }
}

const openMany = async ($: any, on: any, n: number) => {
  const { files, entries } = many(n)
  on('command.register', () => ({ value: { command: 'super-resume' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.focus', () => ({ value: {} }))
  on('session.start', (_: unknown, e: { cwd: string }) => ({ cwd: e.cwd }))
  on('session.root', () => ({ value: ROOT }))
  on('session.id', () => ({ value: 'current' }))
  on('env.get', (_: unknown, e: { name: string }) => ({ value: e.name === 'HOME' ? '/home/me' : undefined }))
  on('process.run', () => ({ value: { exitCode: 0, stdout: 'main\n', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
  on('fs.list', (_: unknown, e: { path: string }) => ({
    value: posix(e.path) === `${BASE}/${FOLDER}` ? entries : [{ name: FOLDER, kind: 'dir', size: 0, mtimeMs: 0, isLink: false }],
  }))
  on('fs.read', (_: unknown, e: { path: string }) => ({ value: files[posix(e.path)] ?? '' }))
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
  await $.command.run({
    command: 'super-resume',
    args: 'project',
    origin: { kind: 'composer' },
    presentation: { isFullscreen: false, columns: 160 },
  })
}

const INLINE = {
  ...PANE,
  props: { ...PANE.props, placement: 'inline', bodyColumns: 160, scroll: { offset: 0, bodyRows: 20 } },
} as const

const settle = async () => {
  for (let i = 0; i < 300; i++) await Promise.resolve()
}

const key = (by: number, bodyRows = 20, contentRows = 20) => ({
  component: 'Pane',
  requestId: 'super-resume',
  offset: 0,
  by,
  bodyRows,
  contentRows,
  origin: { kind: 'person' },
})

test('arrow keys move the selection and the report instead of scrolling the pane', async ($, on) => {
  await openMany($, on, 30)
  const ui = await $.ui.mount({ ...INLINE, props: { ...INLINE.props, scroll: { offset: 0, bodyRows: 30 } }, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /Reply of s00/ })).toBeDefined()

  await $.ui.scroll(key(1) as any)
  await settle()
  expect(await ui.find({ type: 'Text', text: /Reply of s01/ })).toBeDefined()

  await $.ui.scroll(key(-1) as any)
  await settle()
  await $.ui.scroll(key(-1) as any)
  await settle()
  expect(await ui.find({ type: 'Text', text: /Reply of s00/ })).toBeDefined()

  await $.ui.scroll(key(40, 20, 40) as any)
  await settle()
  expect(await ui.find({ type: 'Text', text: /Reply of s29/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /task s29/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /↑ \d+ more/ })).toBeDefined()
  await ui.unmount()
})

test('a long list shows only the rows that fit, with a count of the rest', async ($, on) => {
  await openMany($, on, 30)
  const ui = await $.ui.mount({ ...INLINE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /task s00/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /task s29/ })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /↓ \d+ more/ })).toBeDefined()
  await ui.unmount()
})

test('docked, a hint says the side-by-side view is outside fullscreen', async ($, on) => {
  await openMany($, on, 3)
  const inline = await $.ui.mount({ ...INLINE, surface: 'terminal' })
  expect(await inline.find({ type: 'Text', text: /Outside fullscreen/ })).toBeUndefined()
  await inline.unmount()

  const docked = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await docked.find({ type: 'Text', text: /Outside fullscreen/ })).toBeDefined()
  await docked.unmount()
})

test('the report sums tokens once per reply, counts the diff, and adds up subagents apart', async ($, on) => {
  const reply = (id: string, usage: object, content: object[]) =>
    line({ type: 'assistant', timestamp: '2026-11-18T10:40:00Z', cwd: ROOT, gitBranch: 'main',
      message: { id, role: 'assistant', model: 'claude-opus-5-5', usage, content } })
  const result = (toolUseResult: object) =>
    line({ type: 'user', timestamp: '2026-11-18T10:41:00Z', cwd: ROOT,
      message: { role: 'user', content: [{ type: 'tool_result', content: 'ok' }] }, toolUseResult })
  const u1 = { input_tokens: 100, cache_creation_input_tokens: 900, cache_read_input_tokens: 10_000, output_tokens: 500 }
  const u2 = { input_tokens: 50, cache_creation_input_tokens: 0, cache_read_input_tokens: 20_000, output_tokens: 1500 }
  const main = [
    line({ type: 'user', timestamp: '2026-11-18T10:00:00Z', cwd: ROOT, gitBranch: 'main', message: { role: 'user', content: 'ship it' } }),
    // one reply written as two lines (two blocks), same id and usage: counted once
    reply('m1', u1, [{ type: 'tool_use', name: 'Edit', input: { file_path: `${ROOT}/src/a.ts` } }]),
    reply('m1', u1, [{ type: 'tool_use', name: 'Write', input: { file_path: `${ROOT}/src/new.ts` } }]),
    result({ filePath: `${ROOT}/src/a.ts`, structuredPatch: [{ lines: [' keep', '-old', '+new', '+more'] }] }),
    result({ type: 'create', filePath: `${ROOT}/src/new.ts`, structuredPatch: [], content: 'x\ny\nz\n' }),
    result({ stdout: '', bashEditDiff: { files: [{ filePath: `${ROOT}/README.md`, hunks: [{ lines: ['-a', '-b', '+c'] }] }] } }),
    reply('m2', u2, [{ type: 'text', text: 'Shipped.' }]),
  ].join('\n')
  const agent = reply('s1', { input_tokens: 1000, cache_read_input_tokens: 4000, output_tokens: 2000 }, [{ type: 'text', text: 'done' }])

  on('command.register', () => ({ value: { command: 'super-resume' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.root', () => ({ value: ROOT }))
  on('session.id', () => ({ value: 'current' }))
  on('env.get', (_, e) => ({ value: e.name === 'HOME' ? '/home/me' : undefined }))
  on('process.run', () => ({ value: { exitCode: 0, stdout: 'main\n', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
  on('fs.list', (_, e) => {
    const path = posix(e.path)
    if (path === `${BASE}/${FOLDER}`) return { value: [{ name: 'aaa.jsonl', kind: 'file', size: 2000, mtimeMs: 2, isLink: false }] }
    if (path === `${BASE}/${FOLDER}/aaa/subagents`) {
      return { value: [
        { name: 'agent-1.jsonl', kind: 'file', size: 500, mtimeMs: 1, isLink: false },
        { name: 'agent-1.meta.json', kind: 'file', size: 50, mtimeMs: 1, isLink: false },
      ] }
    }
    return { value: [{ name: FOLDER, kind: 'dir', size: 0, mtimeMs: 0, isLink: false }] }
  })
  on('fs.read', (_, e) => {
    const path = posix(e.path)
    if (path.endsWith('/aaa.jsonl')) return { value: main }
    if (path.endsWith('/agent-1.jsonl')) return { value: agent }
    return { value: '' }
  })

  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
  await $.command.run({ command: 'super-resume', args: 'project', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 160 } })
  const ui = await $.ui.mount({ ...INLINE, props: { ...INLINE.props, scroll: { offset: 0, bodyRows: 36 } }, surface: 'terminal' })

  // in = 100+900 + 50 = 1050, out = 2000, cache = 30000; total 33050
  expect(await ui.find({ type: 'Text', text: /^Tokens 33k \| In 1k \| Out 2k \| Cache 30k$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^Agents 1 \| Tokens 7k \| In 1k \| Out 2k \| Cache 4k$/ })).toBeDefined()
  // a.ts +2 -1, new.ts +3, README.md +1 -2
  expect(await ui.find({ type: 'Text', text: /^\+6 -3  3 files$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^\+3 -0  src\/new\.ts$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^\+1 -2  README\.md$/ })).toBeDefined()
  await ui.unmount()
})

test('a fork names its parent and chain, its parent counts its forks, and inherited lines are not its own', async ($, on) => {
  const user = (text: string, branch: string, extra: object = {}) =>
    line({ type: 'user', timestamp: '2026-11-18T10:00:00Z', cwd: ROOT, gitBranch: branch, message: { role: 'user', content: text }, ...extra })
  const said = (id: string, text: string, branch: string, extra: object = {}) =>
    line({ type: 'assistant', timestamp: '2026-11-18T10:05:00Z', cwd: ROOT, gitBranch: branch,
      message: { id, role: 'assistant', model: 'claude-opus-5-5', usage: { input_tokens: 10, output_tokens: 1000 }, content: [{ type: 'text', text }] }, ...extra })
  const from = (sessionId: string) => ({ forkedFrom: { sessionId, messageUuid: 'u' } })
  // root (other branch, so not listed) -> mid -> leaf
  const rootT = [line({ type: 'summary', summary: 'Root work' }), user('start root', 'other'), said('r1', 'root reply', 'other')].join('\n')
  const midT = [line({ type: 'summary', summary: 'Mid work' }),
    user('start root', 'main', from('root')), said('r1', 'root reply', 'main', from('root')),
    user('mid prompt', 'main'), said('m1', 'mid reply', 'main')].join('\n')
  const leafT = [line({ type: 'summary', summary: 'Leaf work' }),
    user('start root', 'main', from('mid')), said('r1', 'root reply', 'main', from('mid')),
    user('mid prompt', 'main', from('mid')), said('m1', 'mid reply', 'main', from('mid')),
    user('leaf prompt', 'main'), said('l1', 'leaf reply', 'main')].join('\n')
  const T: Record<string, string> = { root: rootT, mid: midT, leaf: leafT }

  on('command.register', () => ({ value: { command: 'super-resume' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.focus', () => ({ value: {} }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.root', () => ({ value: ROOT }))
  on('session.id', () => ({ value: 'current' }))
  on('env.get', (_, e) => ({ value: e.name === 'HOME' ? '/home/me' : undefined }))
  on('process.run', () => ({ value: { exitCode: 0, stdout: 'main\n', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
  on('fs.list', (_, e) => ({
    value: posix(e.path) === `${BASE}/${FOLDER}`
      ? ['leaf', 'mid', 'root'].map((id, i) => ({ name: `${id}.jsonl`, kind: 'file', size: 2000, mtimeMs: 3 - i, isLink: false }))
      : [],
  }))
  on('fs.read', (_, e) => {
    const name = posix(e.path).split('/').pop()!.replace('.jsonl', '')
    return { value: T[name] ?? '' }
  })

  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
  await $.command.run({ command: 'super-resume', args: 'branch', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 160 } })
  const ui = await $.ui.mount({ ...INLINE, props: { ...INLINE.props, scroll: { offset: 0, bodyRows: 36 } }, surface: 'terminal' })

  // leaf is selected (most recent): parent mid, chain root › mid › this
  expect(await ui.find({ type: 'Text', text: /^↳ Mid work \| \d+\w ago$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^Chain Root work › Mid work › this$/ })).toBeDefined()
  // the fork mark: on the leaf's row and on its report title, not on root-less rows
  expect(await ui.find({ type: 'Button', text: /^▶ ↳ Leaf work/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^↳ Leaf work$/ })).toBeDefined()
  // only the leaf's own prompt and reply count
  expect(await ui.find({ type: 'Text', text: /Turns 1 \|/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^Tokens 1k \| In 10 \| Out 1k \| Cache 0$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /Root work/ })).toBeDefined()
  expect(await ui.find({ type: 'Button', text: /Root work/ })).toBeUndefined() // root is not listed (other branch)

  // mid: one fork (leaf), parent root
  await $.ui.scroll({ component: 'Pane', requestId: 'super-resume', offset: 0, by: 1, bodyRows: 36, contentRows: 36, origin: { kind: 'person' } } as any)
  for (let i = 0; i < 300; i++) await Promise.resolve()
  expect(await ui.find({ type: 'Text', text: /^Forks 1 \| Leaf work$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^↳ Root work/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^Chain/ })).toBeUndefined()
  await ui.unmount()
})

test('long text is wrapped to the report column, and noise or a missing title falls back cleanly', async ($, on) => {
  const long = Array.from({ length: 120 }, (_, i) => `**word${i}** \`code\``).join(' ')
  const T = [
    line({ type: 'ai-title', aiTitle: 'fix-the-pane-layout' }),
    line({ type: 'user', timestamp: '2026-11-18T10:00:00Z', cwd: ROOT, gitBranch: 'main', message: { role: 'user', content: '<bash-input> claude attach 7d5871ba</bash-input>' } }),
    line({ type: 'assistant', timestamp: '2026-11-18T10:05:00Z', cwd: ROOT, gitBranch: 'main',
      message: { id: 'a', role: 'assistant', model: 'claude-opus-5-5', usage: { input_tokens: 1 }, content: [{ type: 'text', text: long }] } }),
  ].join('\n')
  on('command.register', () => ({ value: { command: 'super-resume' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.root', () => ({ value: ROOT }))
  on('session.id', () => ({ value: 'current' }))
  on('env.get', (_, e) => ({ value: e.name === 'HOME' ? '/home/me' : undefined }))
  on('process.run', () => ({ value: { exitCode: 0, stdout: 'main\n', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
  on('fs.list', (_, e) => ({
    value: posix(e.path) === `${BASE}/${FOLDER}` ? [{ name: 'aaa.jsonl', kind: 'file', size: 2000, mtimeMs: 2, isLink: false }] : [],
  }))
  on('fs.read', (_, e) => ({ value: posix(e.path).endsWith('/aaa.jsonl') ? T : '' }))

  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
  await $.command.run({ command: 'super-resume', args: 'project', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 160 } })
  const ui = await $.ui.mount({ ...INLINE, props: { ...INLINE.props, scroll: { offset: 0, bodyRows: 40 } }, surface: 'terminal' })

  // the <bash-input> row is noise: the title comes from the ai-title
  expect(await ui.find({ type: 'Text', text: /fix the pane layout/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /bash-input/ })).toBeUndefined()
  // the reply: its end, marked …, no markdown, 6 lines of at most the column's width (160/2 - 4)
  const all = (await ui.findAll({ type: 'Text', text: /word\d+ code/ })).map((n: any) => String(n.text))
  // nested Texts match too: keep the row-level ones (a prefix or the indent)
  const replyLines = all.filter(t => /^(agent › |\s{8})/.test(t))
  expect(replyLines.length).toBe(12)
  expect(replyLines[0]).toMatch(/^agent › …/)
  expect(replyLines.join(' ')).toContain('word119 code')
  expect(replyLines.join(' ')).not.toMatch(/\*\*|`/)
  for (const text of replyLines) expect(text.length).toBeLessThanOrEqual(76)
  expect(await ui.find({ type: 'Text', text: /more · PgDn/ })).toBeUndefined()
  await ui.unmount()

  // shorter, the report scrolls: PgDn a page down, PgUp back, the wheel over it a few rows
  const small = await $.ui.mount({ ...INLINE, surface: 'terminal' })
  expect(await small.find({ type: 'Text', text: /^↓ \d+ more · PgDn$/ })).toBeDefined()
  expect(await small.find({ type: 'Text', text: /more · PgUp/ })).toBeUndefined()
  await $.ui.scroll(key(20) as any)
  await settle()
  // 14 rows inside the border, 12 once the edges count: a page is 11
  expect(await small.find({ type: 'Text', text: /^↑ 11 more · PgUp$/ })).toBeDefined()
  expect(await small.find({ type: 'Text', text: /Reply of|word\d+ code/ })).toBeDefined()
  await $.ui.scroll(key(-20) as any)
  await settle()
  expect(await small.find({ type: 'Text', text: /more · PgUp/ })).toBeUndefined()
  await $.ui.scroll({ ...key(3), pointer: { row: 5, column: 120 } } as any)
  await settle()
  expect(await small.find({ type: 'Text', text: /^↑ 3 more · PgUp$/ })).toBeDefined()
  await small.unmount()
})
