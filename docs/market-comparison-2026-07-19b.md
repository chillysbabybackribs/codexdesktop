# Codex Desktop: current capability and market comparison

**Observed:** 2026-07-19  
**Repository state audited:** `master` at `700e04afdfb7703bb08ec39618078176501e04f0`  
**Verification:** `npm run typecheck` passed; `npm test` passed (**595/595**).  
**Method:** source/test inspection for Codex Desktop, then two bounded passes over current first-party competitor documentation. The prior `market-comparison-2026-07-19.md` was used only to identify candidates; its claims were not reused as evidence.

## Decision

**Overall: on pace as a local agent workstation, but behind the market leaders on execution scale.**

Codex Desktop is not merely repeating the standard agent-chat pattern. It has one technically meaningful, currently implemented bundle that the reviewed official competitor sources did not document as an integrated product:

1. a **persistent, logged-in local browser** with structured, coverage-aware extraction, artifact-backed research, and CDP diagnostics;
2. **turn rollback based on the actual Git worktree**, including shell-created modifications, additions, and deletions; and
3. a **cross-provider reviewer** that reads the shared workspace diff and can return a flagged finding to the doer.

That is a real advantage in correctness and local operator control. It is **not** evidence that no competitor can assemble equivalent pieces through extensions, scripts, or another product.

It does not make the product market-leading overall. Cursor, Claude Code, Cline, Zed, Warp, Cascade, Devin, and OpenAI Codex all document one or more capabilities Codex Desktop does not yet match in this audit: explicit plan-to-build control, parallel agents, cloud/background execution, isolated environments, remote management, or browser/computer execution at scale.

## What the codebase actually ships

| Capability | Code-verified fact | Boundary that matters |
| --- | --- | --- |
| Two runtime paths | A common [`SessionProvider`](/home/dp/Desktop/soloapps/codexdesktop/src/main/providers/session-provider.ts:35) is implemented by Codex and Claude; IPC routes a new thread by model prefix and injects the same child-spawn bridge into both ([`codex-ipc.ts`](/home/dp/Desktop/soloapps/codexdesktop/src/main/codex/codex-ipc.ts:44)). | Claude deliberately has no steering, remote compaction, goals, or plugins ([`claude-provider.ts`](/home/dp/Desktop/soloapps/codexdesktop/src/main/providers/claude-provider.ts:67)). This is a genuine two-runtime surface, not full feature parity. |
| Persistent local browser | The browser is an Electron `WebContentsView` on the persistent `persist:codex-browser` partition ([`browser-tab-view.ts`](/home/dp/Desktop/soloapps/codexdesktop/src/main/browser/browser-tab-view.ts:1)). | It is local and user-profile based; this is not a cloud browser fleet or a first-class cookie-management API. |
| Structured browser read path | `browser_snapshot` combines navigation, readiness, and objective-ranked extraction; the suite covers one queued snapshot and named coverage gaps ([`browser-agent.test.ts`](/home/dp/Desktop/soloapps/codexdesktop/src/main/browser/browser-agent.test.ts:76)). | Strong for evidence-oriented reads; this audit found no exposed request-routing/mocking capability. |
| Artifact-first research | The runner serializes work per thread, uses a bounded candidate contract, writes artifacts, and stops when the requested evidence coverage is met ([`research-runner.ts`](/home/dp/Desktop/soloapps/codexdesktop/src/main/browser/research-runner.ts:167)). | It improves evidence discipline, not the inherent trustworthiness of a web page. |
| CDP diagnostics | The test suite covers response-body artifacts, screenshots/PDF, tracing, a bounded network journal, and performance diagnostics ([`browser-agent.test.ts`](/home/dp/Desktop/soloapps/codexdesktop/src/main/browser/browser-agent.test.ts:180)). | Deep observation is not browser traffic interception. |
| Checkpoint-backed undo | Each turn has a Git-ref checkpoint; `changedFiles()` compares the checkpoint tree with the current worktree ([`turn-checkpoint.ts`](/home/dp/Desktop/soloapps/codexdesktop/src/main/turn-checkpoint.ts:167)). Tests cover shell-made modifications, additions, and deletions ([`turn-checkpoint.test.ts`](/home/dp/Desktop/soloapps/codexdesktop/src/main/turn-checkpoint.test.ts:160)). | It requires a Git worktree and is local workspace recovery, not a general filesystem transaction system. |
| Shared-workspace audit | The audit prompt explicitly directs the reviewer to inspect `git diff HEAD`, not receive the full transcript ([`audit-trigger.ts`](/home/dp/Desktop/soloapps/codexdesktop/src/renderer/src/audit-trigger.ts:106)); it parses `VERDICT: pass|flag` and limits automatic feedback to one bounce ([`audit-trigger.ts`](/home/dp/Desktop/soloapps/codexdesktop/src/renderer/src/audit-trigger.ts:153)). | It is a one-pass audit/feedback loop, not a converging reviewer-controller. Busy reviewers are skipped. |
| Subagent primitive | The orchestrator is expressly **“Phase 1: blocking single”**: parent waits for one child’s final answer, and parallel fan-out is named Phase 2 ([`subagent-orchestrator.ts`](/home/dp/Desktop/soloapps/codexdesktop/src/main/agents/subagent-orchestrator.ts:9)). | This is the clearest execution-scale gap: it is real and tested, but sequential. |
| Intake and plan handoff | Fresh paired chats can restate an ask, wait for confirmation, have a Reviewer prepare a plan, and inject it into execution ([`main-chat-intake.ts`](/home/dp/Desktop/soloapps/codexdesktop/src/renderer/src/main-chat-intake.ts:1)). | It is conversational confirmation, not an editable plan artifact with an explicit build/approval gate. |
| Local workspace composition | Split logic supports up to four panes ([`chat-split.ts`](/home/dp/Desktop/soloapps/codexdesktop/src/renderer/src/chat-split.ts:27)), and the app has persisted memory plus bounded, Git-indexed `@` file/folder mentions ([`memory-store.ts`](/home/dp/Desktop/soloapps/codexdesktop/src/main/memory-store.ts:18), [`mention-index.ts`](/home/dp/Desktop/soloapps/codexdesktop/src/main/mention-index.ts:74)). | A rich desktop cockpit does not by itself provide durable cloud jobs or team-scale coordination. |

## Market evidence observed today

All links below are first-party pages observed on 2026-07-19. A missing cell means **no first-party evidence found in this bounded review**, not that the product lacks the feature.

| Product | Fresh official evidence | What it establishes |
| --- | --- | --- |
| [Cursor](https://cursor.com/docs/agent/plan-mode) | Plan Mode says the agent researches, creates a plan users can edit, then users click to build. [Cloud Agents](https://cursor.com/docs/cloud-agent) says agents run in isolated cloud VMs, can run in parallel without the local machine connected, and can use desktop/browser computers. | Clear lead in explicit plan approval and remote parallel execution. |
| [Claude Code](https://code.claude.com/docs/en/sub-agents) | Official subagent docs describe independent contexts, tool restrictions, and background subagents. [Checkpoint docs](https://code.claude.com/docs/en/checkpointing) say checkpoints track file-edit-tool changes, explicitly not Bash or external changes. | Clear lead in parallel agent work; directly comparable rollback limitation. |
| [Cline](https://docs.cline.bot/features/subagents) | Experimental subagents launch simultaneously for read-only research and return reports to the main agent; docs explicitly exclude editing, browser, MCP, and nesting. | Clear lead in parallel research, but a materially narrower child capability than Codex Desktop's spawned worker. |
| [Zed](https://zed.dev/docs/ai/agents) | Zed documents native agents, external ACP agents (including Codex and Claude), terminal threads, and “Parallel Agents.” | Strong multi-agent and multi-harness workstation evidence. |
| [Warp](https://docs.warp.dev/agent-platform/local-agents/interacting-with-agents/terminal-and-agent-modes/) | Local agent conversations have model selection and conversation controls; cloud agent conversations run in isolated environments, can run parallel agents, use hosted computers, and are remotely manageable. | Strong remote/background and terminal-native execution evidence. |
| [Cascade / Devin Desktop](https://docs.devin.ai/desktop/cascade/cascade) | The current docs support multiple Cascades running simultaneously and explicitly warn of edit races without worktree isolation. | Parallel local tasking exists, but its own docs surface a coordination hazard. |
| [Devin](https://docs.devin.ai/get-started/devin-intro) | Devin describes autonomous write/run/test work, many tasks in parallel, PR review, and an interactive browser with upload/download. | Strong cloud-agent execution and browser capability evidence. |
| [OpenAI Codex](https://help.openai.com/en/articles/11369540-codex-in-chatgpt) | The current Help Center page lists desktop, CLI, IDE, and web surfaces; documents local and cloud tasks, scheduled tasks, in-app browser, Computer Use, and CDP Developer Mode. | Codex itself covers more durable/cloud execution and browser surfaces; this pass did not establish a public cross-provider reviewer equivalent. |

### Coverage gaps retained on purpose

- The requested [GitHub Copilot coding-agent URL](https://docs.github.com/en/copilot/how-tos/use-copilot-agents/coding-agent/about-coding-agent) returned 404 in this observation. No replacement claim is made.
- [Conductor's documentation root](https://www.conductor.build/docs) did not yield enough substantive public content in this pass. No capability is inferred.
- The previous Windsurf URL redirected to current Devin Desktop documentation; this report cites that current page as Cascade rather than treating old branding as a separate verified product.

## Capability comparison

Legend: **Y** = documented or source-verified; **P** = partial/bounded; **—** = a documented limitation; **?** = not established in the reviewed first-party source.

| Capability | Codex Desktop | Cursor | Claude Code | Cline | Zed | Warp | Cascade | Devin | OpenAI Codex |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Editable plan followed by explicit build action | **P** conversational confirm + reviewer plan | **Y** | P planning agents | ? | ? | P `/plan` tooling | ? | ? | ? |
| Parallel agents | **—** one blocking child | **Y** cloud parallel | **Y** background subagents | **Y** read-only research | **Y** | **Y** cloud parallel | **Y** simultaneous Cascades | **Y** many tasks | ? |
| Durable/remote execution | **—** no project-native cloud job identified | **Y** isolated cloud VMs | P depends on surface | ? | ? | **Y** cloud environments | ? | **Y** autonomous service | **Y** cloud tasks/scheduled tasks |
| Local logged-in browser plus deep CDP diagnostics | **Y** | P computer/browser in VM | ? | **—** child browser prohibited | ? | P hosted computer | ? | **Y** interactive browser | **Y** in-app browser + CDP mode |
| Undo that includes shell writes | **Y** worktree comparison | ? | **—** Bash/external changes excluded | ? | ? | ? | ? | ? | ? |
| Automatic cross-provider shared-diff audit with feedback to doer | **Y** | ? | ? | ? | ? | ? | ? | ? | ? |
| Multiple runtime/agent paths in one desktop surface | **Y** Codex + Claude | P model choices | P subagent models | ? | **Y** native/external/terminal paths | P model selection | ? | ? | P multiple clients/surfaces |

## Verdict by dimension

| Dimension | Rating | Evidence-based reading |
| --- | --- | --- |
| Rollback correctness | **Ahead, narrowly** | Codex Desktop tests worktree-level changes from shell writes. Claude Code's official checkpoint documentation expressly excludes Bash and external changes. This is a concrete advantage over that documented baseline; the rest of the market remains unverified. |
| Reviewer loop | **Differentiated, not proven unique** | The shared-diff, cross-provider, verdict-and-feedback mechanism is present in source. None of the reviewed first-party sources documents that exact integrated loop. This is bounded absence-of-evidence, not proof that competitors cannot do it. |
| Browser/research workstation | **Differentiated, not exclusive** | Codex Desktop integrates persistent authenticated tabs, objective/coverage-aware extraction, saved research artifacts, and CDP/network/performance inspection. Devin and OpenAI Codex document browser and CDP capabilities; Cursor and Warp document computer/browser use in cloud environments. The difference is local integration and evidence tooling, not browser access alone. |
| Provider flexibility | **On pace** | A shared Codex/Claude runtime boundary is useful and real, but Zed already documents native, external, and terminal agent paths; Cursor and Warp also document model selection. The claim should be “integrated two-runtime operation,” not “unique multi-provider support.” |
| Plan-first UX | **Behind** | Conversational confirmation is valuable, but Cursor has the stronger documented interaction contract: edit the plan, then click to build. |
| Parallel orchestration | **Behind** | Source comments make Codex Desktop intentionally sequential today. Cursor, Claude Code, Cline, Zed, Warp, Cascade, and Devin all document some form of concurrent work. |
| Long-running/remote execution | **Behind** | Cursor, Warp, Devin, and OpenAI Codex document cloud or scheduled execution. This checkout is built around an active local Electron workstation. |

## Direct answer: are we ahead, on pace, behind, or doing what everyone does?

**Not “what everyone does.”** The shell-write-aware checkpoint plus cross-provider shared-diff audit is a legitimate, defensible wedge. It is the strongest claim the code supports today.

**Not broadly ahead.** The market leaders are ahead in the workflow people notice most on large tasks: edit-and-approve planning, multiple agents at once, isolated background execution, and remote follow-up.

**Net: on pace for a high-control local workstation, behind for autonomous execution scale.** Position it as a **local correctness-and-evidence workstation**, not yet as the fastest or most autonomous coding-agent platform.

## What would change the answer fastest

1. **Parallel gather with bounded fan-out/gather.** This directly closes the source-declared Phase 2 gap without abandoning the local shared-workspace advantage.
2. **A bounded doer → reviewer → doer convergence controller.** Preserve checkpoint reversibility, but turn the current one-bounce audit into an explicit stop-on-pass / budget-capped loop.
3. **An editable plan artifact with a real Build gate.** This is the visible UX gap against Cursor's documented plan contract.
4. **Durable background runs.** A local-first implementation can still offer persisted/scheduled continuation; it need not imitate a cloud fleet to erase the biggest product-perception gap.

## Limits of this comparison

This is a dated product-and-code snapshot, not a complete feature inventory for every competitor. Official product pages change quickly, and several products expose important behavior through entitlement-dependent or authenticated surfaces. The report deliberately leaves unsupported competitor cells unknown rather than converting missing documentation into negative claims.
