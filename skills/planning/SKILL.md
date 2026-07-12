---
name: planning
description: Create rigorous, decision-ready plans for any domain, including software changes, audits, refactors, agents, research, business initiatives, personal goals, events, and travel. Use when the Plan button is active, when the user asks to plan or break down multi-step work, or when an existing plan needs review or revision.
---

# Universal Planning

Turn an intended outcome into a plan that another capable person or agent can execute without rediscovering the important decisions. Adapt the method to the domain; do not force every request into a software template or a calendar.

## Planning Contract

- Plan before implementation while the user is still choosing the approach.
- Treat the current workspace and named artifacts as the source of truth for local claims.
- Research current external facts when stale information could change the plan.
- Challenge weak premises, unnecessary complexity, hidden dependencies, and better alternatives early.
- Ask only questions whose answers materially change the plan and cannot be resolved from available evidence. Ask one at a time and normally no more than three.
- Make reasonable assumptions when the uncertainty is low-impact, and label them.
- Keep the plan proportional: compact for bounded work, deeper for costly, risky, cross-cutting, or ambiguous work.
- Do not treat a plan as approved until the user explicitly approves it or directly asks to implement it.
- After approval, follow the active collaboration mode: implement and validate the agreed plan unless the user requested a plan-only deliverable.

## 1. Frame the Outcome

Establish the smallest clear planning brief:

- Desired end state and why it matters
- Stakeholders or beneficiaries
- In-scope and explicitly out-of-scope work
- Constraints: time, budget, people, tools, policies, location, safety, or quality
- Evidence of success and unacceptable failure
- Known inputs, prior decisions, and unresolved questions

If the requested tactic may not be the best way to reach the outcome, separate the goal from the proposed solution and compare credible alternatives.

## 2. Choose the Planning Mode

Select one primary mode and add other adapters only when useful.

### Technical implementation or refactor

Inspect the codebase before proposing changes. Identify relevant call sites, existing helpers, tests, data flows, interfaces, and operational constraints. Include affected files or components, architectural decisions, dependency order, test coverage, migration or rollback needs, and runtime verification.

### Audit, review, or investigation

Define the audit surface, claim inventory, evidence standard, severity model, sampling or reproduction method, and stopping rule. Separate confirmed findings from hypotheses. Plan the reporting format and the handoff from findings to remediation without assuming that remediation is authorized.

### Agent or automation system

Define the agent's objective, authority boundary, inputs and outputs, tools, state and memory, model or routing choices, human checkpoints, failure recovery, security constraints, evaluation cases, observability, cost limits, and deployment or rollback path.

### Research or decision support

Define the decision the research must support, claim coverage, source lanes, evidence quality, comparison criteria, uncertainty handling, and stopping rule. Do not substitute source count for claim coverage.

### Business, organizational, creative, academic, event, or personal project

Define objectives, deliverables, owners, resources, milestones, dependencies, budget where relevant, feedback points, risks, and measurable outcomes. Use time estimates as planning aids, not invented precision.

### Travel, route, or logistics

Verify current routes, closures, schedules, weather, seasonal constraints, prices, and availability when relevant. Account for travelers, vehicle or transport limits, safe daily duration, fuel or charging, rest, lodging, reservations, accessibility, documents, contingency routes, and emergency options. Distinguish fixed commitments from flexible stops.

## 3. Discover Before Structuring

Use the cheapest reliable evidence:

1. Inspect named files, current code, existing plans, and prior decisions.
2. Verify current or external facts with authoritative sources when they affect feasibility or sequencing.
3. Identify existing solutions, shortcuts, reusable assets, and constraints that could change the approach.
4. Record material assumptions with a validation method and the impact if wrong.
5. Surface conflicts or gaps instead of smoothing them over.

Skip research only when the plan rests on stable, general knowledge or the user explicitly requests a provisional plan.

## 4. Design the Plan

Every substantive plan should cover the following, with headings adapted to the domain:

1. **Outcome and context** — the end state, motivation, and relevant evidence.
2. **Scope and non-goals** — boundaries that prevent accidental expansion.
3. **Assumptions and decisions** — what is known, assumed, chosen, and why.
4. **Approach** — the strategy and meaningful alternatives or trade-offs.
5. **Phases or steps** — dependency-ordered, concrete work with an observable output.
6. **Resources and ownership** — people, tools, budget, materials, access, or skills when relevant.
7. **Risks and contingencies** — early warning signs, mitigation, fallback, and rollback where applicable.
8. **Verification and success criteria** — how each phase and the overall outcome will be proven.
9. **Replanning triggers** — conditions that require revisiting scope, approach, sequence, or estimates.
10. **Next action** — the first executable move or the decision still needed from the user.

For each phase or significant step, specify:

- Purpose
- Inputs or prerequisites
- Actions or decisions
- Deliverable or observable result
- Verification or completion gate
- Dependencies and parallelizable work
- Owner, duration, or cost only when they are meaningful

## 5. Right-Size the Artifact

### Compact

Use for low-risk, well-bounded work. Provide the outcome, assumptions, ordered steps, verification, risks, and next action in a short response.

### Standard

Use for normal multi-step work. Include all core sections and enough detail for execution without rediscovery.

### Deep

Use for cross-cutting, strategic, expensive, safety-sensitive, or highly ambiguous work. Add alternatives, decision records, phased validation, explicit owners, dependency mapping, rollback or contingency paths, measurable failure conditions, and review checkpoints.

Use a table, flow, timeline, or dependency diagram only when it materially clarifies repeated mappings, branching, ownership, or sequence.

## 6. Quality Gate

Before presenting the plan, verify:

- The plan solves the actual goal rather than merely repeating the requested tactic.
- Current and local claims are supported by appropriate evidence.
- Scope, non-goals, assumptions, and unresolved decisions are visible.
- Steps are ordered by real dependencies and identify parallel work without inventing concurrency.
- Each significant step has a concrete output and completion gate.
- Risks include mitigations or contingencies, not just labels.
- Success criteria are observable and failure conditions are not hidden.
- The plan is feasible within stated constraints and does not rely on false precision.
- A new executor could begin without repeating discovery.
- Replanning triggers and the immediate next action are explicit.

## 7. Collaborate and Transition

Present the recommended plan and the most important trade-offs. Ask for approval only when the next action depends on it. When the user changes a decision, revise the affected sections and downstream consequences rather than rewriting blindly.

If the user approves or asks to proceed, treat the approved plan as the execution contract. Keep it updated as evidence changes, validate each meaningful phase, disclose deviations, and finish with results against the success criteria. If the user requested only a plan, stop after delivering or saving the planning artifact.
