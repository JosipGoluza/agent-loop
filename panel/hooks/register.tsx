import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { PhaseCount, Snapshot, TicketRow } from '../types'

// A live view of the newest agent-loop run in this project. It only reads files:
// - the Python runner writes <state>/runs/<id>/run.json, one <ticket>.<label>.prompt.md
//   per agent call it starts, <ticket>.<label>.json when that call finishes, and log.txt;
// - a Claude Code Workflow run has run.json too, and `wf attach` records the folder where
//   Claude Code keeps each agent's transcript (agent-<id>.jsonl, and agent-<id>.meta.json
//   with its label and phase). The last tool call in a transcript says what the agent is
//   doing now, at no token cost.

const PANE = 'agent-loop'
const POLL_MS = 3000
const TAIL_BYTES = 60000 // enough for the last few tool calls; $.fs.read refuses files over 4 MiB
const STALLED_MS = 15 * 60 * 1000 // no write for this long, and not finished: probably stopped
const BAND_AFTER_MS = 30 * 60 * 1000 // the band shows a finished run this long, then makes way
const PHASES = ['Plan', 'Build', 'Review', 'Handoff'] as const

// Change the tag when Snapshot changes shape: it declines what an earlier version stored.
const snapshot = atom({ plugin: 'agent-loop-panel', key: 'snapshot' } as const, null, { shape: 'snapshot-2' })

let stateDir: string | null | undefined // undefined: not looked up yet; null: no agent-loop project here

type Run = {
  id?: string
  started?: string
  created?: string
  finished?: string | null
  agents?: Record<string, string | null>
  prepared?: { id: string; ref?: string; worktree?: string }[]
  engine?: string
  workflow?: { id?: string; transcripts?: string }
  tickets?: Record<string, { ref?: string; name?: string; stage?: string; status?: string; rounds?: number; risk?: string; why?: string }>
}

type Agent = { label: string; phase: string; ref: string; mtimeMs: number; isDone: boolean; action: string }
const metas = new Map<string, { label: string; phase: string }>() // agent file name -> label and phase; they never change
const agents = new Map<string, Agent>() // agent file name -> what its transcript said at mtimeMs

const base = (path: string) => path.split('/').pop() ?? path

function describe(tool: string, input: Record<string, unknown>): string {
  const text = (v: unknown) => (typeof v === 'string' ? v : '')
  if (text(input.file_path)) return `${tool} ${base(text(input.file_path))}`
  if (tool === 'Bash') {
    const cmd = text(input.command).replace(/^cd \S+ && /, '').split('\n')[0] ?? ''
    return `$ ${cmd.length > 48 ? cmd.slice(0, 47) + '…' : cmd}`
  }
  if (text(input.pattern)) return `${tool} ${text(input.pattern)}`
  return tool
}

// The last tool call in a transcript's tail, or done once the agent returned its result.
function lastAction(tail: string): { isDone: boolean; action: string } {
  const lines = tail.split('\n').slice(1) // the first line may be cut
  for (let i = lines.length - 1; i >= 0; i--) {
    let entry: { type?: string; message?: { content?: { type?: string; name?: string; input?: Record<string, unknown> }[] } }
    try {
      entry = JSON.parse(lines[i] ?? '')
    } catch {
      continue
    }
    if (entry.type !== 'assistant') continue
    const uses = (entry.message?.content ?? []).filter(c => c.type === 'tool_use')
    const use = uses[uses.length - 1]
    if (!use?.name) continue
    if (use.name === 'StructuredOutput') return { isDone: true, action: 'done' }
    return { isDone: false, action: describe(use.name, use.input ?? {}) }
  }
  return { isDone: false, action: 'starting' }
}

async function workflowAgents($: EngineInterface, dir: string): Promise<Agent[]> {
  const out: Agent[] = []
  for (const entry of await $.fs.list(dir).catch(() => [])) {
    const name = /^(agent-[^.]+)\.jsonl$/.exec(entry.name)?.[1]
    if (!name) continue
    let meta = metas.get(name)
    if (!meta) {
      try {
        const m = JSON.parse(await $.fs.read(`${dir}/${name}.meta.json`))
        meta = { label: String(m.description ?? ''), phase: String(m.workflowPhase ?? '') }
        metas.set(name, meta)
      } catch {
        continue // written a moment after the transcript; the next poll has it
      }
    }
    const known = agents.get(name)
    if (known && (known.isDone || known.mtimeMs === entry.mtimeMs)) {
      out.push(known)
      continue
    }
    const tail = await $.process.run(['tail', '-c', String(TAIL_BYTES), `${dir}/${entry.name}`])
    const ref = /:([^·\s]+)/.exec(meta.label)?.[1] ?? ''
    const agent = { ...meta, ref, mtimeMs: entry.mtimeMs, ...lastAction(tail.exitCode === 0 ? tail.stdout : '') }
    agents.set(name, agent)
    out.push(agent)
  }
  return out
}

// How big the ticket's change is so far, staged or not, and the files it added.
async function diffSize($: EngineInterface, worktree: string): Promise<string> {
  const stat = await $.process.run(['git', '-C', worktree, 'diff', 'HEAD', '--shortstat'])
  const added = await $.process.run(['git', '-C', worktree, 'ls-files', '--others', '--exclude-standard'])
  const m = /(\d+) files? changed(?:, (\d+) insertions?\(\+\))?(?:, (\d+) deletions?\(-\))?/.exec(stat.stdout)
  const fresh = added.exitCode === 0 ? added.stdout.split('\n').filter(Boolean).length : 0
  const parts = m ? [`${m[1]} file${m[1] === '1' ? '' : 's'} +${m[2] ?? 0} −${m[3] ?? 0}`] : []
  if (fresh) parts.push(`${fresh} new`)
  return parts.join(', ')
}

const PHASE_OF = { Plan: 'Plan', Build: 'Build', Review: 'Review', Handoff: 'Handoff' } as const

const parent = (dir: string) => dir.replace(/\/[^/]+\/?$/, '') || '/'

async function findStateDir($: EngineInterface): Promise<string | null> {
  const root: string = await $.session.root()
  for (let dir = root; ; dir = parent(dir)) {
    if (await $.fs.exists(`${dir}/.agent-loop/config.json`)) return `${dir}/.agent-loop`
    if (dir === '/' || dir === parent(dir)) break
  }
  const git = await $.process.run(['git', '-C', root, 'rev-parse', '--path-format=absolute', '--git-common-dir'])
  const common = git.exitCode === 0 ? git.stdout.trim() : ''
  if (common && (await $.fs.exists(`${common}/agent-loop/config.json`))) return `${common}/agent-loop`
  return null
}

function phaseOf(stage: string): TicketRow['phase'] {
  if (stage === 'done' || stage === 'planned') return 'Done'
  if (stage === 'queued' || stage === 'plan') return 'Plan'
  if (stage === 'implement' || stage.startsWith('fix')) return 'Build'
  if (stage === 'handoff') return 'Handoff'
  return 'Review' // review*, verify*, checks
}

async function load($: EngineInterface): Promise<Snapshot | null> {
  if (stateDir === undefined) stateDir = await findStateDir($)
  if (!stateDir) return null
  const runsDir = `${stateDir}/runs`
  if (!(await $.fs.exists(runsDir))) return null

  // The newest run: the run.json written last.
  let newest: { name: string; mtimeMs: number } | undefined
  for (const entry of await $.fs.list(runsDir)) {
    if (entry.kind !== 'dir') continue
    const stat = await $.fs.stat(`${runsDir}/${entry.name}/run.json`).catch(() => undefined)
    if (stat && (!newest || stat.mtimeMs > newest.mtimeMs)) newest = { name: entry.name, mtimeMs: stat.mtimeMs }
  }
  if (!newest) return null
  const dir = `${runsDir}/${newest.name}`
  let run: Run
  try {
    run = JSON.parse(await $.fs.read(`${dir}/run.json`))
  } catch {
    return null // caught mid-write on an old runner; the next poll reads it
  }

  // Agent calls started but not finished: a prompt without its result.
  const files = new Set((await $.fs.list(dir)).map(e => e.name))
  const running = new Map<string, string[]>()
  for (const name of files) {
    const [, ticket, label] = /^([^.]+)\.(.+)\.prompt\.md$/.exec(name) ?? []
    if (ticket && label && !files.has(`${ticket}.${label}.json`)) running.set(ticket, [...(running.get(ticket) ?? []), label])
  }

  const order = (run.prepared ?? []).map(t => t.id)
  const ids = [...order, ...Object.keys(run.tickets ?? {}).filter(id => !order.includes(id))]
  const tickets: TicketRow[] = ids.map(id => {
    const t = run.tickets?.[id] ?? {}
    const stage = t.stage ?? 'queued'
    return {
      id,
      ref: t.ref ?? `#${id}`,
      name: t.name ?? '',
      phase: phaseOf(stage),
      stage,
      status: t.status ?? '',
      rounds: t.rounds ?? 0,
      risk: t.risk === 'high' ? 'high' : 'normal',
      why: t.why ?? '',
      running: (running.get(id) ?? []).sort(),
      action: '',
      diff: '',
    }
  })

  // A Workflow run: what its agents are doing, from their transcripts.
  let activityMs = newest.mtimeMs
  if (run.engine === 'workflow' && run.workflow?.transcripts) {
    const all = await workflowAgents($, run.workflow.transcripts)
    activityMs = Math.max(activityMs, ...all.map(a => a.mtimeMs))
    const now = await $.clock.now()
    for (const t of tickets) {
      const mine = all.filter(a => a.ref === t.ref).sort((a, b) => a.mtimeMs - b.mtimeMs)
      const busy = mine.filter(a => !a.isDone)
      const latest = busy[busy.length - 1]
      if (t.phase !== 'Done' && mine.length) {
        const phase = (latest ?? mine[mine.length - 1])?.phase as keyof typeof PHASE_OF
        t.phase = PHASE_OF[phase] ?? t.phase
        t.stage = (latest ?? mine[mine.length - 1])?.label.split(':')[0] ?? t.stage
      }
      t.running = busy.map(a => a.label.split(':')[0] ?? a.label)
      if (latest) t.action = `${latest.action} · ${minutes(now - latest.mtimeMs)} ago`
      const worktree = run.prepared?.find(p => p.id === t.id)?.worktree
      if (worktree && t.phase !== 'Done' && t.phase !== 'Plan') t.diff = await diffSize($, worktree)
    }
  }

  // A ticket is in the batch once its implementer started; the later phases count only those.
  const built = tickets.filter(t => files.has(`${t.id}.implement.prompt.md`) || (t.phase !== 'Plan' && t.status !== 'deferred'))
  const past = (t: TicketRow, phase: (typeof PHASES)[number]) =>
    t.phase === 'Done' || PHASES.indexOf(t.phase as (typeof PHASES)[number]) > PHASES.indexOf(phase)
  const phases: PhaseCount[] = PHASES.map(name => {
    const pool = name === 'Plan' ? tickets : built
    return { name, done: pool.filter(t => past(t, name)).length, total: pool.length }
  })

  const log = (await $.fs.read(`${dir}/log.txt`).catch(() => ''))
    .split('\n')
    .filter(Boolean)
    .slice(-4)
    .map(line => line.replace(/^\d{4}-\d\d-\d\dT/, ''))
  const tools = Object.entries(run.agents ?? {})
    .filter(([, tool]) => tool)
    .map(([stage, tool]) => `${stage}=${tool}`)
    .join(' ')
  const now = await $.clock.now()
  const started = Date.parse(run.started ?? run.created ?? '') || newest.mtimeMs

  return {
    runId: run.id ?? newest.name,
    state: run.finished ? 'finished' : now - activityMs > STALLED_MS ? 'stalled' : 'running',
    startedMs: started,
    updatedMs: run.finished ? Date.parse(run.finished) || newest.mtimeMs : now,
    tools,
    phases,
    tickets,
    log,
  }
}

const minutes = (ms: number) => {
  const s = Math.max(0, Math.round(ms / 1000))
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s`
}

async function tick($: EngineInterface) {
  const next = await load($)
  const before = await read($, snapshot)
  if (JSON.stringify(before) !== JSON.stringify(next)) await update($, snapshot, () => next)
}

// --- drawing, shared by the band and the pane ---------------------------------

const icon = (t: TicketRow) =>
  t.status === 'ready' || t.status === 'planned' ? '✔' : t.status === 'needs-human' ? '✖' : t.status === 'deferred' ? '↷' : '●'
const tone = (t: TicketRow) =>
  t.status === 'ready' || t.status === 'planned' ? 'success' : t.status === 'needs-human' ? 'error' : t.status === 'deferred' ? 'warning' : 'suggestion'
const detail = (t: TicketRow) =>
  (t.phase === 'Done' ? t.why || t.status : t.running.length ? t.running.join(', ') : t.stage) +
  (t.phase !== 'Done' && t.action ? ` · ${t.action}` : '') +
  (t.diff ? ` · ${t.diff}` : '') +
  (t.rounds ? ` · ${t.rounds} fix round${t.rounds > 1 ? 's' : ''}` : '')
const stateLabel = { running: 'running', finished: 'finished', stalled: 'no progress for 15 min (stopped?)' } as const
const stateColor = { running: 'suggestion', finished: 'success', stalled: 'warning' } as const

async function elapsed($: EngineInterface, s: Snapshot) {
  return minutes((s.state === 'running' ? await $.clock.now() : s.updatedMs) - s.startedMs)
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'agent-loop-panel', description: 'Show the live progress of the agent-loop run' })
    stateDir = undefined
    await tick($)
    $.clock.every(POLL_MS, () => void tick($))
    return next(e)
  })

  on('command.run', { command: 'agent-loop-panel' }, async $ => {
    stateDir = undefined // the session may have moved into a project since it started
    await tick($)
    const opened = await $.ui.open({ id: PANE, title: 'agent-loop', closeOnEscape: true })
    if (!(await read($, snapshot))) return { text: 'No agent-loop run in this project yet. The pane updates when one starts.' }
    return { text: opened.isPlaced ? 'agent-loop pane opened.' : 'agent-loop pane is waiting for a wider terminal.' }
  })

  // The band above the prompt: compact, at the bottom in every layout.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const s = await read($, snapshot)
    const now = await $.clock.now()
    const isRecent = s !== null && (s.state !== 'finished' || now - s.updatedMs < BAND_AFTER_MS)
    if (!s || !isRecent || e.props.hasSurvey) return next(e)

    const { Box, Text } = $.ui.resolve(e)
    const rows = Math.max(1, e.props.maxRows - 1) // one for the header
    const shown = s.tickets.length > rows ? s.tickets.slice(0, rows - 1) : s.tickets
    const phases = s.phases.map(p => `${p.name} ${p.done}/${p.total}`).join('  ')

    return (
      <Box flexDirection="column">
        <Text wrap="truncate-end">
          <Text bold>agent-loop</Text>
          <Text color={stateColor[s.state]}> {stateLabel[s.state]}</Text>
          <Text dimColor> · {await elapsed($, s)} · {phases} · /agent-loop-panel for more</Text>
        </Text>
        {shown.map(t => (
          <Text wrap="truncate-end">
            <Text color={tone(t)}>{icon(t)} </Text>
            <Text bold>{t.ref}</Text>
            <Text> {t.name} </Text>
            <Text dimColor>· {detail(t)}</Text>
            {t.risk === 'high' && <Text color="warning"> · high risk</Text>}
          </Text>
        ))}
        {shown.length < s.tickets.length && <Text dimColor>+{s.tickets.length - shown.length} more</Text>}
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    const s = await read($, snapshot)
    if (!s) return <Text dimColor>No agent-loop run in this project yet.</Text>
    const took = await elapsed($, s)

    return (
      <Box flexDirection="column">
        <Text>
          <Text bold>run {s.runId}</Text>
          <Text color={stateColor[s.state]}> · {stateLabel[s.state]}</Text>
          <Text dimColor> · {took}{s.tools ? ` · ${s.tools}` : ''}</Text>
        </Text>
        <Box flexDirection="row" marginTop={1}>
          <Box flexDirection="column" width={18} borderStyle="round" borderDimColor paddingX={1}>
            <Text bold>Phases</Text>
            {s.phases.map(p => {
              const isDone = p.total > 0 && p.done === p.total
              const isNow = !isDone && s.tickets.some(t => t.phase === p.name)
              return (
                <Text color={isDone ? 'success' : isNow ? 'suggestion' : undefined} dimColor={!isDone && !isNow}>
                  {isDone ? '✔' : isNow ? '›' : ' '} {p.name.padEnd(8)}
                  {p.done}/{p.total}
                </Text>
              )
            })}
          </Box>
          <Box flexDirection="column" flexGrow={1} borderStyle="round" borderDimColor paddingX={1}>
            <Text bold>Tickets · {s.tickets.length}</Text>
            {s.tickets.map(t => (
              <Text wrap="truncate-end">
                <Text color={tone(t)}>{icon(t)} </Text>
                <Text bold>{t.ref}</Text>
                <Text> {t.name} </Text>
                <Text dimColor>· {detail(t)}</Text>
                {t.risk === 'high' && <Text color="warning"> · high risk</Text>}
              </Text>
            ))}
          </Box>
        </Box>
        {s.log.map(line => (
          <Text dimColor wrap="truncate-end">
            {line}
          </Text>
        ))}
      </Box>
    )
  })
}
