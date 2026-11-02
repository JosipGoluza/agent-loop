import { expect, test } from 'claude-code/testing'

const PANE = {
  plugin: 'agent-loop-panel',
  component: 'Pane',
  requestId: 'agent-loop',
  props: {
    title: 'agent-loop',
    isFocused: false,
    bodyColumns: 120,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 30 },
    view: {},
  },
} as const

const BAND = (maxRows: number) => ({
  plugin: 'agent-loop-panel',
  component: 'AbovePrompt',
  props: { hasSurvey: false, isWorking: false, maxRows, bodyColumns: 120, scroll: { offset: 0, bodyRows: maxRows }, view: {} },
}) as const

const STATE = '/repo/.git/agent-loop'
const RUN = `${STATE}/runs/20261027-113232`
const NOW = Date.parse('2026-10-27T11:40:00')

// A run mid-build: #824 has three reviewers running, #825 shipped ready, #826 was deferred.
const FILES: Record<string, string> = {
  [`${RUN}/run.json`]: JSON.stringify({
    id: '20261027-113232',
    started: '2026-10-27T11:32:32',
    finished: null,
    agents: { default: 'claude', review: 'codex' },
    prepared: [{ id: '824' }, { id: '825' }, { id: '826' }],
    tickets: {
      '824': { ref: '#824', name: 'Show runs without reading their payload', stage: 'review-spec', rounds: 1, risk: 'high' },
      '825': { ref: '#825', name: 'Filter runs', stage: 'done', status: 'ready' },
      '826': { ref: '#826', name: 'Export runs', stage: 'done', status: 'deferred', why: 'overlaps #824 on runs.ts' },
    },
  }),
  [`${RUN}/log.txt`]: '2026-10-27T11:39:58 #824 review-spec (codex)\n2026-10-27T11:39:58 #824 review-correctness (codex)\n',
}
const LISTING = [
  '824.plan.prompt.md', '824.plan.json', '824.implement.prompt.md', '824.implement.json',
  '824.review-spec.prompt.md', '824.review-correctness.prompt.md', '824.review-standards.prompt.md',
  '824.review-standards.json', '825.implement.prompt.md', '825.implement.json', 'run.json', 'log.txt',
].map(name => ({ name, kind: 'file', size: 1, mtimeMs: NOW, isLink: false }))

function project(on: any) {
  on('session.root', () => ({ value: '/repo' }))
  on('process.run', () => ({ value: { exitCode: 0, stdout: '/repo/.git\n', stderr: '' } }))
  on('clock.now', () => ({ value: NOW }))
  on('clock.every', () => ({ value: undefined }))
  on('command.register', () => ({ value: { command: 'agent-loop-panel' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.status', () => ({ value: undefined }))
  on('fs.exists', (_: unknown, e: any) => ({ value: e.path === `${STATE}/config.json` || e.path === `${STATE}/runs` }))
  on('fs.list', (_: unknown, e: any) =>
    ({ value: e.path === `${STATE}/runs` ? [{ name: '20261027-113232', kind: 'dir', size: 0, mtimeMs: NOW, isLink: false }] : LISTING }))
  on('fs.stat', () => ({ value: { kind: 'file', size: 1, mtimeMs: NOW - 2000, isLink: false } }))
  on('fs.read', (_: unknown, e: any) => (e.path in FILES ? { value: FILES[e.path] } : { deny: 'ENOENT' }))
  on('session.start', (_: unknown, e: any) => ({ cwd: e.cwd }))
}

test('the pane shows the phases and each ticket of the newest run', async ($, on) => {
  project(on)
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })

  expect((await ui.find({ type: 'Text', text: /run 20261027-113232/ }))?.text).toMatch(/running/)
  expect((await ui.find({ type: 'Text', text: /Plan/ }))?.text).toMatch(/3\/3/)
  expect((await ui.find({ type: 'Text', text: /Build/ }))?.text).toMatch(/2\/2/)   // #824 has moved on to review
  expect((await ui.find({ type: 'Text', text: /Review/ }))?.text).toMatch(/1\/2/)
  expect((await ui.find({ type: 'Text', text: /Handoff/ }))?.text).toMatch(/1\/2/)
  const busy = await ui.find({ type: 'Text', text: /#824/ })
  expect(busy?.text).toMatch(/review-correctness, review-spec/) // the reviewers still running, not the finished one
  expect(busy?.text).toMatch(/1 fix round/)
  expect(busy?.text).toMatch(/high risk/)
  expect((await ui.find({ type: 'Text', text: /#826/ }))?.text).toMatch(/overlaps #824 on runs.ts/)
  await ui.unmount()
})

test('without a run the pane says so', async ($, on) => {
  on('session.root', () => ({ value: '/elsewhere' }))
  on('process.run', () => ({ value: { exitCode: 128, stdout: '', stderr: 'not a git repository' } }))
  on('fs.exists', () => ({ value: false }))
  on('clock.every', () => ({ value: undefined }))
  on('command.register', () => ({ value: { command: 'agent-loop-panel' } }))
  on('ui.status', () => ({ value: undefined }))
  on('session.start', (_: unknown, e: any) => ({ cwd: e.cwd }))
  await $.session.start({ cwd: '/elsewhere', surface: 'terminal', isInteractive: true })

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await ui.find({ type: 'Text' }))?.text).toBe('No agent-loop run in this project yet.')
  await ui.unmount()
})

test('the band above the prompt shows the run, one line per ticket', async ($, on) => {
  project(on)
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  const band = await $.ui.mount({ ...BAND(8), surface: 'terminal' })

  const header = await band.find({ type: 'Text', text: /agent-loop/ })
  expect(header?.text).toMatch(/running · 7m28s · Plan 3\/3  Build 2\/2  Review 1\/2  Handoff 1\/2/)
  expect((await band.find({ type: 'Text', text: /#824/ }))?.text).toMatch(/review-correctness, review-spec · 1 fix round · high risk/)
  expect((await band.find({ type: 'Text', text: /#825/ }))?.text).toMatch(/✔ #825 Filter runs · ready/)
  await band.unmount()
})

test('a short band keeps the header and counts the rest', async ($, on) => {
  project(on)
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  const band = await $.ui.mount({ ...BAND(3), surface: 'terminal' })

  expect((await band.find({ type: 'Text', text: /#824/ }))?.text).toMatch(/#824/)
  expect((await band.find({ type: 'Text', text: /^\+[0-9]+ more$/ }))?.text).toBe('+2 more')
  await band.unmount()
})

test('without a run the band makes way', async ($, on) => {
  on('session.root', () => ({ value: '/elsewhere' }))
  on('process.run', () => ({ value: { exitCode: 128, stdout: '', stderr: '' } }))
  on('fs.exists', () => ({ value: false }))
  on('clock.every', () => ({ value: undefined }))
  on('clock.now', () => ({ value: NOW }))
  on('command.register', () => ({ value: { command: 'agent-loop-panel' } }))
  on('session.start', (_: unknown, e: any) => ({ cwd: e.cwd }))
  on('ui.render', ($: any, e: any) => {
    const { Text } = $.ui.resolve(e)
    return <Text>engine band</Text>
  })
  await $.session.start({ cwd: '/elsewhere', surface: 'terminal', isInteractive: true })

  const band = await $.ui.mount({ ...BAND(8), surface: 'terminal' })
  expect((await band.find({ type: 'Text' }))?.text).toBe('engine band')
  await band.unmount()
})

// A Workflow run mid-build: the planner finished, #824's builder is editing, a reviewer of #825 just started.
const WF = '/home/.claude/projects/x/session/subagents/workflows/wf_1'
const WF_RUN = `${STATE}/runs/20261102-090000`
const line = (content: unknown[]) => JSON.stringify({ type: 'assistant', message: { content } })
const TRANSCRIPTS: Record<string, { label: string; phase: string; mtimeMs: number; tail: string }> = {
  'agent-a1': { label: 'plan:#824', phase: 'Plan', mtimeMs: NOW - 600000,
    tail: 'partial line…\n' + line([{ type: 'tool_use', name: 'StructuredOutput', input: {} }]) },
  'agent-a2': { label: 'build:#824', phase: 'Build', mtimeMs: NOW - 20000,
    tail: 'cut\n' + line([{ type: 'tool_use', name: 'Bash', input: { command: 'cd /w/824 && make check' } }]) + '\n' +
      line([{ type: 'text', text: 'Now the endpoint.' }, { type: 'tool_use', name: 'Edit', input: { file_path: '/w/824/app/runs.py' } }]) },
  'agent-a3': { label: 'spec:#825', phase: 'Review', mtimeMs: NOW - 5000, tail: 'cut\n' },
}

function workflowProject(on: any) {
  on('session.root', () => ({ value: '/repo' }))
  on('process.run', (_: unknown, e: any) => {
    const argv: string[] = e.argv
    if (argv[0] === 'tail') {
      const name = /(agent-[^/.]+)\.jsonl$/.exec(argv[argv.length - 1] ?? '')?.[1] ?? ''
      return { value: { exitCode: 0, stdout: TRANSCRIPTS[name]?.tail ?? '', stderr: '' } }
    }
    if (argv.includes('--shortstat')) return { value: { exitCode: 0, stdout: ' 3 files changed, 120 insertions(+), 4 deletions(-)\n', stderr: '' } }
    if (argv.includes('ls-files')) return { value: { exitCode: 0, stdout: 'app/new.py\n', stderr: '' } }
    return { value: { exitCode: 0, stdout: '/repo/.git\n', stderr: '' } }
  })
  on('clock.now', () => ({ value: NOW }))
  on('clock.every', () => ({ value: undefined }))
  on('command.register', () => ({ value: { command: 'agent-loop-panel' } }))
  on('fs.exists', (_: unknown, e: any) => ({ value: e.path === `${STATE}/config.json` || e.path === `${STATE}/runs` }))
  on('fs.list', (_: unknown, e: any) => {
    if (e.path === `${STATE}/runs`) return { value: [{ name: '20261102-090000', kind: 'dir', size: 0, mtimeMs: NOW, isLink: false }] }
    if (e.path === WF) {
      return { value: Object.entries(TRANSCRIPTS).flatMap(([name, a]) => [
        { name: `${name}.jsonl`, kind: 'file', size: 1, mtimeMs: a.mtimeMs, isLink: false },
        { name: `${name}.meta.json`, kind: 'file', size: 1, mtimeMs: a.mtimeMs, isLink: false },
      ]) }
    }
    return { value: [{ name: 'run.json', kind: 'file', size: 1, mtimeMs: NOW - 600000, isLink: false }] }
  })
  on('fs.stat', () => ({ value: { kind: 'file', size: 1, mtimeMs: NOW - 600000, isLink: false } }))
  on('fs.read', (_: unknown, e: any) => {
    if (e.path === `${WF_RUN}/run.json`) {
      return { value: JSON.stringify({
        id: '20261102-090000', started: '2026-10-27T11:30:00', finished: null, engine: 'workflow',
        workflow: { id: 'wf_1', transcripts: WF },
        prepared: [{ id: '824', ref: '#824', worktree: '/w/824' }, { id: '825', ref: '#825', worktree: '/w/825' }],
        tickets: { '824': { ref: '#824', name: 'Show runs', stage: 'queued' }, '825': { ref: '#825', name: 'Filter runs', stage: 'queued' } },
      }) }
    }
    const meta = /(agent-[^/.]+)\.meta\.json$/.exec(e.path)?.[1]
    if (meta && TRANSCRIPTS[meta]) {
      return { value: JSON.stringify({ description: TRANSCRIPTS[meta].label, workflowPhase: TRANSCRIPTS[meta].phase }) }
    }
    return { deny: 'ENOENT' }
  })
  on('session.start', (_: unknown, e: any) => ({ cwd: e.cwd }))
}

test('a Workflow run shows what each agent does now, from its transcript', async ($, on) => {
  workflowProject(on)
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  const band = await $.ui.mount({ ...BAND(8), surface: 'terminal' })

  // a 10-minute build with a fresh transcript write is running, not "stalled"
  expect((await band.find({ type: 'Text', text: /agent-loop/ }))?.text).toMatch(/running · 10m00s · Plan 2\/2  Build 1\/2  Review 0\/2/)
  expect((await band.find({ type: 'Text', text: /#824/ }))?.text).toMatch(/#824 Show runs · build · Edit runs\.py · 20s ago · 3 files \+120 −4, 1 new/)
  expect((await band.find({ type: 'Text', text: /#825/ }))?.text).toMatch(/#825 Filter runs · spec · starting · 5s ago/)
  await band.unmount()
})
