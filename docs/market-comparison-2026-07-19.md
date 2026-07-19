# Codex Desktop market comparison

**Observed:** 2026-07-19  
**Repository:** `/home/dp/Desktop/soloapps/codexdesktop`  
**Current checkout:** `master`, commit `6625dc8`  
**Category:** desktop AI coding-agent workstation / agentic IDE

## Decision

Codex Desktop is **ahead in a narrow but meaningful slice, on pace overall, and behind the leaders on execution scale**.

The defensible advantage is the combination of:

1. a persistent, logged-in Electron browser with structured page coverage, artifact-backed research, CDP/network/performance tooling;
2. turn checkpoints that detect and undo shell-made changes, not only model file-edit events; and
3. a cross-provider reviewer dock that automatically audits the doer's actual shared-workspace diff and can send flagged findings back to the doer.

That combination is materially more specific than “we support agents.” I found no first-party competitor source in this review documenting the same combination. This is a bounded evidence result, not proof that no undiscovered product has it.

The overall product is not ahead of the market because Cursor, Windsurf, Claude Code, Cline, Zed, Conductor, and Warp all have stronger evidence for parallel/background work or plan-first workflows. Codex Desktop currently runs one spawned child at a time, has no explicit approve-plan gate, and has no cloud/background execution.

## Evidence rules

Internal claims were checked against current source files and tests. Competitor claims use dated public product documentation or official product pages observed on 2026-07-19. “Unverified” means the reviewed first-party evidence was insufficient; it does not mean the product lacks the capability.

Verification performed in this audit:

- `npm run typecheck`: passed; source-shadow guard clean.
- `npm test`: **590/590 passed**, 0 failed.
- No new feature code was added for this report. The current checkout is on `master`, despite the older capability document naming `stacked-subagents`.

## Internal capability fact sheet

| Capability | Current evidence | Maturity | Honest boundary |
|---|---|---|---|
| Two model runtimes in one app | [`SessionProvider`](/home/dp/Desktop/soloapps/codexdesktop/src/main/providers/session-provider.ts:27), Codex + Claude registration and model-prefix routing in [`codex-ipc.ts`](/home/dp/Desktop/soloapps/codexdesktop/src/main/codex/codex-ipc.ts:44) | Shipped, build-verified | Claude intentionally diverges: no steering, no remote compaction, no goals/plugins ([`claude-provider.ts`](/home/dp/Desktop/soloapps/codexdesktop/src/main/providers/claude-provider.ts:67)). |
| Cross-provider child spawn | Shared `spawn_subagent` schema permits a different provider; orchestrator selects the child runtime by model ([`codex-config.ts`](/home/dp/Desktop/soloapps/codexdesktop/src/main/codex/codex-config.ts:480), [`codex-ipc.ts`](/home/dp/Desktop/soloapps/codexdesktop/src/main/codex/codex-ipc.ts:61)) | Shipped, build-verified | **Blocking single-child only**; the parent waits for the child. The source explicitly says parallel gather is Phase 2 ([`subagent-orchestrator.ts`](/home/dp/Desktop/soloapps/codexdesktop/src/main/agents/subagent-orchestrator.ts:9)). |
| Reviewer/auditor dock | Reviewer role, cross-family default, audit briefing, verdict parsing, and feedback routing ([`agent-session-model.ts`](/home/dp/Desktop/soloapps/codexdesktop/src/renderer/src/agent-session-model.ts:152), [`audit-trigger.ts`](/home/dp/Desktop/soloapps/codexdesktop/src/renderer/src/audit-trigger.ts:106), [`AgentWindowMenu.tsx`](/home/dp/Desktop/soloapps/codexdesktop/src/renderer/src/AgentWindowMenu.tsx:80)) | Shipped, build-verified; dated internal doc reports live verification | Focused main tab only; busy auditors are skipped; one feedback bounce per user turn. |
| Checkpoint-backed undo | Hidden checkpoint refs, per-file undo, whole-turn revert, safety checkpoint before revert ([`turn-checkpoint.ts`](/home/dp/Desktop/soloapps/codexdesktop/src/main/turn-checkpoint.ts:8), [`ReviewBar.tsx`](/home/dp/Desktop/soloapps/codexdesktop/src/renderer/src/ReviewBar.tsx:171)) | Shipped, build-verified | Requires a Git worktree; checkpoints are fire-and-forget and a failed checkpoint means no revert for that turn. |
| Shell-write change detection | `changedFiles()` diffs the checkpoint tree against the current worktree and catches additions, deletions, and modifications ([`turn-checkpoint.ts`](/home/dp/Desktop/soloapps/codexdesktop/src/main/turn-checkpoint.ts:167)) | Shipped, test-verified | This is the key completeness property; it is not a general filesystem transaction system outside the worktree. |
| Native logged-in browser | Persistent `WebContentsView` on `persist:codex-browser` ([`browser-tab-view.ts`](/home/dp/Desktop/soloapps/codexdesktop/src/main/browser/browser-tab-view.ts:1), [`browser-session.ts`](/home/dp/Desktop/soloapps/codexdesktop/src/main/browser/browser-session.ts:7)); CDP attaches through Electron [`cdp-session.ts`](/home/dp/Desktop/soloapps/codexdesktop/src/main/browser/cdp-session.ts:181) | Shipped, build/test-verified | Browser auth rides the user’s profile; no first-class cookie/session API or file-upload automation API. |
| Structured browser extraction | Objective-ranked `browser_snapshot`, composed/shadow-tree traversal, explicit coverage gaps, and `answer` vs `targeted-gap-fill` completion ([`page-snapshot.ts`](/home/dp/Desktop/soloapps/codexdesktop/src/main/browser/page-snapshot.ts:166), [`codex-config.ts`](/home/dp/Desktop/soloapps/codexdesktop/src/main/codex/codex-config.ts:417)) | Shipped, test-verified | Structured extraction is read-oriented; browser network interception/routing/mocking is not exposed. |
| Artifact-first research | Bounded static-HTML lane, Chromium fallback, saved text/HTML artifacts, source coverage contract ([`research-runner.ts`](/home/dp/Desktop/soloapps/codexdesktop/src/main/browser/research-runner.ts:36), [`codex-config.ts`](/home/dp/Desktop/soloapps/codexdesktop/src/main/codex/codex-config.ts:474)) | Shipped, test-verified | Current research stopping is evidence-contract driven; it is not a guarantee that every source is authoritative. |
| Browser diagnostics | CDP lifecycle/network journals, response-body artifacts, screenshots/PDF/traces, performance diagnostics ([`browser-tool-registry.ts`](/home/dp/Desktop/soloapps/codexdesktop/src/main/tools/browser-tool-registry.ts:417)) | Shipped, test-verified | This depth is not the same as browser request interception. |
| Plan/intake workflow | Conversational restatement, reviewer-written plan after confirmation, execution injection ([`main-chat-intake.ts`](/home/dp/Desktop/soloapps/codexdesktop/src/renderer/src/main-chat-intake.ts:40)) plus rendered plan cards ([`TaskActivity.tsx`](/home/dp/Desktop/soloapps/codexdesktop/src/renderer/src/TaskActivity.tsx:986)) | Shipped, build-verified | It is not a separate plan mode with editable plan approval and a hard execution gate. |
| Desktop workspace composition | Up to four explicit chat panes ([`chat-split.ts`](/home/dp/Desktop/soloapps/codexdesktop/src/renderer/src/chat-split.ts:27)), agent dock roles, Shiki/thought/plan/diff/terminal/trace UI | Shipped, build/test-verified | Rich local composition; no cloud-run or mobile control surface. |
| Autosnapshot and disposable verification | `git:autosnapshot` and `verify:app` scripts ([`package.json`](/home/dp/Desktop/soloapps/codexdesktop/package.json:10)) | Shipped, build-verified | Autosnapshot is development/repository infrastructure, not an end-user agent capability. |

### Current corrections to the older capability note

The older capability note says there is “no true subagent spawn primitive.” That is no longer accurate for this checkout: `spawn_subagent`, `SubagentOrchestrator`, child event tagging, interrupt cascading, and tests exist. The accurate statement is: **the primitive exists, but it is sequential and blocking; parallel gather and a converging doer↔reviewer loop are not implemented.**

The older note’s “ahead of incumbents” conclusion should therefore be treated as a hypothesis. This report re-rates it against current first-party evidence.

## Current market evidence

| Product | Dated first-party evidence found | What it proves | Evidence boundary |
|---|---|---|---|
| [Cursor Plan Mode](https://cursor.com/docs/agent/plan-mode) | Observed 2026-07-19 | Plan Mode researches the codebase, creates a reviewable plan, lets the user edit it, then build it. | Strong evidence for plan-first workflow. |
| [Cursor Cloud Agents](https://cursor.com/docs/cloud-agents) | Observed 2026-07-19 | Cloud Agents run in isolated VMs; “as many agents as you want” can run in parallel; agents can use computers/browser; hooks include audit and subagent lifecycle hooks. | Strong evidence for scale and remote computer use; no evidence here of cross-vendor automatic diff auditing. |
| [Windsurf Cascade](https://docs.windsurf.com/de/windsurf/cascade/cascade) | Observed 2026-07-19 | Cascade has a specialized planning agent, named checkpoints/reverts, model selection, MCP, and simultaneous Cascades. Its docs warn reverts are currently not reversible. | Strong evidence, although the retrieved page was German and product documentation may have moved under Devin branding. |
| [Claude Code subagents](https://code.claude.com/docs/en/sub-agents) | Observed 2026-07-19; page references v2.1.x behavior | Custom subagents have independent contexts/tool restrictions; background subagents run concurrently; built-in Explore/Plan agents exist. | Strong evidence for subagents/parallel work. |
| [Claude Code checkpointing](https://code.claude.com/docs/en/checkpointing) | Observed 2026-07-19 | Claude Code automatically tracks file edits and offers rewind, but its limitations explicitly say Bash command changes and external changes are not tracked. | Strong evidence and a directly comparable weakness. |
| [Claude Cowork help center](https://support.claude.com/en/articles/12121266-claude-cowork) | Observed 2026-07-19 | The requested public help page rendered as a shell with no usable capability passages. | **Unverified** for the requested buckets; no Cowork feature claim is made here. |
| [OpenAI Codex documentation](https://learn.chatgpt.com/docs) | Observed 2026-07-19; page displayed July 6–10, 2026 release items | Official docs expose Codex CLI, IDE extension, and cloud surfaces. | **Unverified** for subagents, review, undo, browser, and plan mode in this pass; the requested developer URLs redirected into the docs app. |
| [Warp terminal and agent modes](https://docs.warp.dev/agent-platform/local-agents/interacting-with-agents/terminal-and-agent-modes/) | Observed 2026-07-19 | Local Agent Mode supports model selection, MCP, conversation management, and `/plan`; cloud agent conversations can run parallel agents, use hosted computers, and be managed remotely. | Strong evidence for workspace and remote/parallel execution; not evidence of Warp-native cross-provider auditing. |
| [Cline subagents](https://docs.cline.bot/features/subagents) | Observed 2026-07-19 | Cline spawns focused research agents in parallel; each is read-only and cannot edit files, use the browser, access MCP, or spawn nested agents. The feature is labeled experimental. | Strong evidence for parallel research plus explicit limits. |
| [Roo Code docs](https://roocodeinc.github.io/Roo-Code/) | Observed 2026-07-19; page dated May 15, 2026 | The official docs say the Roo Code extension was shut down May 15, 2026. | Not a current active competitor. Historical page says model-agnostic modes/orchestration, but those are not current-market evidence. |
| [Zed agents](https://zed.dev/docs/ai/agents) | Observed 2026-07-19 | Zed supports Zed Agent, external ACP agents, and terminal threads; it exposes Parallel Agents and separates agent path from LLM provider. | Strong evidence for parallel agents and multi-provider/agent integration; no evidence here of browser control or checkpointed undo. |
| [Conductor docs](https://www.conductor.build/docs) | Observed 2026-07-19 | Conductor runs Claude Code, Codex, Cursor, and OpenCode in parallel; each task gets an isolated workspace/branch/files/terminal/diff/review path, with PR/merge/archive workflow. | Strong evidence for orchestration and review isolation; no evidence here of browser control, plan approval, or cross-provider auto-auditing. |

## Capability matrix

Legend: **Y** = first-party evidence of the capability; **P** = partial or materially bounded; **—** = first-party evidence of a limitation/absence; **?** = not verified in the sources reviewed. “Us” is source/test-verified code in this checkout, not a product promise.

| Capability bucket | Us | Cursor | Windsurf | Claude Code | Cowork | OpenAI Codex | Warp | Cline | Roo Code | Zed | Conductor |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| Multiple model/provider paths in one surface | **Y** Codex + Claude | P curated cloud models [C1] | Y model picker [C2] | P model/subagent choice [C3] | ? | ? | Y model selection [C6] | ? | Y model-agnostic, historical [C8] | **Y** agent paths + providers [C9] | **Y** runs multiple agent products [C10] |
| Real subagent/delegation primitive | **Y** blocking `spawn_subagent` | Y cloud agents [C1] | P simultaneous Cascades [C2] | **Y** custom/background subagents [C3] | ? | ? | P cloud agents [C6] | **Y** read-only subagents [C7] | — shutdown [C8] | P parallel threads [C9] | **Y** task workspaces [C10] |
| Parallel/background execution | **—** one child blocks parent | **Y** parallel cloud agents [C1] | **Y** simultaneous Cascades [C2] | **Y** concurrent background subagents [C3] | ? | ? | **Y** parallel cloud agents [C6] | **Y** parallel research agents [C7] | — | **Y** Parallel Agents [C9] | **Y** parallel agents [C10] |
| Automatic reviewer/auditor loop | **Y** shared-workspace audit + verdict feedback | ? hooks can run audit scripts [C1] | ? | ? | ? | ? | ? | ? | — | ? | P review path [C10] |
| Reversible workspace changes | **Y** file/turn undo; shell writes included | P isolated branch/VM [C1] | P named revert; revert itself not reversible [C2] | P rewind file edits only; Bash/external changes excluded [C4] | ? | ? | ? | ? | — | ? | P isolated workspace/archive [C10] |
| Native browser/computer control | **Y** persistent native browser + structured CDP/research | Y cloud agents can use computers/browser [C1] | ? MCP/web search, no sourced native browser [C2] | ? | ? | ? | Y hosted computers [C6] | **—** subagents cannot browser [C7] | — | ? | ? |
| Structured evidence/research artifacts | **Y** source coverage + saved artifacts | ? | ? | ? | ? | ? | ? | ? | ? | ? | ? |
| Explicit plan-before-build workflow | P conversational reviewer plan; no hard gate | **Y** editable Plan Mode then Build [C5] | **Y** planning agent + todo [C2] | **Y** built-in Plan subagent [C3] | ? | ? | **Y** `/plan` [C6] | ? | P Architect mode, historical [C8] | ? | ? |
| Desktop workspace composition | **Y** tabs, 1–4 panes, dock, traces | Y IDE/cloud/mobile surfaces [C1] | Y editor/Cascade | Y terminal/session | ? | Y CLI/IDE/cloud surfaces [C11] | Y terminal/agent conversation [C6] | Y VS Code/JetBrains/CLI [C7] | — shutdown | Y editor/agent panel | Y Mac workspace manager |

Source keys are links in the market-evidence table above: C1 Cursor, C2 Windsurf, C3 Claude Code subagents, C4 Claude Code checkpointing, C5 Cursor Plan Mode, C6 Warp, C7 Cline, C8 Roo Code, C9 Zed, C10 Conductor, C11 OpenAI Codex docs.

## Verdict by capability bucket

### Browser-native work: ahead on depth, not proven ahead on reach

Codex Desktop’s browser is a persistent Electron `WebContentsView`, not merely an external browser automation package. It combines logged-in session persistence with objective-ranked DOM extraction, shadow-tree traversal, coverage gaps, browser flows, CDP lifecycle/network/trace operations, and artifact-backed research. Cursor and Warp have first-party evidence for computer/browser control in remote environments, so the claim is not “we are the only agent that can use a browser.” The defensible claim is **structured, inspectable browser evidence inside a local workstation**.

**Rating: ahead in structured browser/research depth; on pace in general computer control.**

### Review and correctness: ahead in a narrow workflow

The reviewer dock is not just a manual second chat. The app watches the doer’s turn, uses checkpoint-ground-truthed file changes, supplies the request/steps/files to a different-provider reviewer, parses a pass/flag verdict, and can route a flagged report back to the main chat. The reviewer prompt is capped and the loop is bounded.

Cursor’s cloud hooks document audit scripts and subagent lifecycle hooks; Conductor documents a diff/review path. Neither reviewed source documents this exact automatic cross-provider shared-workspace audit loop. This is the strongest differentiation claim available from the evidence.

**Rating: ahead, but only for the implemented one-audit/one-bounce workflow.**

### Reversibility: ahead of the documented checkpoint baseline

Claude Code’s official checkpoint docs explicitly exclude Bash command changes and external changes. Codex Desktop’s `changedFiles()` compares the whole non-ignored worktree against the pre-turn checkpoint, and its tests cover shell-made modifications, additions, and deletions. Windsurf’s docs explicitly warn that its reverts are currently not reversible. That gives Codex Desktop a concrete correctness advantage over at least these two documented baselines.

**Rating: ahead on shell-write-aware local reversibility; unverified against the full market.**

### Provider choice: differentiated, but not category-exclusive

Codex Desktop routes Codex and Claude through one `SessionProvider` contract and can choose the child runtime from the model id. Zed documents multiple agent paths and LLM-provider choices; Warp documents model selection; Roo’s historical docs describe broad provider agnosticism; Conductor runs multiple agent products. The evidence supports **a strong integrated two-runtime experience**, not the claim that provider mixing is unique.

**Rating: on pace overall; ahead of single-provider desktop clients in integration quality, not in the abstract capability.**

### Subagents and parallelism: behind

The current child primitive is real, tested, and cross-provider, but it blocks the parent until one child finishes. Cursor, Windsurf, Claude Code, Warp, Cline, Zed, and Conductor all have first-party evidence for parallel or concurrent agent work, with different scopes and limits.

**Rating: behind on parallel orchestration.**

### Plan-first execution: behind the leaders’ interaction model

Codex Desktop has conversational intake and a rendered plan, and a paired reviewer can write the plan after user confirmation. It does not yet expose Cursor’s distinct editable Plan Mode with an explicit Build action. Windsurf, Claude Code, and Warp also document dedicated planning behavior. The missing piece is not planning text; it is **user-visible plan approval as a control point before execution**.

**Rating: behind on plan-mode UX and execution gating.**

### Desktop workstation surface: on pace, with a local-operator bias

Four-pane chat, persistent browser tabs, reviewer dock, live diffs, terminal cards, traces, attachments, mentions, and provider selection form a serious desktop surface. The tradeoff is deliberate: Codex Desktop is local and unrestricted, while Cursor/Warp/Conductor have stronger evidence for cloud, remote, or isolated execution and Cline/Zed have broader editor ecosystems.

**Rating: on pace for a local solo-operator workstation; behind on remote/background reach.**

## What we do that the reviewed competitors do not clearly document

These are the honest differentiators, phrased as “no evidence found in the reviewed first-party sources,” not universal absence claims:

- Automatic cross-provider review of the doer’s real shared-workspace diff, with a structured verdict and optional feedback back into the doer.
- A checkpoint-grounded reviewer trigger that catches shell writes even when the provider emits no file-change event. Claude Code’s own docs document the opposite limitation for its checkpoints.
- A single local surface combining persistent logged-in browser tabs, objective/coverage-aware snapshots, artifact-first research, CDP/network/performance diagnostics, and the reversible chat workspace.
- A reviewer that is born in the dock and defaults to a different provider family, rather than requiring the user to manually assemble a second opinion after the fact.

None of these claims says competitors cannot assemble the pieces through extensions, MCP, hooks, scripts, or multiple products. It says the reviewed official documentation did not show the same integrated behavior.

## Where we trail and what would change the verdict

The highest-leverage gaps are:

1. **Parallel gather:** let one lead spawn multiple workers and gather results without blocking on each child serially.
2. **Converging review loop:** turn the one-bounce audit into a bounded doer → reviewer → doer → reviewer loop with pass/budget/iteration termination.
3. **True Plan Mode:** editable plan, explicit approve/build action, and a hard pre-execution gate.
4. **Background/scheduled execution:** durable runs that continue when the local chat is not focused.
5. **Browser mutation depth:** file uploads, cookie/session controls, and request interception/routing/mocking.

If the first three land with live verification, the product would have a much stronger “ahead” claim: not because it would have every commodity agent feature, but because it would connect scale, correctness review, and browser-native execution in one coherent loop.

## Research limitations

The official OpenAI Codex URLs redirected into the current ChatGPT Learn app, which confirmed CLI/IDE/cloud surfaces but did not expose the requested feature details in the bounded extraction. Claude Cowork’s public help page rendered without usable passages. Roo Code’s official docs state the extension is shut down. Those cells remain unverified or inactive rather than being filled from memory.

The market changes quickly. This report is a dated evidence snapshot, not a permanent product taxonomy.

