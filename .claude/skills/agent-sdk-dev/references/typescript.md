# TypeScript Route

Use this reference only for TypeScript Claude Agent SDK applications. Consult the current [TypeScript SDK reference](https://code.claude.com/docs/en/agent-sdk/typescript) for the target version's API concepts.

## Discover The Project Contract

Inspect:

- `package.json`, its `packageManager` and `engines` fields, and relevant scripts;
- the one active lockfile and the package manager that owns it;
- `tsconfig.json` and any extended configs;
- source entrypoints, tests, build configuration, and existing environment conventions;
- the declared, locked, and installed Agent SDK versions;
- installed package exports and `.d.ts` files when dependencies are present.

Multiple lockfiles or a mismatch between the manifest, lockfile, and installed tree is evidence to resolve, not permission to regenerate everything.

## Dependency And Runtime Rules

- Confirm the current package identifier and stable version through official registry metadata before adding a dependency.
- For an existing project, keep the locked version unless an upgrade is in scope.
- Use the repository's package manager. Do not switch between npm, pnpm, yarn, or bun merely for convenience.
- Derive Node.js, TypeScript, module-resolution, and module-format requirements from the selected SDK version and project configuration.
- Do not assume that `"type": "module"` or one particular `tsconfig` preset is universally required.

## Review SDK Usage

Check the implementation against installed declarations and current docs:

- imports and option names exist in the selected package version;
- asynchronous message streams are consumed correctly and relevant result/message variants are handled deliberately;
- tool names, permission behavior, hooks, MCP configuration, subagents, and session options match the selected API;
- tool and filesystem access are scoped to the actual use case;
- cancellation, process cleanup, stream errors, and tool failures have appropriate handling;
- resumable state or session identifiers are stored and reused only when the use case requires it;
- no generic Anthropic client-SDK types or examples were accidentally mixed into Agent SDK code.

Avoid baking a full SDK example into this skill. Shape new code from the current reference and verify it against the installed type declarations.

## Validate

Prefer commands already declared by the project:

1. dependency or lockfile consistency check supported by the selected manager;
2. the declared typecheck command;
3. the declared build command;
4. relevant unit or integration tests;
5. an offline test of message/tool/session behavior where applicable;
6. an explicitly authorized live smoke test only when required.

If the project has no typecheck script, use its already-installed local TypeScript compiler in a way that cannot fetch a package. Do not use `npx tsc` when `npx` may download an undeclared compiler. A clean typecheck proves type consistency, not successful authentication, permissions, tool execution, or live model behavior.

Record the runtime, package manager, SDK version, and exact commands used in the final report.
