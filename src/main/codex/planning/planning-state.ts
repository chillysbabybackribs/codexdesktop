export type PlanningPhase =
  | 'discovery'
  | 'awaitingApproval'
  | 'executing'
  | 'completed'
  | 'needsReplan'

export type StructuredPlan = {
  objective: string
  decisions: string[]
  steps: string[]
  affectedFiles: string[]
  nonGoals: string[]
  acceptanceCriteria: string[]
  risks: string[]
}

export type PlanningState = {
  threadId: string
  phase: PlanningPhase
  plan: StructuredPlan | null
  revision: number
  approvedRevision: number | null
  approvedAt: number | null
}

export type PlanningStateListener = (state: PlanningState) => void
