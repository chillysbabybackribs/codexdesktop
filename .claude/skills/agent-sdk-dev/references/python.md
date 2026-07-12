# Python Route

Use this reference only for Python Claude Agent SDK applications. Consult the current [Python SDK reference](https://code.claude.com/docs/en/agent-sdk/python) for the target version's API concepts.

## Discover The Project Contract

Inspect:

- `pyproject.toml`, requirements files, constraint files, and the active lockfile;
- the existing environment manager, such as uv, Poetry, PDM, Pipenv, or a project virtual environment;
- the selected interpreter and the project's declared Python range;
- source entrypoints, tests, configured linters or type checkers, and environment conventions;
- the declared, locked, and installed Agent SDK distribution versions;
- installed distribution metadata, module exports, and callable signatures when the environment is available.

Do not introduce a second environment manager or install into a global interpreter when the project already defines an environment.

## Dependency And Runtime Rules

- Confirm the current distribution name, stable version, and `Requires-Python` metadata before adding the SDK.
- For an existing project, keep the locked version unless an upgrade is in scope.
- Use the project's existing dependency group and lock workflow.
- Derive the Python minimum and transitive constraints from current distribution metadata and official Agent SDK docs. Do not preserve a remembered runtime minimum in generated files.
- Keep optional environment-loading packages optional unless the project already uses one or the user requests it.

## Review SDK Usage

Check the implementation against the installed package and current docs:

- imports, options, and callable signatures exist in the selected version;
- asynchronous iterators and message variants are handled deliberately;
- tool names, permission behavior, hooks, MCP configuration, subagents, and session options match the selected API;
- tool and filesystem access are scoped to the actual use case;
- exceptions, cancellation, subprocesses, clients, streams, and other resources are cleaned up appropriately;
- resumable state or session identifiers are persisted only when required;
- no examples from the general `anthropic` API client package were accidentally mixed into `claude_agent_sdk` code.

Avoid baking a full SDK example into this skill. Shape new code from the current reference and verify it against installed exports and signatures.

## Validate

Run checks through the project's selected environment manager or interpreter:

1. dependency or lockfile consistency;
2. syntax compilation for changed modules;
3. an import smoke check in the selected environment;
4. configured type, lint, and test commands relevant to the change;
5. an offline test of message/tool/session behavior where applicable;
6. an explicitly authorized live smoke test only when required.

An import check can still miss authentication, subprocess, permission, and live protocol failures. Do not treat it as an end-to-end test. If imports fail because the environment is not installed, report the environment gap separately from source-code defects.

Record the interpreter, environment manager, SDK version, and exact commands used in the final report.
