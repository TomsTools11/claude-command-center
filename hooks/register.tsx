import { atom, read, update } from 'claude-code'
import type { Color, EngineInterface, Register, RenderChildren, ToolCallResult, SessionContextUsage, SessionRateLimit, ToolCallInput } from 'claude-code'

import type { AgentCard, AgentDetail, AppState, Approval, BackgroundJob, CallStats, PlanStep, Shortcut, SideQuestion, Usage } from '../types'

const PANE = 'command-center'
const TITLE = 'Command Center'

const usage = atom({ plugin: 'command-center', key: 'usage' } as const, { limits: [] })
const background = atom({ plugin: 'command-center', key: 'background' } as const, [])
const side = atom({ plugin: 'command-center', key: 'side' } as const, [])
const agents = atom({ plugin: 'command-center', key: 'agents' } as const, [])
const activity = atom({ plugin: 'command-center', key: 'activity' } as const, {})
const expanded = atom({ plugin: 'command-center', key: 'expanded' } as const, {})
const approvals = atom({ plugin: 'command-center', key: 'approvals' } as const, [])
const session = atom({ plugin: 'command-center', key: 'session' } as const, { isWorking: false, isCompacting: false, tick: 0 })
const shortcuts = atom({ plugin: 'command-center', key: 'shortcuts' } as const, [])
const plan = atom({ plugin: 'command-center', key: 'plan' } as const, { steps: [] })
const collapsed = atom({ plugin: 'command-center', key: 'collapsed' } as const, {})
const layout = atom({ plugin: 'command-center', key: 'layout' } as const, { order: [], isArranging: false })

// The movable cards, top to bottom by default. Approvals is not among them: it always
// sits at the top while something waits.
const CARD_ORDER = ['plan', 'actions', 'context', 'side', 'shortcuts', 'background', 'agents', 'activity'] as const
const app = atom({ plugin: 'command-center', key: 'app' } as const, { isAvailable: false, groups: [], isConfirmingArchive: false, isNamingGroup: false })
const calls = atom({ plugin: 'command-center', key: 'calls' } as const, { total: 0, failed: 0, byTool: {}, recent: [], failures: [] })

// The commands the Shortcuts card offers, by the name typed after the slash (any
// plugin prefix is found at load). The extras show when the pane is wide enough.
const SHORTCUTS: readonly { name: string; label: string; isExtra?: true }[] = [
  { name: 'market-research-reports', label: 'Market research' },
  { name: 'goal-client-report', label: 'Client report' },
  { name: 'prompt-engineering-expert', label: 'Prompt expert' },
  { name: 'goal-initial-onboarding', label: 'Onboarding' },
  { name: 'design-taste-frontend', label: 'Design taste', isExtra: true },
  { name: 'disposition-import', label: 'Dispositions', isExtra: true },
  { name: 'research-company', label: 'Research company', isExtra: true },
]
const EXTRAS_MIN_COLUMNS = 48

const MODELS = [
  { value: 'opus', label: 'Opus 5.5' },
  { value: 'sonnet', label: 'Sonnet 5.5' },
  { value: 'haiku', label: 'Haiku 5.5' },
  { value: 'fable', label: 'Fable 5.1' },
] as const

const ACTIVITY_MINUTES = 20

type Choice = 'allow' | 'deny' | 'dialog'

// Pending approvals' resolvers and the tool calls they belong to. Functions cannot
// live in $.state, so these are the module's own and start over on a reload.
const waiting = new Map<string, (choice: Choice) => void>()
const callKeys = new Map<string, string>()

// What each Agent call asked for, by its description, until the agent it started is listed.
const briefs = new Map<string, { prompt: string; model?: string; effort?: string; isBackground: boolean }>()
const RECENT_AGENT_CALLS = 8

// ---- helpers ---------------------------------------------------------------

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : 1))
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stable(v)}`).join(',')}}`
  }
  return JSON.stringify(value) ?? 'undefined'
}

const ENVELOPE = new Set(['tool', 'tool_use_id', 'agentId', 'requestMeta', 'consent'])

function callKey(tool: string, input: unknown): string {
  const args = Object.fromEntries(
    Object.entries((input ?? {}) as Record<string, unknown>).filter(([k]) => !ENVELOPE.has(k)),
  )
  return `${tool}:${stable(args)}`
}

function clip(text: string, max: number): string {
  const line = (text.split('\n')[0] ?? '').trim()
  return line.length > max ? `${line.slice(0, max - 1)}…` : line
}

// Longer text, kept to its first `max` characters with its line breaks.
function clipBlock(text: string, max: number): string {
  const t = text.trim()
  return t.length > max ? `${t.slice(0, max - 1).trimEnd()}…` : t
}

function shortPath(path: string): string {
  const parts = path.split('/').filter(Boolean)
  return parts.length <= 2 ? path : `…/${parts.slice(-2).join('/')}`
}

// One line saying what a tool call is about.
function describe(tool: string, input: unknown): string {
  const i = (input ?? {}) as Record<string, unknown>
  const str = (k: string) => (typeof i[k] === 'string' ? (i[k] as string) : undefined)
  const path = str('file_path') ?? str('notebook_path') ?? str('path')
  if (path) return `${tool} ${shortPath(path)}`
  if (str('command')) return `${tool}: ${clip(str('command')!, 70)}`
  if (str('url')) return `${tool} ${clip(str('url')!, 60)}`
  if (str('pattern')) return `${tool} ${clip(str('pattern')!, 50)}`
  if (str('description')) return `${tool}: ${clip(str('description')!, 60)}`
  const short = tool.startsWith('mcp__') ? tool.split('__').slice(1).join(' › ') : tool
  return short
}

function toUsage(context: SessionContextUsage, limits: readonly SessionRateLimit[]): Usage {
  return {
    context: { percent: context.percent, tokens: context.tokens, window: context.window },
    limits: limits.map(l => ({ kind: l.kind, percentUsed: l.percentUsed, resetsAt: l.resetsAt })),
  }
}

function contextPercent(u: Usage): number | undefined {
  const c = u.context
  if (!c) return undefined
  if (c.percent !== undefined) return c.percent
  return c.tokens !== undefined && c.window > 0 ? (c.tokens / c.window) * 100 : undefined
}

function bar(pct: number | undefined, width = 14): string {
  if (pct === undefined) return '░'.repeat(width)
  const filled = Math.round((Math.max(0, Math.min(100, pct)) / 100) * width)
  return '█'.repeat(filled) + '░'.repeat(width - filled)
}

function levelColor(pct: number | undefined): Color | undefined {
  if (pct === undefined) return undefined
  return pct >= 90 ? 'error' : pct >= 70 ? 'warning' : '#349FFD'
}

const CARD_FILL = 'rgba(255, 255, 255, 0.08)'

const LEVEL_HEX = { ok: '#349FFD', warn: '#F5A524', high: '#E5484D' } as const

// One context meter for surfaces that draw SVG: label, value and a rounded pill bar.
function meterSvg(label: string, pct: number | undefined): string {
  const w = 300
  const fill = pct === undefined ? 0 : (Math.max(0, Math.min(100, pct)) / 100) * w
  const hex = pct === undefined ? LEVEL_HEX.ok : pct >= 90 ? LEVEL_HEX.high : pct >= 70 ? LEVEL_HEX.warn : LEVEL_HEX.ok
  const value = pct === undefined ? '—' : `${Math.round(pct)}%`
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="34" viewBox="0 0 ${w} 34">` +
    '<style>.l{fill:#5f5e5a}.v{fill:#1f1e1c}.k{fill:#1f1e1c;fill-opacity:.08}' +
    '@media (prefers-color-scheme: dark){.l{fill:#a6a49c}.v{fill:#f2f1ec}.k{fill:#ffffff;fill-opacity:.1}}</style>' +
    `<text class="l" x="0" y="12" font-family="system-ui,-apple-system,sans-serif" font-size="12">${label}</text>` +
    `<text class="v" x="${w}" y="12" text-anchor="end" font-family="system-ui,-apple-system,sans-serif" font-size="12" font-weight="600">${value}</text>` +
    `<rect class="k" x="0" y="22" width="${w}" height="8" rx="4"/>` +
    (fill > 0 ? `<rect x="0" y="22" width="${Math.max(8, fill).toFixed(1)}" height="8" rx="4" fill="${hex}"/>` : '') +
    '</svg>'
  )
}

function levelHex(pct: number | undefined): string {
  return pct === undefined ? LEVEL_HEX.ok : pct >= 90 ? LEVEL_HEX.high : pct >= 70 ? LEVEL_HEX.warn : LEVEL_HEX.ok
}

// The minimized Context card: one ring per figure, its percentage in the centre and
// its name beneath.
// One ring's box in CSS pixels. Each Svg element is given this size outright: left to
// itself, the desktop stretches a drawing to the card's width.
const RING_BOX = { width: 48, height: 56 } as const

// A ring of the minimized Context card: its percentage in the centre, its name beneath.
// About 35px across: radius 15.6, a 3.6px stroke.
function usageRingSvg(label: string, pct: number | undefined): string {
  const { width: w, height: h } = RING_BOX
  const r = 15.6
  const stroke = 3.6
  const cx = w / 2
  const cy = 20
  const c = 2 * Math.PI * r
  const dash = ((Math.max(0, Math.min(100, pct ?? 0)) / 100) * c).toFixed(2)
  const value = pct === undefined ? '—' : `${Math.round(pct)}%`
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">` +
    '<style>.l{fill:#5f5e5a}.v{fill:#1f1e1c}.k{stroke:#1f1e1c;stroke-opacity:.1}' +
    '@media (prefers-color-scheme: dark){.l{fill:#a6a49c}.v{fill:#f2f1ec}.k{stroke:#ffffff;stroke-opacity:.12}}</style>' +
    `<circle class="k" cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke-width="${stroke}"/>` +
    (pct !== undefined && pct > 0
      ? `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${levelHex(pct)}" stroke-width="${stroke}" ` +
        `stroke-linecap="round" stroke-dasharray="${dash} ${c.toFixed(2)}" transform="rotate(-90 ${cx} ${cy})"/>`
      : '') +
    `<text class="v" x="${cx}" y="${cy}" text-anchor="middle" dominant-baseline="central" ` +
    `font-family="system-ui,-apple-system,sans-serif" font-size="${value.length > 3 ? 8.5 : 9.5}" font-weight="600">${value}</text>` +
    `<text class="l" x="${cx}" y="${h - 4}" text-anchor="middle" font-family="system-ui,-apple-system,sans-serif" font-size="11">${label}</text>` +
    '</svg>'
  )
}

function tokensText(n: number): string {
  return n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${Math.round(n / 1000)}k` : `${n}`
}

function resetsIn(iso: string | undefined, now: number): string {
  if (!iso) return ''
  const ms = Date.parse(iso) - now
  if (!Number.isFinite(ms)) return ''
  if (ms <= 0) return 'resets now'
  const mins = Math.round(ms / 60000)
  const d = Math.floor(mins / 1440)
  const h = Math.floor((mins % 1440) / 60)
  const m = mins % 60
  return `resets in ${d > 0 ? `${d}d ${h}h` : h > 0 ? `${h}h ${m}m` : `${m}m`}`
}

function modelChoice(id: string | undefined): string | undefined {
  if (!id) return undefined
  return MODELS.find(m => id.toLowerCase().includes(m.value))?.value
}

function modelLabel(id: string | undefined): string {
  const choice = modelChoice(id)
  return MODELS.find(m => m.value === choice)?.label ?? id ?? '—'
}

function elapsed(ms: number): string {
  const mins = Math.max(0, Math.floor(ms / 60000))
  const h = Math.floor(mins / 60)
  return h > 0 ? `${h}h ${String(mins % 60).padStart(2, '0')}m` : `${mins}m`
}

function money(usd: number | undefined): string {
  return usd === undefined ? '—' : `$${usd < 10 ? usd.toFixed(2) : usd.toFixed(1)}`
}

function ago(t: number, now: number): string {
  const mins = Math.round((now - t) / 60000)
  return mins < 1 ? 'just now' : mins < 60 ? `${mins}m ago` : `${Math.floor(mins / 60)}h ago`
}

// Tool calls per minute over the last ACTIVITY_MINUTES, oldest first: [ok, failed].
function buckets(stats: CallStats, now: number): [number, number][] {
  const out: [number, number][] = Array.from({ length: ACTIVITY_MINUTES }, () => [0, 0])
  for (const c of stats.recent) {
    const age = Math.floor((now - c.t) / 60000)
    if (age < 0 || age >= ACTIVITY_MINUTES) continue
    const slot = out[ACTIVITY_MINUTES - 1 - age]!
    if (c.ok) slot[0]++
    else slot[1]++
  }
  return out
}

function sparkline(data: [number, number][]): string {
  const peak = Math.max(1, ...data.map(([ok, bad]) => ok + bad))
  const ticks = '▁▂▃▄▅▆▇█'
  return data.map(([ok, bad]) => (ok + bad === 0 ? '·' : ticks[Math.min(7, Math.round(((ok + bad) / peak) * 7))])).join('')
}

function activitySvg(data: [number, number][]): string {
  const w = 300
  const h = 64
  const chart = 46
  const gap = 3
  const bw = (w - gap * (data.length - 1)) / data.length
  const peak = Math.max(1, ...data.map(([ok, bad]) => ok + bad))
  const bars = data
    .map(([ok, bad], i) => {
      const x = (i * (bw + gap)).toFixed(1)
      const okH = (ok / peak) * chart
      const badH = (bad / peak) * chart
      const parts = [`<rect class="k" x="${x}" y="0" width="${bw.toFixed(1)}" height="${chart}" rx="2"/>`]
      if (ok > 0) parts.push(`<rect x="${x}" y="${(chart - okH - badH).toFixed(1)}" width="${bw.toFixed(1)}" height="${okH.toFixed(1)}" rx="2" fill="${LEVEL_HEX.ok}"/>`)
      if (bad > 0) parts.push(`<rect x="${x}" y="${(chart - badH).toFixed(1)}" width="${bw.toFixed(1)}" height="${badH.toFixed(1)}" rx="2" fill="${LEVEL_HEX.high}"/>`)
      return parts.join('')
    })
    .join('')
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">` +
    '<style>.l{fill:#5f5e5a}.k{fill:#1f1e1c;fill-opacity:.06}' +
    '@media (prefers-color-scheme: dark){.l{fill:#a6a49c}.k{fill:#ffffff;fill-opacity:.06}}</style>' +
    bars +
    `<text class="l" x="0" y="${h - 2}" font-family="system-ui,-apple-system,sans-serif" font-size="10">${ACTIVITY_MINUTES}m ago</text>` +
    `<text class="l" x="${w}" y="${h - 2}" text-anchor="end" font-family="system-ui,-apple-system,sans-serif" font-size="10">now</text>` +
    '</svg>'
  )
}

function ringGlyph(pct: number | undefined): string {
  if (pct === undefined) return '◌'
  if (pct >= 100) return '●'
  if (pct >= 63) return '◕'
  if (pct >= 38) return '◑'
  if (pct > 0) return '◔'
  return '○'
}

const AGENT_COLOR: Record<string, Color> = {
  running: 'claude',
  pending: 'subtle',
  waiting: 'warning',
  idle: 'subtle',
  completed: 'success',
  failed: 'error',
  killed: 'error',
}
const LIVE = new Set(['pending', 'running', 'waiting', 'idle'])

// ---- the mod ---------------------------------------------------------------

async function refreshAgents($: EngineInterface) {
  const list = await $.agent.list()
  const cards: AgentCard[] = list.map(a => ({
    id: a.id,
    type: a.type,
    description: a.description,
    status: a.status,
    name: a.name,
    parentId: a.parentId,
  }))
  await update($, agents, prior => (stable(prior) === stable(cards) ? prior : cards))
  // The first sighting of an agent: when it was seen, and what its Agent call asked.
  if (cards.length > 0)
    await update($, activity, all => {
      let changed = false
      const next = { ...all }
      for (const c of cards) {
        const prior: AgentDetail = next[c.id] ?? { last: '', tools: 0 }
        const brief = prior.prompt === undefined ? briefs.get(c.description) : undefined
        if (prior.firstSeen !== undefined && brief === undefined) continue
        next[c.id] = { ...prior, firstSeen: prior.firstSeen ?? Date.now(), ...(brief ?? {}) }
        if (brief) briefs.delete(c.description)
        changed = true
      }
      return changed ? next : all
    })
}

function agentCallMark(status: 'runs' | 'ok' | 'error'): string {
  return status === 'runs' ? '…' : status === 'ok' ? '✓' : '✗'
}

// Which of the session's commands each shortcut runs: the exact name, else one a
// plugin or your own skills prefix (`anthropic-skills:research-company`), yours first.
async function resolveShortcuts($: EngineInterface) {
  const listed = await $.command.list()
  const found: Shortcut[] = []
  for (const s of SHORTCUTS) {
    const matches = listed.filter(c => c.name === s.name || c.name.endsWith(`:${s.name}`))
    const pick =
      matches.find(c => c.name === s.name) ?? matches.find(c => c.source === 'user') ?? matches[0]
    if (pick) found.push({ label: s.label, command: pick.name, isExtra: s.isExtra === true })
  }
  await update($, shortcuts, () => found)
}

async function refreshSession($: EngineInterface) {
  const model = await $.session.model()
  const settings = (await $.settings.read()) as Record<string, unknown>
  const perModel = (settings.modelSettings as Record<string, { effortLevel?: unknown }> | undefined)?.[model]
  const configured = perModel?.effortLevel ?? settings.effortLevel
  await update($, session, s => ({
    ...s,
    model,
    effort: s.effort ?? (typeof configured === 'string' ? configured : undefined),
  }))
}

// Runs one of Claude Code's own commands as if typed. A press's work is dropped
// when the press ends, so a timer starts it in a dispatch of its own.
function runCommand($: EngineInterface, command: string, args: string, done?: (text: string) => void) {
  $.clock.after(1, () => {
    let text = ''
    void $.command
      .run({ command, args })
      .then(result => {
        text = result.text ?? ''
      })
      .catch((error: unknown) => {
        text = error instanceof Error ? error.message : String(error)
        $.ui.toast(`/${command} failed: ${text}`)
      })
      .finally(() => {
        done?.(text)
        void refreshSession($).catch(() => undefined)
      })
  })
}

// Minimizes or restores one card, remembered across sessions.
// The saved order, any card it lacks (one added since) after it in default order,
// except one whose default place is the top: that goes first.
function orderOf(saved: readonly string[]): string[] {
  const known = saved
    .map(id => (id === 'tasks' ? 'background' : id))
    .filter(id => (CARD_ORDER as readonly string[]).includes(id))
  const top = known.includes(CARD_ORDER[0]) ? [] : [CARD_ORDER[0]]
  return [...new Set([...top, ...known, ...CARD_ORDER])]
}

// Swaps a card with its neighbour among the cards drawn (`shown`), up (-1) or down (+1).
// Saved in the plugin's store, so the next session opens with the order you set last.
async function moveCard($: EngineInterface, id: string, by: -1 | 1, shown: readonly string[]) {
  const other = shown[shown.indexOf(id) + by]
  if (other === undefined) return
  const next = await update($, layout, l => {
    const order = orderOf(l.order)
    const a = order.indexOf(id)
    const b = order.indexOf(other)
    ;[order[a], order[b]] = [order[b]!, order[a]!]
    return { ...l, order }
  })
  await $.store.set('order', next.order).catch(() => undefined)
}

async function resetOrder($: EngineInterface) {
  await update($, layout, l => ({ ...l, order: [...CARD_ORDER] }))
  await $.store.set('order', [...CARD_ORDER]).catch(() => undefined)
}

async function toggleCard($: EngineInterface, id: string) {
  const next = await update($, collapsed, all => ({ ...all, [id]: !all[id] }))
  await $.store.set('collapsed', next).catch(() => undefined)
}

// The desktop app's task list: Claude sets it with update_plan (a whole list, an
// advance, or steps done and started) and wrap_up checks off what is left.
const PLAN_TOOL = /^mcp__ccd_turn__(update_plan|wrap_up)$/

function planStatus(value: unknown): PlanStep['status'] {
  return value === 'completed' || value === 'in_progress' ? value : 'pending'
}

function applyPlan(steps: readonly PlanStep[], tool: string, input: Record<string, unknown>, now: number): PlanStep[] {
  return stampPlan(steps, nextPlan(steps, tool, input), now)
}

function nextPlan(steps: readonly PlanStep[], tool: string, input: Record<string, unknown>): PlanStep[] {
  if (tool.endsWith('__wrap_up')) return steps.map(s => ({ ...s, status: 'completed' as const }))
  const next = Array.isArray(input.items)
    ? input.items.flatMap(item => {
        const i = (item ?? {}) as Record<string, unknown>
        return typeof i.content === 'string' ? [{ content: i.content, status: planStatus(i.status) }] : []
      })
    : steps.slice()
  const set = (index: number, status: PlanStep['status']) => {
    const step = next[index]
    if (step) next[index] = { ...step, status }
  }
  if (input.advance === true) {
    const at = next.findIndex(s => s.status === 'in_progress')
    set(at, 'completed')
    const after = next.findIndex((s, i) => i > at && s.status === 'pending')
    set(after >= 0 ? after : next.findIndex(s => s.status === 'pending'), 'in_progress')
  }
  if (Array.isArray(input.done)) for (const n of input.done) if (typeof n === 'number') set(n - 1, 'completed')
  if (typeof input.start === 'number') set(input.start - 1, 'in_progress')
  return next
}

// Times each step from the last list, matched by its text (a whole new list often
// repeats the steps): started when it goes in progress, ended when it is done.
function stampPlan(prior: readonly PlanStep[], next: readonly PlanStep[], now: number): PlanStep[] {
  return next.map(step => {
    const was = prior.find(p => p.content === step.content)
    const { content, status } = step
    if (status === 'pending') return { content, status }
    const startedAt = status === 'in_progress' && was?.status !== 'in_progress' ? now : was?.startedAt
    const endedAt = status === 'completed' ? (was?.status === 'completed' ? was.endedAt : now) : undefined
    return { content, status, startedAt, endedAt }
  })
}

// How far along the step under way is, estimated: its time so far against the average
// of the steps done before it, held under 90% until it is done. Undefined with no
// finished step to go by.
function stepEstimate(steps: readonly PlanStep[], step: PlanStep, now: number): { pct: number; typical: number } | undefined {
  const took = steps.flatMap(s =>
    s.status === 'completed' && s.startedAt !== undefined && s.endedAt !== undefined ? [s.endedAt - s.startedAt] : [],
  )
  if (took.length === 0 || step.startedAt === undefined) return undefined
  const typical = took.reduce((a, b) => a + b, 0) / took.length
  return { pct: Math.min(90, typical > 0 ? ((now - step.startedAt) / typical) * 100 : 90), typical }
}

// A step's time, as elapsed() puts it; the pane redraws every 30s, so no seconds.
function stepTime(ms: number): string {
  return ms < 60000 ? '<1m' : elapsed(ms)
}

async function logCall($: EngineInterface, tool: string, label: string, ok: boolean) {
  const t = Date.now()
  await update($, calls, c => ({
    total: c.total + 1,
    failed: c.failed + (ok ? 0 : 1),
    byTool: { ...c.byTool, [tool]: (c.byTool[tool] ?? 0) + 1 },
    recent: [...c.recent.filter(r => t - r.t < ACTIVITY_MINUTES * 60000), { t, ok }],
    failures: ok ? c.failures : [...c.failures, { t, label }].slice(-5),
  }))
}

// ---- the desktop app's own controls (its ccd_* tools; absent in a terminal) ----

const UNGROUPED = 'ungrouped'

// Calls one of the app's tools and reads its JSON answer; throws with its text on failure.
async function appCall($: EngineInterface, server: string, tool: string, args: Record<string, unknown>): Promise<unknown> {
  const result = await $.mcp.call(server, tool, args)
  const text = result.content.map(block => ('text' in block && typeof block.text === 'string' ? block.text : '')).join('')
  if (result.isError) throw new Error(text || `${tool} failed`)
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

async function refreshApp($: EngineInterface) {
  try {
    const self = (await appCall($, 'ccd_session_mgmt', 'get_session', { session_id: 'self' })) as {
      pinned?: boolean
      group?: { id?: string } | null
    }
    const groups = (await appCall($, 'ccd_sidebar', 'list_groups', {}).catch(() => [])) as { id: string; name: string }[]
    const layout = (await appCall($, 'ccd_window', 'get_window_layout', {}).catch(() => undefined)) as
      | { main_window?: { sidebar_collapsed?: boolean } }
      | undefined
    const next = {
      isPinned: self.pinned === true,
      groupId: self.group?.id ?? null,
      groups: Array.isArray(groups) ? groups.map(g => ({ id: g.id, name: g.name })) : [],
      isSidebarCollapsed: layout?.main_window?.sidebar_collapsed,
    }
    await update($, app, a => (stable({ ...a, ...next, isAvailable: true }) === stable(a) ? a : { ...a, ...next, isAvailable: true }))
  } catch {
    await update($, app, a => (a.isAvailable ? { ...a, isAvailable: false } : a))
  }
}

// Runs one app action from a press, in a dispatch of its own, then reads the state back.
// It goes through the session's own tool path with the press as the person's words, so
// the permission check (auto mode's classifier included) sees who asked for it.
function appAction($: EngineInterface, server: string, tool: string, args: Record<string, unknown>, pressed: string, done: string) {
  pressTool($, `mcp__${server}__${tool}`, args, pressed, done, () => void refreshApp($))
}

// Runs a tool a press asked for, through the session's own tool path with the press as
// the person's words, in a dispatch of its own; toasts `done` or the refusal.
function pressTool(
  $: EngineInterface,
  tool: string,
  args: Record<string, unknown>,
  pressed: string,
  done: string,
  after?: () => void,
) {
  const input = { tool, ...args, consent: `The user pressed "${pressed}" in the Command Center pane.` }
  $.clock.after(1, () =>
    void ($.tool.call as unknown as (input: object) => Promise<ToolCallResult<string>>)(input)
      .then(result => {
        if (result.deny !== undefined) throw new Error(result.deny)
        if (result.isError) throw new Error(result.text ?? `${tool} failed`)
        $.ui.toast(done)
      })
      .catch((error: unknown) => $.ui.toast(error instanceof Error ? error.message : String(error)))
      .finally(() => after?.()),
  )
}

// ---- background work: shells, background agents, monitors, workflows ----

const DONE_JOBS_KEPT = 3

// A job a tool call just put in the background, seen as its call returns.
async function trackBackground($: EngineInterface, e: ToolCallInput, result: unknown) {
  const r = (result ?? {}) as Record<string, unknown>
  let job: BackgroundJob | undefined
  if (e.tool === 'Bash' && typeof r.backgroundTaskId === 'string')
    job = {
      id: r.backgroundTaskId,
      kind: 'shell',
      label: readableLabel(e.description ?? e.command),
      detail: clip(e.command, 120),
      isRunning: true,
      startedAt: Date.now(),
    }
  else if (e.tool === 'Monitor' && typeof r.taskId === 'string')
    job = { id: r.taskId, kind: 'monitor', label: readableLabel(e.description), detail: e.command ? clip(e.command, 120) : undefined, isRunning: true, startedAt: Date.now() }
  if (job) {
    const added = job
    await update($, background, list => [...list.filter(j => j.id !== added.id), added])
  }
}

// What the engine reports in flight at a turn's end: it is the record. Jobs it no
// longer lists have finished; the last few finished stay, dimmed.
async function reconcileBackground($: EngineInterface, inFlight: readonly BackgroundSummary[]) {
  const now = Date.now()
  await update($, background, list => {
    const live = new Map(inFlight.map(t => [t.id, t]))
    const next: BackgroundJob[] = list.map(j =>
      live.has(j.id) || !j.isRunning ? j : { ...j, isRunning: false, isStopping: false, endedAt: now },
    )
    for (const t of inFlight)
      if (!next.some(j => j.id === t.id))
        next.push({
          id: t.id,
          kind: t.type,
          label: readableLabel(t.description || t.name || t.agent_type || t.command || t.type),
          detail: t.command ? clip(t.command, 120) : t.agent_type ?? (t.server ? `${t.server} › ${t.tool ?? ''}` : undefined),
          isRunning: true,
          startedAt: now,
        })
    const running = next.filter(j => j.isRunning)
    const ended = next.filter(j => !j.isRunning).sort((a, b) => (b.endedAt ?? 0) - (a.endedAt ?? 0)).slice(0, DONE_JOBS_KEPT)
    const result = [...running, ...ended]
    return stable(result) === stable(list) ? list : result
  })
}

type BackgroundSummary = {
  id: string
  type: string
  status: string
  description: string
  command?: string
  agent_type?: string
  server?: string
  tool?: string
  name?: string
}

// Long URLs have no spaces to wrap at: show a link as its host and the end of its path
// ("claude.ai/…/Uab12cd"), and cap the rest at a few lines.
function readableLabel(text: string): string {
  const short = text.replace(/https?:\/\/([^/\s]+)(\/[^\s]*)?/g, (_m, host: string, path?: string) => {
    const last = (path ?? '').split('/').filter(Boolean).pop()
    return last ? `${host}/…/${last.length > 10 ? `${last.slice(0, 10)}…` : last}` : host
  })
  return clipBlock(short, 140)
}

const JOB_ICON: Record<string, string> = { shell: '⌘', subagent: '◆', monitor: '◉', workflow: '⇶' }

// A row of tiny activity bars for the minimized Activity card: no labels, no track.
function activityMiniSvg(data: [number, number][]): string {
  const w = 160
  const h = 18
  const gap = 2
  const bw = (w - gap * (data.length - 1)) / data.length
  const peak = Math.max(1, ...data.map(([ok, bad]) => ok + bad))
  const bars = data
    .map(([ok, bad], i) => {
      const x = (i * (bw + gap)).toFixed(1)
      const okH = (ok / peak) * h
      const badH = (bad / peak) * h
      const parts = [`<rect class="k" x="${x}" y="${h - 2}" width="${bw.toFixed(1)}" height="2" rx="1"/>`]
      if (ok > 0) parts.push(`<rect x="${x}" y="${(h - okH - badH).toFixed(1)}" width="${bw.toFixed(1)}" height="${Math.max(2, okH).toFixed(1)}" rx="1.5" fill="${LEVEL_HEX.ok}"/>`)
      if (bad > 0) parts.push(`<rect x="${x}" y="${(h - badH).toFixed(1)}" width="${bw.toFixed(1)}" height="${Math.max(2, badH).toFixed(1)}" rx="1.5" fill="${LEVEL_HEX.high}"/>`)
      return parts.join('')
    })
    .join('')
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">` +
    '<style>.k{fill:#1f1e1c;fill-opacity:.12}@media (prefers-color-scheme: dark){.k{fill:#ffffff;fill-opacity:.12}}</style>' +
    bars +
    '</svg>'
  )
}
const ACTIVITY_MINI = { width: 160, height: 18 } as const

// A Plan progress bar: a thin rounded track filled in the accent.
function planBarSvg(pct: number, size: { width: number; height: number } = PLAN_BAR): string {
  const { width: w, height: h } = size
  const filled = (Math.max(0, Math.min(100, pct)) / 100) * w
  const fill = filled > 0 ? `<rect width="${Math.max(h, filled).toFixed(1)}" height="${h}" rx="${h / 2}" fill="${LEVEL_HEX.ok}"/>` : ''
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">` +
    '<style>.k{fill:#1f1e1c;fill-opacity:.12}@media (prefers-color-scheme: dark){.k{fill:#ffffff;fill-opacity:.12}}</style>' +
    `<rect class="k" width="${w}" height="${h}" rx="${h / 2}"/>` +
    fill +
    '</svg>'
  )
}
const PLAN_BAR = { width: 160, height: 6 } as const
const PLAN_STEP_BAR = { width: 160, height: 4 } as const
const PLAN_STEP_ALT: Record<PlanStep['status'], string> = { completed: 'Done', in_progress: 'In progress', pending: 'Not started' }
const PLAN_MARK: Record<PlanStep['status'], string> = { completed: '✓', in_progress: '●', pending: '○' }

// ---- side questions, as /btw asks them ----

const SIDE_KEPT = 5

// What the side-question field holds. The module's own, not $.state: a redraw (a tool
// call, a timer) would otherwise empty the field mid-typing.
let sideDraft = ''

// Asks one side question over the session's own transcript, as /btw does: a fork of the
// main thread's last request with the question after it, every tool denied. Nothing is
// added to the conversation; the answer lands in the card.
function askSide($: EngineInterface, question: string) {
  const id = `${Date.now()}`
  const item: SideQuestion = { id, question, status: 'asking', t: Date.now() }
  void update($, side, list => [item, ...list].slice(0, SIDE_KEPT))
  const settle = (patch: Partial<SideQuestion>) =>
    void update($, side, list => list.map(q => (q.id === id ? { ...q, ...patch } : q)))
  $.clock.after(1, () =>
    void $.model
      .fork({
        prompt:
          'A quick side question from the user, asked from the Command Center pane. It is not part of the ' +
          'task: answer briefly from what you already know of this conversation, without using tools, and ' +
          `do not carry it into your work.\n\n${question}`,
      })
      .then(r => {
        if (r.isAnswered) settle({ status: 'answered', answer: r.text.trim() })
        else
          settle({
            status: 'failed',
            answer:
              r.reason === 'nothing-to-fork'
                ? 'Side questions work once Claude has replied at least once in this session.'
                : r.reason === 'api-error'
                  ? `The request failed${r.status ? ` (${r.status})` : ''}. Try again.`
                  : r.reason === 'aborted'
                    ? 'Cancelled.'
                    : 'No answer came back. Try rephrasing.',
          })
      })
      .catch((error: unknown) => settle({ status: 'failed', answer: error instanceof Error ? error.message : String(error) })),
  )
}

export const register: Register = on => {

  on('session.start', async ($, e, next) => {
    const ran = await next(e)
    await $.command.register({ name: 'command-center', description: 'Open or close the Command Center pane' })
    void $.ui.open({ id: PANE, title: TITLE })
    const now = await $.session.usage()
    await update($, usage, () => toUsage(now.context, now.rateLimits))
    await update($, session, s => ({ ...s, startedAt: now.startedAt, costUsd: now.cost?.usd }))
    await refreshSession($).catch(() => undefined)
    await resolveShortcuts($).catch(() => undefined)
    const saved = await $.store.get('collapsed').catch(() => undefined)
    if (saved && typeof saved === 'object') await update($, collapsed, () => saved as Record<string, boolean>)
    const savedOrder = await $.store.get('order').catch(() => undefined)
    if (Array.isArray(savedOrder)) await update($, layout, l => ({ ...l, order: orderOf(savedOrder.map(String)) }))
    $.clock.every(3000, () => void refreshAgents($).catch(() => undefined))
    await refreshApp($)
    // Picks up a pin, group or sidebar change made in the app itself.
    $.clock.every(15000, () => void refreshApp($))
    // Redraws the session timer once a minute.
    $.clock.every(30000, () => void update($, session, s => ({ ...s, tick: s.tick + 1 })))
    return ran
  })

  // `/command-center` toggles the pane; `open` or `close` after it says which.
  on('command.run', { command: 'command-center' }, async ($, e) => {
    const word = e.args.trim().toLowerCase()
    const isOpen = (await $.ui.panes()).some(pane => pane.id === PANE)
    if (word === 'close' || (word !== 'open' && isOpen)) {
      await $.ui.close({ id: PANE })
      return { text: 'Command Center closed. /command-center opens it again.' }
    }
    await $.ui.open({ id: PANE, title: TITLE })
    return { text: 'Command Center opened.' }
  })

  on('session.measure', async ($, e, next) => {
    await update($, usage, () => toUsage(e.context, e.rateLimits))
    if (e.cost) {
      const usd = e.cost.usd
      await update($, session, s => ({ ...s, costUsd: usd }))
    }
    return next(e)
  })

  // Compacting mid-turn would cut the turn's own context out from under it.
  on('turn.start', async ($, e, next) => {
    await update($, session, s => ({ ...s, isWorking: true }))
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const ran = await next(e)
    await update($, session, s => ({ ...s, isWorking: false }))
    void refreshSession($).catch(() => undefined)
    return ran
  })

  on('tool.call', async ($, e, next) => {
    const key = callKey(e.tool, e)
    callKeys.set(e.tool_use_id, key)
    if (e.tool === 'Agent')
      briefs.set(e.description, {
        prompt: e.prompt,
        model: e.model,
        effort: e.effort,
        isBackground: e.run_in_background === true,
      })
    const agentId = e.agentId
    const label = describe(e.tool, e)
    if (agentId) {
      const call = { id: e.tool_use_id, label, status: 'runs' as const, t: Date.now() }
      await update($, activity, all => {
        const prior: AgentDetail = all[agentId] ?? { last: '', tools: 0 }
        return {
          ...all,
          [agentId]: {
            ...prior,
            last: label,
            tools: prior.tools + 1,
            recent: [...(prior.recent ?? []), call].slice(-RECENT_AGENT_CALLS),
          },
        }
      })
    }

    const ran = await next(e)

    if (agentId) {
      const status = ran.deny === undefined && ran.isError !== true ? ('ok' as const) : ('error' as const)
      await update($, activity, all => {
        const prior = all[agentId]
        if (!prior?.recent) return all
        return {
          ...all,
          [agentId]: { ...prior, recent: prior.recent.map(c => (c.id === e.tool_use_id ? { ...c, status } : c)) },
        }
      })
    }

    callKeys.delete(e.tool_use_id)
    await logCall($, e.tool, describe(e.tool, e), ran.deny === undefined && ran.isError !== true)

    if (ran.deny === undefined && ran.isError !== true) await trackBackground($, e, ran.result)
    if (ran.deny === undefined && ran.isError !== true && !agentId && PLAN_TOOL.test(e.tool)) {
      const input = e as unknown as Record<string, unknown>
      const at = await $.clock.now()
      await update($, plan, p => ({ steps: applyPlan(p.steps, e.tool, input, at), updatedAt: at }))
    }
    if (e.tool === 'Agent' || e.agentId) void refreshAgents($).catch(() => undefined)
    return ran
  })


  // A subagent's model steps: how many, the tokens they used, and the latest thing it said.
  on('turn.step', async function* ($, e, next) {
    const step = yield* next(e)
    const agentId = e.agentId
    if (agentId) {
      const usage = step.usage
      const note = step.answer.trim()
      await update($, activity, all => {
        const prior: AgentDetail = all[agentId] ?? { last: '', tools: 0 }
        return {
          ...all,
          [agentId]: {
            ...prior,
            steps: (prior.steps ?? 0) + 1,
            outputTokens: (prior.outputTokens ?? 0) + (usage?.output_tokens ?? 0),
            contextTokens: usage
              ? usage.input_tokens + usage.cache_read_input_tokens + usage.cache_creation_input_tokens
              : prior.contextTokens,
            note: note !== '' ? note : prior.note,
          },
        }
      })
    }
    return step
  })

  // Subagents come and go: refresh their cards at once rather than on the next tick.
  on('classic.SubagentStart', async ($, e, next) => {
    const ran = await next(e)
    await refreshAgents($).catch(() => undefined)
    return ran
  })

  // Each main turn's end reports the session's in-flight background work.
  on('classic.Stop', async ($, e, next) => {
    const ran = await next(e)
    if (e.background_tasks) await reconcileBackground($, e.background_tasks).catch(() => undefined)
    return ran
  })

  on('classic.SubagentStop', async ($, e, next) => {
    const ran = await next(e)
    if (e.background_tasks) void reconcileBackground($, e.background_tasks).catch(() => undefined)
    void refreshAgents($).catch(() => undefined)
    return ran
  })

  // A permission prompt: show it as a card with buttons; the first answer wins.
  on('classic.PermissionRequest', async ($, e, next) => {
    const id = `${e.tool_name}:${describe(e.tool_name, e.tool_input)}:${Date.now()}`
    const card: Approval = {
      id,
      tool: e.tool_name,
      summary: describe(e.tool_name, e.tool_input),
      agentId: e.agent_id,
      at: Date.now(),
    }
    const key = callKey(e.tool_name, e.tool_input)
    const isTracked = [...callKeys.values()].includes(key)
    for (const [toolUseId, k] of callKeys) if (k === key) $.ui.notice(toolUseId, 'Also waiting in the Command Center pane')

    await update($, approvals, list => [...list, card])
    void $.ui.open({ id: PANE, title: TITLE })
    $.ui.toast(`Approval needed: ${card.summary}`)

    const choice = await new Promise<Choice>(resolve => {
      waiting.set(id, resolve)
      next.signal.addEventListener('abort', () => resolve('dialog'))
      // Answered in the engine's own dialog: the call ends, and the card goes.
      if (isTracked)
        void (async () => {
          while (waiting.has(id)) {
            await $.clock.sleep(1000)
            if (![...callKeys.values()].includes(key)) resolve('dialog')
          }
        })()
    })
    waiting.delete(id)
    await update($, approvals, list => list.filter(a => a.id !== id))

    if (choice === 'allow') return { decision: { behavior: 'allow' } }
    if (choice === 'deny') return { decision: { behavior: 'deny', message: 'Denied from the Command Center pane.' } }
    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const table = $.ui.resolve(e)
    const { Box, Text, Button } = table
    const Select = 'Select' in table ? table.Select : undefined
    const Input = 'Input' in table ? table.Input : undefined
    const { Markdown } = table
    // The terminal draws no SVG: there, meters are block bars and rings are glyphs.
    const Svg = e.surface !== 'terminal' && 'Svg' in table ? table.Svg : undefined
    const now = Date.now()

    const u = await read($, usage)
    const jobs = await read($, background)
    const asked = await read($, side)
    const agentList = await read($, agents)
    const acts = await read($, activity)
    const opened = await read($, expanded)
    const pending = await read($, approvals)
    const sess = await read($, session)
    const shortcutList = await read($, shortcuts)
    const planNow = await read($, plan)
    const stats = await read($, calls)
    const folded = await read($, collapsed)
    const appState = await read($, app)
    const lay = await read($, layout)
    const order = orderOf(lay.order)
    // The cards drawn this time, in order (Actions is absent in a terminal, Shortcuts
    // when none resolved); the arrows move a card past its drawn neighbours only.
    const isShown: Record<string, boolean> = {
      plan: planNow.steps.length > 0,
      actions: appState.isAvailable,
      shortcuts: shortcutList.length > 0,
      side: Input !== undefined || asked.length > 0,
    }
    const shownOrder = () => order.filter(id => isShown[id] !== false)

    const ctxPct = contextPercent(u)
    const fiveHour = u.limits.find(l => l.kind === 'five_hour')
    const sevenDay = u.limits.find(l => l.kind === 'seven_day')

    const liveAgents = agentList.filter(a => LIVE.has(a.status))
    const doneAgents = agentList.filter(a => !LIVE.has(a.status)).slice(-3)

    // A faint light fill that lifts each card off the dark app background. Desktop only:
    // a terminal paints a background as solid cells.
    const cardFill = e.surface === 'terminal' ? undefined : CARD_FILL

    // A section: a rounded card with a title on the left, a summary and a minimize
    // toggle on the right. A minimized card keeps its header, summary included, and
    // shows `whenFolded` in place of its body where it has one.
    const card = (
      key: string,
      title: string,
      summary: string,
      body: RenderChildren,
      accent?: Color,
      whenFolded?: RenderChildren,
    ) => {
      const id = key.replace(/^card:/, '')
      const isFolded = folded[id] === true
      return (
        <Box
          key={key}
          flexDirection="column"
          borderStyle="round"
          borderColor={accent ?? 'subtle'}
          backgroundColor={cardFill}
          paddingX={2}
          paddingY={isFolded && whenFolded === undefined ? 0 : 1}
          gap={1}
        >
          <Box key={`head:${id}`} flexDirection="row" justifyContent="space-between" alignItems="center">
            {/* The title is the minimize toggle: a wide target, underlined under the pointer. */}
            <Button
              key={`fold:${id}`}
              plain
              hover={{ underline: true, bold: true }}
              onPress={() => void toggleCard($, id)}
            >
              {`${isFolded ? '▸' : '▾'}  ${title}`}
            </Button>
            {lay.isArranging && shownOrder().includes(id) ? (
              <Box flexDirection="row" gap={1} alignItems="center">
                {shownOrder().indexOf(id) > 0 && (
                  <Button key={`up:${id}`} variant="secondary" onPress={() => void moveCard($, id, -1, shownOrder())}>
                    ↑
                  </Button>
                )}
                {shownOrder().indexOf(id) < shownOrder().length - 1 && (
                  <Button key={`down:${id}`} variant="secondary" onPress={() => void moveCard($, id, 1, shownOrder())}>
                    ↓
                  </Button>
                )}
              </Box>
            ) : (
              <Text dimColor>{summary}</Text>
            )}
          </Box>
          {isFolded ? whenFolded : body}
        </Box>
      )
    }

    const meter = (label: string, pct: number | undefined, note: string) =>
      Svg ? (
        <Box flexDirection="column">
          <Svg source={meterSvg(label, pct)} alt={`${label}: ${pct === undefined ? 'no reading' : `${Math.round(pct)}%`}`} />
          {note !== '' && <Text dimColor>{note}</Text>}
        </Box>
      ) : (
        <Box flexDirection="column">
          <Box flexDirection="row" justifyContent="space-between">
            <Text>{label}</Text>
            <Text bold color={levelColor(pct)}>
              {pct === undefined ? '—' : `${Math.round(pct)}%`}
            </Text>
          </Box>
          <Text color={levelColor(pct)}>{bar(pct, 24)}</Text>
          {note !== '' && <Text dimColor>{note}</Text>}
        </Box>
      )

    const approvalsCard =
      pending.length > 0 &&
      card(
        'card:approvals',
        'Approvals',
        `${pending.length} waiting`,
        <Box flexDirection="column" gap={1}>
          {pending.map(a => (
            <Box key={`approval:${a.id}`} flexDirection="column" borderStyle="round" borderColor="permission" paddingX={1}>
              <Text bold>
                {a.tool}
                {a.agentId ? <Text dimColor> · from a subagent</Text> : ''}
              </Text>
              <Text wrap="wrap">{a.summary}</Text>
              <Box flexDirection="row" gap={1} marginTop={1}>
                <Button key={`approve:${a.id}`} variant="primary" onPress={() => waiting.get(a.id)?.('allow')}>
                  Approve
                </Button>
                <Button key={`deny:${a.id}`} variant="secondary" onPress={() => waiting.get(a.id)?.('deny')}>
                  Deny
                </Button>
                <Button key={`dialog:${a.id}`} plain dimColor onPress={() => waiting.get(a.id)?.('dialog')}>
                  Use dialog
                </Button>
              </Box>
            </Box>
          ))}
        </Box>,
        'permission',
      )

    const setApp = (change: Partial<AppState>) => void update($, app, a => ({ ...a, ...change }))
    const groupOptions = [
      { value: UNGROUPED, label: 'Ungrouped' },
      ...appState.groups.map(g => ({ value: g.id, label: g.name })),
    ]
    const groupName = appState.groups.find(g => g.id === appState.groupId)?.name ?? 'Ungrouped'
    const actionsCard =
      appState.isAvailable &&
      card(
        'card:actions',
        'Actions',
        `${appState.isPinned ? 'Pinned · ' : ''}${groupName}`,
        appState.isConfirmingArchive ? (
          <Box flexDirection="column" gap={1}>
            <Text>Archive this session? The conversation ends and moves to Archived.</Text>
            <Box flexDirection="row" gap={1}>
              <Button
                key="archive-confirm"
                variant="primary"
                onPress={() => {
                  setApp({ isConfirmingArchive: false })
                  appAction(
                    $,
                    'ccd_session_mgmt',
                    'archive_session',
                    { session_id: 'self', reason: 'Archived from the Command Center pane' },
                    'Archive this session',
                    'Session archived',
                  )
                }}
              >
                Archive
              </Button>
              <Button key="archive-cancel" variant="secondary" onPress={() => setApp({ isConfirmingArchive: false })}>
                Cancel
              </Button>
            </Box>
          </Box>
        ) : (
          <Box flexDirection="column" gap={1}>
            <Box flexDirection="row" flexWrap="wrap" gap={1}>
              <Button
                key="pin"
                variant={appState.isPinned ? 'primary' : 'secondary'}
                onPress={() => {
                  const pinned = !appState.isPinned
                  setApp({ isPinned: pinned })
                  appAction(
                    $,
                    'ccd_sidebar',
                    'set_pinned',
                    { session_id: 'self', pinned },
                    pinned ? 'Pin this session' : 'Unpin this session',
                    pinned ? 'Session pinned' : 'Session unpinned',
                  )
                }}
              >
                {appState.isPinned ? '📌 Unpin' : '📌 Pin'}
              </Button>
              <Button
                key="sidebar"
                variant="secondary"
                onPress={() => {
                  const isCollapsed = !(appState.isSidebarCollapsed ?? false)
                  setApp({ isSidebarCollapsed: isCollapsed })
                  appAction(
                    $,
                    'ccd_window',
                    'set_sidebar_collapsed',
                    { collapsed: isCollapsed },
                    isCollapsed ? 'Hide sidebar' : 'Show sidebar',
                    isCollapsed ? 'Sidebar hidden' : 'Sidebar shown',
                  )
                }}
              >
                {appState.isSidebarCollapsed ? 'Show sidebar' : 'Hide sidebar'}
              </Button>
              <Button key="archive" variant="secondary" onPress={() => setApp({ isConfirmingArchive: true })}>
                Archive
              </Button>
            </Box>
            <Box flexDirection="row" flexWrap="wrap" gap={1} alignItems="center">
              {Select && (
                <Select
                  key="group"
                  label="Group"
                  options={groupOptions}
                  value={appState.groupId ?? UNGROUPED}
                  onSelect={value => {
                    const groupId = value === UNGROUPED ? null : value
                    if (groupId === (appState.groupId ?? null)) return
                    setApp({ groupId })
                    const name = groupOptions.find(o => o.value === value)?.label ?? 'Ungrouped'
                    appAction(
                      $,
                      'ccd_sidebar',
                      'move_sessions',
                      { session_ids: ['self'], group_id: groupId },
                      `Move this session to the ${name} group`,
                      `Moved to ${name}`,
                    )
                  }}
                />
              )}
              {Input && !appState.isNamingGroup && (
                <Button key="new-group" variant="secondary" onPress={() => setApp({ isNamingGroup: true })}>
                  ＋ New group
                </Button>
              )}
            </Box>
            {Input && appState.isNamingGroup && (
              <Box flexDirection="row" gap={1} alignItems="center">
                <Input
                  key="group-name"
                  placeholder="New group name"
                  submitLabel="Create"
                  autoFocus
                  onSubmit={value => {
                    const name = value.trim()
                    if (name === '') return $.ui.toast('Type a name for the group')
                    if (name.length > 200) return $.ui.toast('Group names are 200 characters at most')
                    if (appState.groups.some(g => g.name.toLowerCase() === name.toLowerCase()))
                      return $.ui.toast(`A group named ${name} already exists`)
                    setApp({ isNamingGroup: false })
                    appAction(
                      $,
                      'ccd_sidebar',
                      'create_group',
                      { name },
                      `Create a new sidebar group called ${name}`,
                      `Created group ${name}`,
                    )
                  }}
                />
                <Button key="new-group-cancel" plain dimColor onPress={() => setApp({ isNamingGroup: false })}>
                  Cancel
                </Button>
              </Box>
            )}
          </Box>
        ),
      )


    const isFull = (ctxPct ?? 0) >= 80
    const compactRow = (
      <Box flexDirection="row" justifyContent="flex-end">
        {sess.isCompacting ? (
          <Text dimColor>Compacting…</Text>
        ) : sess.isWorking ? (
          <Text dimColor>Compact is available after this turn</Text>
        ) : (
          <Button
            key="compact"
            variant={isFull ? 'primary' : 'secondary'}
            onPress={() => {
              void update($, session, st => ({ ...st, isCompacting: true }))
              runCommand($, 'compact', '', () => void update($, session, st => ({ ...st, isCompacting: false })))
            }}
          >
            {isFull ? 'Compact now' : 'Compact'}
          </Button>
        )}
      </Box>
    )

    const rings = [
      { label: 'Session', pct: ctxPct },
      { label: '5h', pct: fiveHour?.percentUsed },
      { label: '7d', pct: sevenDay?.percentUsed },
    ]
    const contextCard = card(
      // The session at a glance: its running time and cost up top, its context and plan
      // limits below. Kept under the id `context` so saved order and minimizing carry over.
      'card:context',
      'Session',
      `${sess.startedAt !== undefined ? elapsed(now - sess.startedAt) : '—'} · ${money(sess.costUsd)}`,
      <Box flexDirection="column" gap={1}>
        {meter(
          'Session',
          ctxPct,
          u.context?.tokens !== undefined ? `${tokensText(u.context.tokens)} / ${tokensText(u.context.window)} tokens` : '',
        )}
        {meter('5h limit', fiveHour?.percentUsed, fiveHour ? resetsIn(fiveHour.resetsAt, now) : 'no reading yet')}
        {meter('7d limit', sevenDay?.percentUsed, sevenDay ? resetsIn(sevenDay.resetsAt, now) : 'no reading yet')}
        {compactRow}
      </Box>,
      undefined,
      Svg ? (
        <Box flexDirection="row" justifyContent="space-evenly">
          {rings.map(ring => (
            <Svg
              key={`ring:${ring.label}`}
              source={usageRingSvg(ring.label, ring.pct)}
              width={RING_BOX.width}
              height={RING_BOX.height}
              alt={`${ring.label} ${ring.pct === undefined ? 'no reading' : `${Math.round(ring.pct)}%`}`}
            />
          ))}
        </Box>
      ) : (
        <Box flexDirection="row" justifyContent="space-evenly">
          {rings.map(ring => (
            <Text key={`ring:${ring.label}`} color={levelColor(ring.pct)}>
              {ringGlyph(ring.pct)} {ring.pct === undefined ? '—' : `${Math.round(ring.pct)}%`}{' '}
              <Text dimColor>{ring.label}</Text>
            </Text>
          ))}
        </Box>
      ),
    )

    const isAsking = asked.some(q => q.status === 'asking')
    const sideCard = card(
      'card:side',
      'Side question',
      isAsking ? 'thinking…' : '',
      <Box flexDirection="column" gap={1}>
        {Input && (
          <Input
            key="side-input"
            placeholder="Ask about this session without interrupting it…"
            submitLabel="Ask"
            value={sideDraft}
            onInput={value => {
              sideDraft = value
            }}
            onSubmit={value => {
              const question = value.trim()
              sideDraft = ''
              if (question !== '') askSide($, question)
            }}
          />
        )}
        {asked.length === 0 ? (
          <Text dimColor>Answers come from a copy of the conversation, like /btw: nothing is added to the chat.</Text>
        ) : (
          asked.map((q, i) => (
            <Box key={`side:${q.id}`} flexDirection="column">
              <Text bold dimColor={i > 0} wrap="wrap">
                {q.question}
              </Text>
              {q.status === 'asking' ? (
                <Text color={LEVEL_HEX.ok}>Thinking…</Text>
              ) : q.status === 'failed' ? (
                <Text color="error" wrap="wrap">
                  {q.answer}
                </Text>
              ) : i === 0 ? (
                <Markdown key={`side-answer:${q.id}`} text={q.answer ?? ''} />
              ) : (
                <Text dimColor wrap="wrap">
                  {clipBlock(q.answer ?? '', 160)}
                </Text>
              )}
            </Box>
          ))
        )}
        {asked.length > 0 && !isAsking && (
          <Box flexDirection="row" justifyContent="flex-end">
            <Button key="side-clear" plain dimColor onPress={() => void update($, side, () => [])}>
              Clear
            </Button>
          </Box>
        )}
      </Box>,
    )

    const roomy = (e.props.bodyColumns ?? e.viewport?.columns ?? 0) >= EXTRAS_MIN_COLUMNS
    const shown = shortcutList.filter(sc => roomy || !sc.isExtra)
    const shortcutsCard =
      shown.length > 0 &&
      card(
        'card:shortcuts',
        'Shortcuts',
        '',
        <Box flexDirection="row" flexWrap="wrap" gap={1}>
          {shown.map(sc => (
            <Button
              key={`shortcut:${sc.command}`}
              variant="secondary"
              onPress={() =>
                void $.prompt
                  .fill({ text: `/${sc.command} `, mode: 'replace' })
                  .then(r => (r.isFilled ? undefined : $.ui.toast(`Type /${sc.command} in the message box`)))
                  .catch(() => $.ui.toast(`Type /${sc.command} in the message box`))
              }
            >
              {sc.label}
            </Button>
          ))}
        </Box>,
      )

    const series = buckets(stats, now)
    const topTools = Object.entries(stats.byTool)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 4)
      .map(([tool, n]) => `${tool.startsWith('mcp__') ? tool.split('__')[1] : tool} ${n}`)
      .join(' · ')
    const activityCard = card(
      'card:activity',
      'Activity',
      `${stats.total} call${stats.total === 1 ? '' : 's'}${stats.failed > 0 ? ` · ${stats.failed} failed` : ''}`,
      stats.total === 0 ? (
        <Text dimColor>No tool calls yet.</Text>
      ) : (
        <Box flexDirection="column" gap={1}>
          {Svg ? (
            <Svg source={activitySvg(series)} alt={`Tool calls per minute over the last ${ACTIVITY_MINUTES} minutes`} />
          ) : (
            <Box flexDirection="column">
              <Text color="#349FFD">{sparkline(series)}</Text>
              <Text dimColor>
                {`${ACTIVITY_MINUTES}m ago`.padEnd(ACTIVITY_MINUTES - 3)}now
              </Text>
            </Box>
          )}
          <Text dimColor wrap="truncate-end">
            {topTools}
          </Text>
          {stats.failures
            .slice()
            .reverse()
            .slice(0, 3)
            .map(f => (
              <Text key={`fail:${f.t}:${f.label}`} color="error" wrap="truncate-end">
                ✗ {f.label} · {ago(f.t, now)}
              </Text>
            ))}
        </Box>
      ),
      undefined,
      // Minimized: the header's call counts, and under them only a strip of tiny bars.
      stats.total === 0 ? undefined : Svg ? (
        <Svg
          source={activityMiniSvg(series)}
          width={ACTIVITY_MINI.width}
          height={ACTIVITY_MINI.height}
          alt={`Tool calls per minute over the last ${ACTIVITY_MINUTES} minutes`}
        />
      ) : (
        <Text color={LEVEL_HEX.ok}>{sparkline(series)}</Text>
      ),
    )

    const runningJobs = jobs.filter(j => j.isRunning)
    const backgroundCard = card(
      'card:background',
      'Background work',
      runningJobs.length > 0 ? `${runningJobs.length} running` : '',
      jobs.length === 0 ? (
        <Text dimColor>Nothing running in the background.</Text>
      ) : (
        <Box flexDirection="column" gap={1}>
          {jobs.map(j => (
            // Stacked so nothing runs off the card: the label wraps on a line of its own,
            // and the second line keeps the Stop button in view at its right.
            <Box key={`job:${j.id}`} flexDirection="column">
              <Box flexDirection="row" gap={1}>
                <Text color={j.isRunning ? LEVEL_HEX.ok : undefined} dimColor={!j.isRunning}>
                  {JOB_ICON[j.kind] ?? '•'}
                </Text>
                <Box flexDirection="column" flexGrow={1} flexShrink={1}>
                  <Text dimColor={!j.isRunning} wrap="wrap">
                    {readableLabel(j.label)}
                  </Text>
                </Box>
              </Box>
              <Box flexDirection="row" justifyContent="space-between" alignItems="center" gap={1}>
                <Box flexDirection="column" flexGrow={1} flexShrink={1}>
                  <Text dimColor wrap="wrap">
                    {[
                      j.kind,
                      j.isRunning ? `running ${elapsed(now - j.startedAt)}` : `finished ${ago(j.endedAt ?? now, now)}`,
                      j.detail && j.detail !== j.label ? readableLabel(j.detail) : undefined,
                    ]
                      .filter(Boolean)
                      .join(' · ')}
                  </Text>
                </Box>
                {j.isRunning &&
                  (j.isStopping ? (
                    <Text dimColor>Stopping…</Text>
                  ) : (
                    <Button
                      key={`stop:${j.id}`}
                      variant="secondary"
                      onPress={() => {
                        void update($, background, list => list.map(x => (x.id === j.id ? { ...x, isStopping: true } : x)))
                        pressTool($, 'TaskStop', { task_id: j.id }, `Stop the background ${j.kind} "${j.label}"`, `Stopped ${j.label}`, () =>
                          void update($, background, list =>
                            list.map(x => (x.id === j.id ? { ...x, isRunning: false, isStopping: false, endedAt: Date.now() } : x)),
                          ),
                        )
                      }}
                    >
                      Stop
                    </Button>
                  ))}
              </Box>
            </Box>
          ))}
        </Box>
      ),
    )

    const agentsCard = card(
      'card:agents',
      'Agents',
      `${liveAgents.length} active`,
      agentList.length === 0 ? (
        <Text dimColor>No subagents yet.</Text>
      ) : (
        <Box flexDirection="column" gap={1}>
          {[...liveAgents, ...doneAgents].map(a => {
            const act = acts[a.id]
            const live = LIVE.has(a.status)
            const isOpen = opened[a.id] === true
            return (
              <Box
                key={`agent:${a.id}`}
                flexDirection="column"
                borderStyle="round"
                borderColor={AGENT_COLOR[a.status] ?? 'subtle'}
                borderDimColor={!live}
                paddingX={1}
              >
                <Box flexDirection="row" justifyContent="space-between">
                  <Box flexDirection="row" gap={1}>
                    <Text bold color={AGENT_COLOR[a.status]}>●</Text>
                    <Text bold>{a.name ?? a.type}</Text>
                  </Box>
                  <Text dimColor>
                    {a.name ? `${a.type} · ` : ''}
                    {a.status}
                    {a.parentId ? ' · nested' : ''}
                  </Text>
                </Box>
                <Text dimColor={!live} wrap="wrap">
                  {a.description}
                </Text>
                {act && act.tools > 0 && (
                  <Text dimColor wrap="truncate-end">
                    ↳ {act.last} · {act.tools} tool{act.tools === 1 ? '' : 's'}
                  </Text>
                )}
                <Box key={`agent-more-row:${a.id}`} flexDirection="row">
                  <Button
                    key={`agent-more:${a.id}`}
                    variant="primary"
                    hover={{ underline: true }}
                    onPress={() => void update($, expanded, all => ({ ...all, [a.id]: !all[a.id] }))}
                  >
                    {isOpen ? '▾ Hide details' : '▸ Details'}
                  </Button>
                </Box>
                {isOpen && (
                  <Box flexDirection="column" gap={1} marginTop={1} marginBottom={1}>
                    <Text dimColor>
                      {[
                        act?.firstSeen !== undefined ? `${live ? 'Running' : 'Ran'} ${elapsed(now - act.firstSeen)}` : undefined,
                        act?.steps ? `${act.steps} step${act.steps === 1 ? '' : 's'}` : undefined,
                        act?.outputTokens ? `${tokensText(act.outputTokens)} tokens out` : undefined,
                        act?.contextTokens ? `${tokensText(act.contextTokens)} context` : undefined,
                        act?.model ? modelLabel(act.model) : undefined,
                        act?.effort ? `effort ${act.effort}` : undefined,
                        act?.isBackground ? 'background' : undefined,
                      ]
                        .filter(Boolean)
                        .join(' · ') || 'No figures yet'}
                    </Text>
                    {act?.prompt && (
                      <Box flexDirection="column">
                        <Text bold>Task</Text>
                        <Text wrap="wrap">{clipBlock(act.prompt, 600)}</Text>
                      </Box>
                    )}
                    {act?.note && (
                      <Box flexDirection="column">
                        <Text bold>Latest note</Text>
                        <Text wrap="wrap">{clipBlock(act.note, 300)}</Text>
                      </Box>
                    )}
                    <Box flexDirection="column">
                      <Text bold>Recent tools</Text>
                      {(act?.recent ?? []).length === 0 && <Text dimColor>None yet.</Text>}
                      {(act?.recent ?? [])
                        .slice()
                        .reverse()
                        .map(c => (
                          <Text
                            key={`agent-call:${c.id}`}
                            wrap="truncate-end"
                            dimColor={c.status === 'ok'}
                            color={c.status === 'error' ? 'error' : c.status === 'runs' ? 'claude' : undefined}
                          >
                            {agentCallMark(c.status)} {c.label} · {ago(c.t, now)}
                          </Text>
                        ))}
                    </Box>
                  </Box>
                )}
              </Box>
            )
          })}
        </Box>
      ),
    )

    const steps = planNow.steps
    const doneSteps = steps.filter(s => s.status === 'completed').length
    const isPlanDone = steps.length > 0 && doneSteps === steps.length
    const currentStep = steps.find(s => s.status === 'in_progress') ?? steps.find(s => s.status === 'pending')
    const planPct = steps.length === 0 ? 0 : (doneSteps / steps.length) * 100
    const planClock = steps.some(s => s.status !== 'pending') ? await $.clock.now() : now
    const planCard =
      steps.length > 0 &&
      card(
        'card:plan',
        'Plan',
        `${doneSteps}/${steps.length}${isPlanDone ? ' · done' : ''}`,
        <Box flexDirection="column" gap={1}>
          {steps.map((step, i) => (
            <Box key={`step:${i}`} flexDirection="row" gap={1}>
              <Text
                color={step.status === 'in_progress' ? LEVEL_HEX.ok : undefined}
                dimColor={step.status !== 'in_progress'}
              >
                {PLAN_MARK[step.status]}
              </Text>
              {/* The step, and under it its own bar: full when done, empty until started,
                  and a sliding segment while under way. */}
              <Box flexDirection="column" flexGrow={1} flexShrink={1}>
                <Text bold={step.status === 'in_progress'} dimColor={step.status === 'completed'} wrap="wrap">
                  {step.content}
                </Text>
                {(() => {
                  const estimate = step.status === 'in_progress' ? stepEstimate(steps, step, planClock) : undefined
                  const pct = step.status === 'completed' ? 100 : (estimate?.pct ?? 0)
                  const time =
                    step.status === 'completed' && step.startedAt !== undefined && step.endedAt !== undefined
                      ? stepTime(step.endedAt - step.startedAt)
                      : step.status === 'in_progress' && step.startedAt !== undefined
                        ? `${stepTime(planClock - step.startedAt)}${estimate ? ` · est. ~${stepTime(estimate.typical)}` : ''}`
                        : ''
                  const alt =
                    step.status === 'in_progress'
                      ? estimate
                        ? `In progress, about ${Math.round(estimate.pct)}% by time (estimate)`
                        : 'In progress'
                      : PLAN_STEP_ALT[step.status]
                  return (
                    <Box flexDirection="row" gap={1} alignItems="center">
                      {Svg ? (
                        <Svg source={planBarSvg(pct, PLAN_STEP_BAR)} width={PLAN_STEP_BAR.width} height={PLAN_STEP_BAR.height} alt={alt} />
                      ) : (
                        <Text color={LEVEL_HEX.ok} dimColor={step.status === 'pending'}>
                          {bar(pct)}
                        </Text>
                      )}
                      {time !== '' && <Text dimColor>{time}</Text>}
                    </Box>
                  )
                })()}
              </Box>
            </Box>
          ))}
        </Box>,
        undefined,
        // Minimized: the step under way and a progress bar.
        <Box flexDirection="column">
          <Text dimColor={isPlanDone} wrap="truncate-end">
            {isPlanDone ? 'All steps done' : (currentStep?.content ?? '')}
          </Text>
          {Svg ? (
            <Svg source={planBarSvg(planPct)} width={PLAN_BAR.width} height={PLAN_BAR.height} alt={`${doneSteps} of ${steps.length} steps done`} />
          ) : (
            <Text color={LEVEL_HEX.ok}>{bar(planPct)}</Text>
          )}
        </Box>,
      )

    const cardsById: Record<string, RenderChildren> = {
      plan: planCard,
      actions: actionsCard,
      context: contextCard,
      shortcuts: shortcutsCard,
      background: backgroundCard,
      side: sideCard,
      agents: agentsCard,
      activity: activityCard,
    }

    return (
      <Box flexDirection="column" gap={1}>
        <Box key="toolbar" flexDirection="row" justifyContent="flex-end" gap={1}>
          {lay.isArranging ? (
            <>
              <Button key="arrange-reset" plain dimColor onPress={() => void resetOrder($)}>
                Reset order
              </Button>
              <Button
                key="arrange"
                variant="primary"
                onPress={() => void update($, layout, l => ({ ...l, isArranging: false }))}
              >
                Done
              </Button>
            </>
          ) : (
            <Button
              key="arrange"
              plain
              dimColor
              hover={{ underline: true }}
              onPress={() => void update($, layout, l => ({ ...l, isArranging: true }))}
            >
              ⇅ Arrange cards
            </Button>
          )}
        </Box>
        {approvalsCard}
        {order.map(id => cardsById[id])}
      </Box>
    )
  })
}
