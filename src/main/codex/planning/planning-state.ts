export type { PlanningPhase, PlanningState, StructuredPlan } from '../../../shared/ipc.js'
import type { PlanningState } from '../../../shared/ipc.js'

export type PlanningStateListener = (state: PlanningState) => void
