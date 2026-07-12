# Verification Matrix

Use this matrix for reviews, post-change checks, and readiness claims. Evaluate only gates that apply to the requested behavior, but record every skipped material gate.

| Gate | Required evidence | Failure examples |
| --- | --- | --- |
| Project contract | Runtime, environment/package manager, manifest, lockfile, and relevant repository instructions agree | Unsupported runtime; conflicting active lockfiles; wrong environment used for checks |
| SDK resolution | Declared, locked, and installed versions are known and compatible with the selected target | Missing dependency; lockfile mismatch; accidental prerelease or unintended upgrade |
| API contract | Imports, exports, signatures, options, and message handling match installed metadata/types and current official docs | Missing symbol; invalid option; unhandled required message/result path |
| Static validation | Applicable syntax, import, typecheck, and build commands succeed | Syntax, import, type, or build error in the supported path |
| Offline behavior | Relevant tests exercise deterministic message, tool, permission, hook, session, and failure logic | Incorrect tool result; broken resume flow; failure path leaks or hangs |
| Authentication and secrets | Selected provider is documented; no hardcoded, logged, or committed credentials | Exposed credential; unsupported auth flow; secret file tracked |
| Permissions and tool scope | Tools, filesystem scope, callbacks, and approval behavior are least-privileged for the use case | Unnecessary broad access; permission bypass; unsafe default working directory |
| Optional SDK features | Each configured hook, MCP server, subagent, or session feature is version-correct and tested as far as claimed | Invalid configuration; lifecycle leak; feature silently unused |
| Live behavior | When required and authorized, a minimal call proves authentication, streaming, tool use, and cleanup relevant to the claim | Live initialization, auth, protocol, permission, or tool failure |
| Reproducibility | Setup, run, and test instructions match the checked toolchain and lock state | Clean setup cannot reproduce the verified path; undocumented required state |

## Gate Statuses

Record one status and its command or evidence for each applicable gate:

- `PASS`: the required evidence was observed and the applicable check succeeded.
- `WARN`: non-blocking risk, ambiguity, or degraded coverage remains.
- `FAIL`: verified evidence shows the supported path is broken, unsafe, or violates the selected SDK contract.
- `NOT RUN`: a check was relevant but could not or should not be executed; include the reason.
- `N/A`: the gate does not apply to the requested behavior; include a short rationale when that is not obvious.

## Overall Verdict

- **PASS**: every applicable required gate passed; no material warning is open.
- **PASS WITH WARNINGS**: no applicable gate failed, but one or more non-blocking risks or coverage limits remain.
- **FAIL**: at least one applicable gate failed in a way that breaks functionality, security, SDK correctness, or the requested acceptance criteria.
- **INCOMPLETE**: missing access, dependencies, environment state, authorization, or evidence prevented a core verdict.

A skipped live call does not automatically prevent a static or offline `PASS` when live behavior was outside scope. It does prevent claims such as “end-to-end verified,” “production-ready,” or “deployment-ready” when those claims depend on authentication, permissions, external tools, cost controls, or live failure handling.

## Report Shape

1. Overall verdict and one-sentence scope.
2. Findings ordered by severity, with file and line evidence.
3. Compact gate results with commands or evidence.
4. Versions and official documentation consulted.
5. Checks not run, assumptions, and remaining limitations.
