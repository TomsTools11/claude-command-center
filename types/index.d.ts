export type Limit = { kind: string; percentUsed: number; resetsAt?: string }
export type Usage = {
  context?: { percent?: number; tokens?: number; window: number }
  limits: Limit[]
}
export type BackgroundJob = {
  id: string
  /** shell, subagent, monitor, workflow, or what the engine calls it */
  kind: string
  label: string
  detail?: string
  isRunning: boolean
  isStopping?: boolean
  startedAt: number
  endedAt?: number
}
export type AgentCard = { id: string; type: string; description: string; status: string; name?: string; parentId?: string }
export type AgentCall = { id: string; label: string; status: 'runs' | 'ok' | 'error'; t: number }
export type AgentDetail = {
  last: string
  tools: number
  recent?: AgentCall[]
  steps?: number
  outputTokens?: number
  contextTokens?: number
  note?: string
  prompt?: string
  model?: string
  effort?: string
  isBackground?: boolean
  firstSeen?: number
}
export type AgentActivity = Record<string, AgentDetail>
export type Approval = { id: string; tool: string; summary: string; agentId?: string; at: number }
export type SessionInfo = {
  model?: string
  effort?: string
  startedAt?: number
  costUsd?: number
  isWorking: boolean
  isCompacting: boolean
  tick: number
}
export type AppState = {
  isAvailable: boolean
  isPinned?: boolean
  groupId?: string | null
  groups: { id: string; name: string }[]
  isSidebarCollapsed?: boolean
  isConfirmingArchive: boolean
  isNamingGroup: boolean
}
export type SideQuestion = {
  id: string
  question: string
  answer?: string
  status: 'asking' | 'answered' | 'failed'
  t: number
}
export type Shortcut = { label: string; command: string; isExtra: boolean }
export type CallStats = {
  total: number
  failed: number
  byTool: Record<string, number>
  recent: { t: number; ok: boolean }[]
  failures: { t: number; label: string }[]
}

declare module 'claude-code' {
  interface PluginState {
    'command-center': {
      usage: Usage
      background: BackgroundJob[]
      side: SideQuestion[]
      agents: AgentCard[]
      activity: AgentActivity
      expanded: Record<string, boolean>
      approvals: Approval[]
      session: SessionInfo
      shortcuts: Shortcut[]
      calls: CallStats
      collapsed: Record<string, boolean>
      layout: { order: string[]; isArranging: boolean }
      app: AppState
    }
  }
}
