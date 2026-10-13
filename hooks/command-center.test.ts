import type { AgentInfo, CommandInfo, CommandRunInput, On, RenderPropsOf, SessionMeasureInput } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

const PANE = {
  plugin: 'command-center',
  component: 'Pane',
  requestId: 'command-center',
  props: { title: 'Command Center' } as RenderPropsOf['Pane'],
} as const

const RESETS = new Date(Date.now() + (2 * 60 + 15) * 60000).toISOString()

test('context and the 5h / 7d limits show as meters', async ($, on) => {
  on('session.measure', async (_$, e) => ({ changed: e.changed }))
  await $.session.measure({
    context: { tokens: 120_000, window: 200_000, percent: 60 },
    rateLimits: [
      { kind: 'five_hour', percentUsed: 34, resetsAt: RESETS },
      { kind: 'seven_day', percentUsed: 91.5 },
    ],
    changed: ['context', 'rateLimits'],
  } as SessionMeasureInput)

  const term = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await term.find({ type: 'Text', text: '60%' })).toBeDefined()
  expect(await term.find({ type: 'Text', text: '120k / 200k tokens' })).toBeDefined()
  expect(await term.find({ type: 'Text', text: '34%' })).toBeDefined()
  expect(await term.find({ type: 'Text', text: /resets in 2h 1[45]m/ })).toBeDefined()
  expect(await term.find({ type: 'Text', text: '92%' })).toBeDefined()
  expect(JSON.stringify(await term.drawn())).not.toContain('rgba(')
  await term.unmount()

  // Desktop draws each meter as a rounded SVG bar inside the Context card.
  const desk = await $.ui.mount({ ...PANE, surface: 'desktop' })
  const drawn = JSON.stringify(await desk.drawn())
  expect(await desk.findAll({ type: 'Svg' })).toHaveLength(3)
  for (const value of ['>60%<', '>34%<', '>92%<', '#349FFD', '#E5484D']) expect(drawn).toContain(value)
  expect(await desk.find({ type: 'Text', text: '120k / 200k tokens' })).toBeDefined()
  expect(drawn).toContain('rgba(255, 255, 255, 0.08)')
  expect(await desk.find({ type: 'Text', text: /resets in 2h 1[45]m/ })).toBeDefined()
  await desk.unmount()
})

test('each subagent gets a card with its task', async ($, on) => {
  const list: AgentInfo[] = [
    { id: 'a1', type: 'Explore', description: 'Find the auth handlers', status: 'running' },
    { id: 'a2', type: 'general-purpose', description: 'Draft release notes', status: 'completed' },
  ]
  on('agent.list', async () => ({ value: list }))
  on('classic.SubagentStart', async () => ({}))
  await $.classic.SubagentStart({ agent_id: 'a1', agent_type: 'Explore' })

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await ui.find({ type: 'Text', text: '1 active' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'Find the auth handlers' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'Draft release notes' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /running/ })).toBeDefined()
    await ui.unmount()
  }
})

test('a permission prompt shows as a card and Approve answers it', { timeoutMs: 15000 }, async ($, on) => {
  on('ui.open', async () => ({ value: { isPlaced: true as const } }))
  on('ui.toast', async () => undefined as never)
  on('classic.PermissionRequest', async () => ({}))

  for (const surface of ['terminal', 'desktop'] as const) {
    const asked = $.classic.PermissionRequest({ tool_name: 'Bash', tool_input: { command: 'npm install left-pad' } })
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await ui.find({ type: 'Text', text: '1 waiting' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'Bash: npm install left-pad' })).toBeDefined()
    const approve = await ui.find({ type: 'Button', text: 'Approve' })
    expect(approve?.key).toBeDefined()
    await ui.press({ key: approve!.key! })
    expect(await asked).toMatchObject({ decision: { behavior: 'allow' } })
    await ui.unmount()
  }
})

test('Deny refuses, and Use dialog hands the prompt back', { timeoutMs: 15000 }, async ($, on) => {
  on('ui.open', async () => ({ value: { isPlaced: true as const } }))
  on('ui.toast', async () => undefined as never)
  on('classic.PermissionRequest', async () => ({}))

  const denied = $.classic.PermissionRequest({ tool_name: 'Write', tool_input: { file_path: '/repo/.env', content: 'x' } })
  let ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: (await ui.find({ type: 'Button', text: 'Deny' }))!.key! })
  expect(await denied).toMatchObject({ decision: { behavior: 'deny' } })
  await ui.unmount()

  const handed = $.classic.PermissionRequest({ tool_name: 'WebFetch', tool_input: { url: 'https://example.com', prompt: 'p' } })
  ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: (await ui.find({ type: 'Button', text: 'Use dialog' }))!.key! })
  expect(await handed).toEqual({})
  expect(await ui.find({ type: 'Text', text: /Approvals/ })).toBeUndefined()
  await ui.unmount()
})

test('/command-center opens the pane, and closes it when it is open', async ($, on) => {
  const open = new Set<string>()
  on('ui.open', async (_$, e) => {
    open.add(e.id)
    return { value: { isPlaced: true as const } }
  })
  on('ui.close', async (_$, e) => {
    open.delete(e.id)
    return { value: undefined }
  })
  on('ui.panes', async () => ({
    value: [...open].map(id => ({ id, title: 'Command Center', isShown: true, isFocused: false, isPlaced: true })),
  }) as never)
  const run = (args: string) => $.command.run({ command: 'command-center', args } as CommandRunInput)

  expect(await run('')).toMatchObject({ text: 'Command Center opened.' })
  expect(open.has('command-center')).toBe(true)
  expect(await run('')).toMatchObject({ text: 'Command Center closed. /command-center opens it again.' })
  expect(open.has('command-center')).toBe(false)
  expect(await run('close')).toMatchObject({ text: 'Command Center closed. /command-center opens it again.' })
  expect(await run('open')).toMatchObject({ text: 'Command Center opened.' })
  expect(await run('open')).toMatchObject({ text: 'Command Center opened.' })
  expect(open.has('command-center')).toBe(true)
})

const COMMANDS: CommandInfo[] = [
  { name: 'market-research-reports', description: '', source: 'user' },
  { name: 'campaign-analyst:goal-client-report', description: '', source: 'plugin' },
  { name: 'anthropic-skills:goal-client-report', description: '', source: 'user' },
  { name: 'prompt-engineering-expert', description: '', source: 'user' },
  { name: 'goal-initial-onboarding', description: '', source: 'user' },
  { name: 'design-taste-frontend', description: '', source: 'user' },
  { name: 'goal-disposition-import:disposition-import', description: '', source: 'plugin' },
  { name: 'research-company', description: '', source: 'user' },
]

// What session.start needs beneath the plugin, and the commands it runs recorded.
function startStubs(on: On) {
  const ran: { command: string; args?: string }[] = []
  const filled: string[] = []
  on('session.start', async () => ({ cwd: '/repo' }))
  on('command.register', async (_$, e) => ({ value: { command: e.name } }))
  on('ui.open', async () => ({ value: { isPlaced: true as const } }))
  on('session.usage', async () => ({
    value: { startedAt: Date.now() - 42 * 60000, context: { window: 200_000 }, rateLimits: [], cost: { usd: 1.4237 } },
  }))
  on('session.model', async () => ({ value: 'claude-opus-5-5' }))
  on('settings.read', async () => ({ value: { modelSettings: { 'claude-opus-5-5': { effortLevel: 'high' } } } as never }))
  on('command.list', async () => ({ value: COMMANDS }))
  on('command.run', async (_$, e) => {
    ran.push({ command: e.command, args: e.args })
    return { text: 'ok' }
  })
  on('prompt.fill', async (_$, e) => {
    filled.push(e.text)
    return { isFilled: true }
  })
  return { ran, filled }
}

test('Session and Context are one card: time and cost in its header, meters below', async ($, on) => {
  mock.clock(on, { now: Date.now() })
  startStubs(on)
  await $.session.start({ cwd: '/repo', source: 'startup' } as never)

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await ui.find({ type: 'Button', key: 'fold:context', text: '▾  Session' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '42m · $1.42' })).toBeDefined()
    expect(await ui.find({ type: 'Button', key: 'fold:session' })).toBeUndefined()
    expect(await ui.find({ type: 'Select', key: 'model' })).toBeUndefined()
    expect(await ui.find({ type: 'Button', key: 'compact' })).toBeDefined()
    await ui.unmount()
  }
})

test('the Compact button runs /compact', async ($, on) => {
  const clock = mock.clock(on, { now: Date.now() })
  const { ran } = startStubs(on)
  await $.session.start({ cwd: '/repo', source: 'startup' } as never)

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'compact' })
  await clock.advance(10)
  expect(ran).toContainEqual({ command: 'compact', args: '' })
  await ui.unmount()
})

test('shortcut buttons fill the prompt with your commands; the extras need room', async ($, on) => {
  mock.clock(on, { now: Date.now() })
  const { filled } = startStubs(on)
  await $.session.start({ cwd: '/repo', source: 'startup' } as never)

  const wide = await $.ui.mount({ ...PANE, surface: 'desktop', props: { ...PANE.props, bodyColumns: 80 } })
  expect(await wide.findAll({ type: 'Button', text: /Market research|Client report|Prompt expert|Onboarding|Design taste|Dispositions|Research company/ })).toHaveLength(7)
  await wide.press({ key: 'shortcut:anthropic-skills:goal-client-report' })
  await wide.press({ key: 'shortcut:goal-disposition-import:disposition-import' })
  expect(filled).toEqual(['/anthropic-skills:goal-client-report ', '/goal-disposition-import:disposition-import '])
  await wide.unmount()

  const narrow = await $.ui.mount({ ...PANE, surface: 'terminal', props: { ...PANE.props, bodyColumns: 36 } })
  expect(await narrow.find({ type: 'Button', text: 'Onboarding' })).toBeDefined()
  expect(await narrow.find({ type: 'Button', text: 'Design taste' })).toBeUndefined()
  await narrow.unmount()
})

test('the Activity card charts tool calls and lists failures', async ($, on) => {
  on('tool.call', async (_$, e) => {
    const { tool } = e as { tool: string }
    return tool === 'Bash'
      ? { result: { stdout: '', stderr: 'boom', interrupted: false } as never, isError: true as const }
      : { result: { ok: true } as never }
  })
  const { call } = $.tool as never as { call: (args: object) => Promise<unknown> }
  for (const file of ['/r/a.ts', '/r/b.ts', '/r/c.ts']) await call({ tool: 'Read', file_path: file })
  await call({ tool: 'Bash', command: 'npm test' })

  const term = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await term.find({ type: 'Text', text: '4 calls · 1 failed' })).toBeDefined()
  expect(await term.find({ type: 'Text', text: /Read 3 · Bash 1/ })).toBeDefined()
  expect(await term.find({ type: 'Text', text: /✗ Bash: npm test · just now/ })).toBeDefined()
  expect(await term.find({ type: 'Text', text: /[▁▂▃▄▅▆▇█]$/ })).toBeDefined()
  await term.unmount()

  const desk = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(JSON.stringify(await desk.drawn())).toContain('Tool calls per minute')
  await desk.unmount()
})

test('each card minimizes to its header and stays minimized next session', async ($, on) => {
  mock.clock(on, { now: Date.now() })
  const stored = new Map<string, unknown>()
  on('store.get', async (_$, e) => ({ value: stored.get(e.key) }))
  on('store.set', async (_$, e) => {
    stored.set(e.key, e.value)
    return { value: undefined }
  })
  startStubs(on)
  await $.session.start({ cwd: '/repo', source: 'startup' } as never)

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await ui.find({ type: 'Button', key: 'fold:context', text: '▾' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'no reading yet' })).toBeDefined()
    await ui.press({ key: 'fold:context' })
    // The body goes; the header and its summary stay.
    expect(await ui.find({ type: 'Button', key: 'fold:context', text: '▸' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '42m · $1.42' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'no reading yet' })).toBeUndefined()
    expect(await ui.find({ type: 'Button', key: 'compact' })).toBeUndefined()
    // Other cards are untouched.
    expect(await ui.find({ type: 'Button', key: 'fold:shortcuts', text: '▾' })).toBeDefined()
    await ui.press({ key: 'fold:context' })
    expect(await ui.find({ type: 'Text', text: 'no reading yet' })).toBeDefined()
    await ui.unmount()
  }

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'fold:activity' })
  await ui.unmount()
  expect(stored.get('collapsed')).toEqual({ context: false, activity: true })
})

// The desktop app's own tools, as the Actions card calls them.
function appStubs(on: On) {
  const state = { pinned: false, group: null as null | { id: string }, collapsed: false }
  const calls: { server: string; tool: string; args: Record<string, unknown> }[] = []
  const groups = [
    { id: 'cg-goal', name: 'GOAL' },
    { id: 'cg-s3', name: 'S3 Projects' },
  ]
  const json = (value: unknown) => ({ value: { content: [{ type: 'text' as const, text: JSON.stringify(value) }], isError: false } })
  on('mcp.call', async (_$, e) => {
    calls.push({ server: e.server, tool: e.tool, args: e.args })
    if (e.tool === 'get_session') return json({ pinned: state.pinned, group: state.group })
    if (e.tool === 'list_groups') return json(groups)
    if (e.tool === 'get_window_layout') return json({ main_window: { sidebar_collapsed: state.collapsed } })
    if (e.tool === 'set_pinned') state.pinned = e.args.pinned === true
    if (e.tool === 'set_sidebar_collapsed') state.collapsed = e.args.collapsed === true
    if (e.tool === 'move_sessions') state.group = e.args.group_id ? { id: String(e.args.group_id) } : null
    return json({ ok: true })
  })
  // The app's actions go through the session's tool path, the press as consent.
  on('tool.call', async (_$, e) => {
    const { tool, consent, tool_use_id: _id, ...args } = e as { tool: string; consent?: string } & Record<string, unknown>
    const [, server = '', name = ''] = tool.split('__')
    calls.push({ server, tool: name, args: { ...args, consent } })
    if (name === 'set_pinned') state.pinned = args.pinned === true
    if (name === 'set_sidebar_collapsed') state.collapsed = args.collapsed === true
    if (name === 'move_sessions') state.group = args.group_id ? { id: String(args.group_id) } : null
    if (name === 'create_group') groups.push({ id: `cg-${groups.length}`, name: String(args.name) })
    return { result: { ok: true } as never, text: '{"ok":true}' }
  })
  on('ui.toast', async () => ({ value: undefined }) as never)
  return { state, calls, groups }
}

test('the Actions card pins, hides the sidebar, moves to a group and archives after a confirm', async ($, on) => {
  const clock = mock.clock(on, { now: Date.now() })
  startStubs(on)
  const { state, calls } = appStubs(on)
  await $.session.start({ cwd: '/repo', source: 'startup' } as never)

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await ui.find({ type: 'Button', key: 'pin', text: '📌 Pin' })).toBeDefined()
    expect(await ui.find({ type: 'Button', key: 'sidebar', text: 'Hide sidebar' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'Ungrouped' })).toBeDefined()
    await ui.unmount()
  }

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'pin' })
  await ui.press({ key: 'sidebar' })
  await ui.select({ key: 'group', value: 'cg-goal' })
  await clock.advance(10)
  expect(state).toEqual({ pinned: true, group: { id: 'cg-goal' }, collapsed: true })
  expect(await ui.find({ type: 'Button', key: 'pin', text: '📌 Unpin' })).toBeDefined()
  expect(await ui.find({ type: 'Button', key: 'sidebar', text: 'Show sidebar' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'Pinned · GOAL' })).toBeDefined()

  // Archive asks first; Cancel calls nothing.
  await ui.press({ key: 'archive' })
  await ui.press({ key: 'archive-cancel' })
  await clock.advance(10)
  expect(calls.some(c => c.tool === 'archive_session')).toBe(false)
  await ui.press({ key: 'archive' })
  expect(await ui.find({ type: 'Text', text: /Archive this session\?/ })).toBeDefined()
  await ui.press({ key: 'archive-confirm' })
  await clock.advance(10)
  expect(calls).toContainEqual({
    server: 'ccd_session_mgmt',
    tool: 'archive_session',
    args: {
      session_id: 'self',
      reason: 'Archived from the Command Center pane',
      consent: 'The user pressed "Archive this session" in the Command Center pane.',
    },
  })
  expect(calls.find(c => c.tool === 'move_sessions')?.args.consent).toBe(
    'The user pressed "Move this session to the GOAL group" in the Command Center pane.',
  )
  await ui.unmount()
})

test('no Actions card where the app has no controls (a terminal session)', async ($, on) => {
  mock.clock(on, { now: Date.now() })
  startStubs(on)
  on('mcp.call', async () => ({ deny: 'no such server' }) as never)
  await $.session.start({ cwd: '/repo', source: 'startup' } as never)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Button', key: 'pin' })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: 'Session' })).toBeDefined()
  await ui.unmount()
})

test('the minimized Context card keeps Session, 5h and 7d as rings', async ($, on) => {
  mock.clock(on, { now: Date.now() })
  startStubs(on)
  on('store.get', async () => ({ value: undefined }))
  on('store.set', async () => ({ value: undefined }))
  on('session.measure', async (_$, e) => ({ changed: e.changed }))
  await $.session.start({ cwd: '/repo', source: 'startup' } as never)
  await $.session.measure({
    context: { tokens: 54_000, window: 200_000, percent: 27 },
    rateLimits: [
      { kind: 'five_hour', percentUsed: 1 },
      { kind: 'seven_day', percentUsed: 92 },
    ],
    changed: ['context', 'rateLimits'],
  } as SessionMeasureInput)

  const term = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await term.press({ key: 'fold:context' })
  expect(await term.find({ type: 'Text', text: /◔ 27% Session/ })).toBeDefined()
  expect(await term.find({ type: 'Text', text: /◔ 1% 5h/ })).toBeDefined()
  expect(await term.find({ type: 'Text', text: /◕ 92% 7d/ })).toBeDefined()
  expect(await term.find({ type: 'Text', text: '54k / 200k tokens' })).toBeUndefined()
  await term.unmount()

  const desk = await $.ui.mount({ ...PANE, surface: 'desktop' })
  const drawn = JSON.stringify(await desk.drawn())
  for (const part of ['Session 27%', '5h 1%', '7d 92%', '>27%<', '>1%<', '>92%<', '#E5484D', '#349FFD']) expect(drawn).toContain(part)
  expect(await desk.findAll({ type: 'Svg' })).toHaveLength(3)
  expect(drawn).toContain('"justifyContent":"space-evenly"')
  expect(await desk.find({ type: 'Button', key: 'compact' })).toBeUndefined()
  // A fixed size, so the desktop does not stretch the rings to the card's width.
  expect(drawn).toContain('"width":48')
  expect(drawn).toContain('"height":56')
  await desk.press({ key: 'fold:context' })
  expect(await desk.find({ type: 'Text', text: '54k / 200k tokens' })).toBeDefined()
  await desk.unmount()
})

test('New group asks for a name, refuses a duplicate, and creates the group', async ($, on) => {
  const clock = mock.clock(on, { now: Date.now() })
  startStubs(on)
  const { calls, groups } = appStubs(on)
  await $.session.start({ cwd: '/repo', source: 'startup' } as never)

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Input', key: 'group-name' })).toBeUndefined()
  await ui.press({ key: 'new-group' })
  expect(await ui.find({ type: 'Input', key: 'group-name' })).toBeDefined()

  await ui.input({ key: 'group-name', text: 'goal' })
  await clock.advance(10)
  expect(calls.some(c => c.tool === 'create_group')).toBe(false)

  await ui.input({ key: 'group-name', text: '  Client Reports  ' })
  await clock.advance(10)
  expect(calls.find(c => c.tool === 'create_group')?.args).toMatchObject({
    name: 'Client Reports',
    consent: 'The user pressed "Create a new sidebar group called Client Reports" in the Command Center pane.',
  })
  expect(groups.map(g => g.name)).toContain('Client Reports')
  // The field closes and the new group is in the picker.
  expect(await ui.find({ type: 'Input', key: 'group-name' })).toBeUndefined()
  expect(JSON.stringify(await ui.find({ type: 'Select', key: 'group' }))).toContain('Client Reports')

  await ui.press({ key: 'new-group' })
  await ui.press({ key: 'new-group-cancel' })
  expect(await ui.find({ type: 'Button', key: 'new-group' })).toBeDefined()
  await ui.unmount()
})

test('an agent card drops down its task, figures, latest note and recent tools', async ($, on) => {
  const list: AgentInfo[] = [{ id: 'a1', type: 'Explore', description: 'Find the auth handlers', status: 'running' }]
  on('agent.list', async () => ({ value: list }))
  on('tool.call', async () => ({ result: { ok: true } as never, text: 'ok' }))
  on('turn.step', async function* (_$, e) {
    return {
      turnId: e.turnId,
      index: e.index,
      answer: 'Found login.ts; checking the session middleware next.',
      toolUses: [],
      stopReason: 'tool_use',
      usage: { model: 'claude-sonnet-5-5', input_tokens: 2000, output_tokens: 1500, cache_read_input_tokens: 30000, cache_creation_input_tokens: 0 },
    } as never
  })
  const { call } = $.tool as never as { call: (args: object) => Promise<unknown> }

  // The Agent call that starts it: its prompt becomes the card's task.
  await call({
    tool: 'Agent',
    description: 'Find the auth handlers',
    prompt: 'Find every place the app checks a session token and list the files.',
    subagent_type: 'Explore',
    model: 'sonnet',
  })
  const step = $.turn.step({ turnId: 't1', index: 0, model: 'claude-sonnet-5-5', messageCount: 3, agentId: 'a1' } as never)
  for await (const _ of step) void _
  await step.result

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await ui.find({ type: 'Text', text: /^Task$/ })).toBeUndefined()
    await ui.press({ key: 'agent-more:a1' })
    expect(await ui.find({ type: 'Button', key: 'agent-more:a1', text: '▾ Hide details' })).toBeDefined()
    // A primary button: a label takes no colour of its own in this build.
    expect(JSON.stringify(await ui.find({ type: 'Button', key: 'agent-more:a1' }))).toContain('"variant":"primary"')
    expect(await ui.find({ type: 'Text', text: /Find every place the app checks a session token/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /Running 0m · 1 step · 2k tokens out · 32k context · Sonnet 5\.5/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /Found login\.ts; checking the session middleware next\./ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'Recent tools' })).toBeDefined()
    await ui.press({ key: 'agent-more:a1' })
    expect(await ui.find({ type: 'Text', text: 'Latest note' })).toBeUndefined()
    await ui.unmount()
  }
})

test('Arrange moves cards up and down, saves the order, and the title toggles the card', async ($, on) => {
  mock.clock(on, { now: Date.now() })
  const stored = new Map<string, unknown>()
  on('store.get', async (_$, e) => ({ value: stored.get(e.key) }))
  on('store.set', async (_$, e) => {
    stored.set(e.key, e.value)
    return { value: undefined }
  })
  startStubs(on)
  await $.session.start({ cwd: '/repo', source: 'startup' } as never)

  const heads = async (ui: { findAll: (q: { type: string; key?: string; text?: RegExp }) => Promise<{ key?: string }[]> }) =>
    (await ui.findAll({ type: 'Button', text: /^[▾▸] {2}/ })).map(b => b.key)

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await heads(ui)).toEqual(['fold:context', 'fold:shortcuts', 'fold:background', 'fold:agents', 'fold:activity'])
    expect(await ui.find({ type: 'Button', key: 'up:activity' })).toBeUndefined()
    await ui.unmount()
  }

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'arrange' })
  expect(await ui.find({ type: 'Button', key: 'up:context' })).toBeUndefined()
  for (let i = 0; i < 4; i++) await ui.press({ key: 'up:activity' })
  expect(await ui.find({ type: 'Button', key: 'up:activity' })).toBeUndefined()
  await ui.press({ key: 'down:context' })
  expect(await heads(ui)).toEqual(['fold:activity', 'fold:shortcuts', 'fold:context', 'fold:background', 'fold:agents'])
  expect(stored.get('order')).toEqual(['actions', 'activity', 'shortcuts', 'context', 'background', 'agents'])
  await ui.press({ key: 'arrange' })
  expect(await ui.find({ type: 'Button', key: 'up:context' })).toBeUndefined()

  // The title is the toggle.
  await ui.press({ key: 'fold:activity' })
  expect(await ui.find({ type: 'Button', key: 'fold:activity', text: '▸  Activity' })).toBeDefined()
  await ui.unmount()
})

test('a new session opens with the saved order', async ($, on) => {
  mock.clock(on, { now: Date.now() })
  on('store.get', async (_$, e) => ({ value: e.key === 'order' ? ['activity', 'context'] : undefined }))
  on('store.set', async () => ({ value: undefined }))
  startStubs(on)
  await $.session.start({ cwd: '/repo', source: 'startup' } as never)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  const keys = (await ui.findAll({ type: 'Button', text: /^[▾▸] {2}/ })).map(b => b.key)
  expect(keys.slice(0, 2)).toEqual(['fold:activity', 'fold:context'])
  await ui.unmount()
})

test('Background work lists jobs put in the background, reconciles at turn end, and stops one', async ($, on) => {
  const clock = mock.clock(on, { now: Date.now() })
  const stopped: unknown[] = []
  on('tool.call', async (_$, e) => {
    const { tool, ...args } = e as { tool: string } & Record<string, unknown>
    if (tool === 'Bash') return { result: { stdout: '', stderr: '', interrupted: false, backgroundTaskId: 'b1' } as never }
    if (tool === 'TaskStop') {
      stopped.push(args.task_id)
      return { result: { message: 'stopped', task_id: 'b1', task_type: 'shell' } as never }
    }
    return { result: {} as never }
  })
  on('classic.Stop', async () => ({}))
  on('ui.toast', async () => ({ value: undefined }) as never)
  const { call } = $.tool as never as { call: (args: object) => Promise<unknown> }

  await call({ tool: 'Bash', command: 'npm run dev', description: 'Start the dev server', run_in_background: true })
  await $.classic.Stop({
    stop_hook_active: false,
    background_tasks: [
      { id: 'b1', type: 'shell', status: 'running', description: 'Start the dev server', command: 'npm run dev' },
      { id: 'a9', type: 'subagent', status: 'running', description: 'Review the diff', agent_type: 'general-purpose' },
    ],
  } as never)

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await ui.find({ type: 'Text', text: '2 running' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /Start the dev server/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /shell · running 0m · npm run dev/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /Review the diff/ })).toBeDefined()
    await ui.unmount()
  }

  // A long link label is shortened so it can wrap.
  await $.classic.Stop({
    stop_hook_active: false,
    background_tasks: [
      { id: 'b1', type: 'shell', status: 'running', description: 'Start the dev server', command: 'npm run dev' },
      { id: 'a9', type: 'subagent', status: 'running', description: 'Review the diff', agent_type: 'general-purpose' },
      { id: 'm1', type: 'monitor', status: 'running', description: 'live updates for artifact https://claude.ai/artifact/Uab12cd34ef56gh78' },
    ],
  } as never)
  const linked = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await linked.find({ type: 'Text', text: 'live updates for artifact claude.ai/…/Uab12cd34e…' })).toBeDefined()
  expect(JSON.stringify(await linked.drawn())).not.toContain('https://claude.ai/artifact/Uab12cd34ef56gh78')
  await linked.unmount()

  // The subagent is gone from the next report: it finished.
  await $.classic.Stop({
    stop_hook_active: false,
    background_tasks: [{ id: 'b1', type: 'shell', status: 'running', description: 'Start the dev server', command: 'npm run dev' }],
  } as never)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: '1 running' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /subagent · finished just now/ })).toBeDefined()
  await ui.press({ key: 'stop:b1' })
  await clock.advance(10)
  expect(stopped).toEqual(['b1'])
  expect(await ui.find({ type: 'Button', key: 'stop:b1' })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /shell · finished/ })).toBeDefined()
  await ui.unmount()
})

test('the minimized Activity card keeps its counts and shows only a strip of tiny bars', async ($, on) => {
  mock.clock(on, { now: Date.now() })
  on('store.get', async () => ({ value: undefined }))
  on('store.set', async () => ({ value: undefined }))
  on('tool.call', async () => ({ result: { ok: true } as never }))
  const { call } = $.tool as never as { call: (args: object) => Promise<unknown> }
  for (const file of ['/r/a.ts', '/r/b.ts']) await call({ tool: 'Read', file_path: file })

  const desk = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await desk.press({ key: 'fold:activity' })
  expect(await desk.find({ type: 'Text', text: '2 calls' })).toBeDefined()
  expect(await desk.find({ type: 'Text', text: /Read 2/ })).toBeUndefined()
  const drawn = JSON.stringify(await desk.drawn())
  expect(drawn).toContain('"width":160')
  expect(drawn).toContain('"height":18')
  expect(drawn).not.toContain('20m ago')
  await desk.unmount()

  const term = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await term.find({ type: 'Text', text: /^[·▁▂▃▄▅▆▇█]{20}$/ })).toBeDefined()
  await term.unmount()
})
