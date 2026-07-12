---
name: agent-sdk-dev
description: Build, modify, debug, upgrade, or verify Claude Agent SDK applications in TypeScript or Python. Use for scaffolding an app, adding Agent SDK features such as tools, permissions, hooks, MCP, subagents, or sessions, investigating integration failures, or reviewing an app before testing or deployment. Do not use for ordinary Anthropic client SDK or raw Messages API work that does not use the Claude Agent SDK.
---

# Claude Agent SDK Development

Build and assess Claude Agent SDK applications from evidence that applies to the project's selected SDK version. Keep scaffolding, implementation, diagnosis, and verification distinct so a static check is never presented as proof of live behavior.

## Route The Request

Classify the task before acting:

- **Scaffold**: create a new application and its minimum working structure.
- **Change or upgrade**: modify an existing application while preserving its established toolchain and unrelated behavior.
- **Diagnose**: identify the cause of a failure; do not implement a fix unless the user also asks for one.
- **Verify or review**: inspect and report findings without changing files unless the user asks for fixes.

Read [references/typescript.md](references/typescript.md) for a TypeScript project or [references/python.md](references/python.md) for a Python project. Read [references/verification-matrix.md](references/verification-matrix.md) before issuing a verification verdict.

## Establish The Source Of Truth

Inspect before asking questions or editing. Use this evidence order:

1. Repository instructions and the user's request.
2. Project manifests, lockfiles, configuration, source, and existing tests.
3. Installed package metadata, exports, type declarations, and signatures for the selected SDK version.
4. Current official Claude Agent SDK documentation and package-registry metadata.

Start with the current [Agent SDK overview](https://code.claude.com/docs/en/agent-sdk/overview), then open only the language and feature pages needed by the task. Do not substitute the general Anthropic API client SDK documentation for Agent SDK documentation.

If current documentation or registry access is unavailable, continue from local version-specific evidence when that is sufficient. State what could not be checked and do not fill version, runtime, symbol, or option gaps from memory.

Record these facts before implementation:

- language, runtime, environment manager, and package manager;
- declared, locked, and installed SDK versions when available;
- target SDK version and why it was selected;
- module system or Python packaging conventions already in use;
- authentication provider and Agent SDK features in scope;
- official pages consulted and the date they were observed.

## Resolve Requirements Efficiently

Infer answers from the request and checkout first. Ask only for unresolved choices that materially alter the result, and group related questions into one compact round when possible. Typical blocking choices are language for a new project, target directory, package or environment manager when none exists, authentication provider, and whether a billed live smoke test is authorized.

Do not force the upstream plugin's preset agent categories or minimal/basic/example menu when the user's intended behavior is already clear.

## Select Versions Deliberately

- For an existing app, preserve its locked SDK version unless the user requested an upgrade or the fix requires one.
- For a new app, select the current stable release that is compatible with the chosen runtime and toolchain, based on registry metadata and official requirements.
- Never silently choose a prerelease, rewrite a lockfile with another package manager, or describe a version as current/latest without live registry evidence.
- Ask before changing the project's runtime baseline, module system, environment manager, or package manager.

## Implement The Narrowest Complete Change

1. Inspect existing helpers and call sites before adding abstractions.
2. Preserve the repository's layout, scripts, naming, and dependency-management conventions.
3. Derive imports, option names, message shapes, and feature configuration from the target version's installed metadata or current official documentation.
4. Add only the Agent SDK capabilities required by the use case.
5. Keep tool access and filesystem scope least-privileged. Make the working directory explicit when behavior depends on it.
6. Add useful failure handling for initialization, streaming, tool execution, cancellation, and cleanup where those paths apply.
7. Document the exact setup and run path without embedding credentials.

For a new scaffold, create the smallest example that demonstrates the requested agent behavior. Avoid generated subagents, hooks, MCP servers, commands, or elaborate architecture unless the use case needs them.

## Security And External Effects

- Never request that the user paste a secret into chat, hardcode a credential, print it, or commit it.
- Use the selected provider's current official authentication variables and setup guidance. An `.env.example` is optional, not proof of secure configuration.
- Ensure real secret files are ignored when the project uses them, without overwriting existing ignore rules.
- Do not make a billed model call, deploy, enable broad permissions, or exercise destructive tools without explicit authorization.
- Prefer deterministic offline tests for message handling, tool callbacks, permission decisions, and session logic before a live smoke test.

## Verify In Layers

Use the project's declared commands and selected environment. Run the narrowest relevant checks first, then broaden in proportion to the requested claim:

1. manifest, lockfile, runtime, and installed-version consistency;
2. syntax, import, and type validation;
3. relevant build and tests;
4. offline Agent SDK behavior and failure paths;
5. an explicitly authorized minimal live smoke test when live behavior is part of the acceptance criteria.

Do not let a convenience command download an undeclared compiler, test runner, or package as a side effect. Do not claim the app works, is verified, or is deployment-ready when only syntax or type checks ran.

## Report The Outcome

For implementation, lead with what now works, then list the important files, selected SDK version, checks run, and the exact next command for the user. For a review or diagnosis, lead with findings ordered by severity and include file and line evidence where possible.

Use the verdict vocabulary from the verification matrix. Always separate:

- checks that ran and their results;
- checks that were not run and why;
- version or documentation assumptions;
- remaining security, cost, permission, or deployment limitations.

Link the official pages that support material SDK claims. Do not pad the report with generic style advice or repeat passed checks at length.
