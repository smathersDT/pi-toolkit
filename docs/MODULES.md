# Writing a toolkit module

Read this before adding or changing a module. It is short on purpose.

## Layout

```
pi-toolkit/
  index.ts              entry point: loads enabled modules, registers /toolkit
  core/                 shared code — do not import pi-specific modules from here
    kit.ts              Toolkit context + ToolkitModule type + built-in tool patch pipeline
    frame.ts            the boxed tool frame (FrameTop / FrameBottom / Frame / frameLines)
    settings.ts         <agent-dir>/toolkit/settings.json
    paths.ts            agentDir(), toolkitDir(), toolkitPath(...), readJson, writeJsonAtomic
    text.ts             stripAnsi, replayCarriageReturns, foldIdenticalLines, formatDuration, formatUsd …
    cache-policy.ts     cachePolicyFor(model) → { checkInSeconds | null }
    ledger.ts           kit.ledger.add(moduleId, bytesBefore, bytesAfter)
    role.ts             kit.role: { isChild, role, depth, maxTurns, maxTokens }
    menu.ts             the /toolkit command
  modules/
    index.ts            MODULES array (the entry point sorts by `order`)
    <id>/index.ts       exports `const module: ToolkitModule` as default
    <id>/*.ts           helpers, pi-free where possible
    <id>/test/*.test.ts node:test files using ../../../test/harness.ts
  test/harness.ts       FakePi, makeCtx, plainTheme, tempAgentDir, renderContext
```

## The module contract

```ts
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Toolkit, ToolkitModule } from "../../core/kit.ts";

const DEFAULTS = { somethingBytes: 8192 };

const module: ToolkitModule = {
  id: "my-module",              // settings key, menu id, ledger name
  label: "My module",
  description: "One line, shown in /toolkit",
  default: true,                // on unless settings.json says otherwise
  order: 40,                    // load order; hooks fire in registration order
  child: "never",               // "always" | "never" | ["researcher", "worker"]
  setup(pi, kit) {
    const cfg = kit.config("my-module", DEFAULTS);   // merged over defaults
    pi.on("tool_result", (event, ctx) => { ... });
    kit.ledger.add("my-module", before, after);       // bytes removed from context
  },
};
export default module;
```

Rules:

- **Cost first.** Anything that adds text to the system prompt, a tool schema, or a
  tool result must earn it. Prefer `promptGuidelines` of one short bullet over a
  paragraph. Never inject text into context that the model does not need on every turn.
- **Display-only stays display-only.** Use `pi.appendEntry` + `pi.registerEntryRenderer`
  for transcript lines, `ctx.ui.setWidget/setStatus/setWorkingMessage` for chrome.
  Put structured data in `details`, not in `content`.
- **Everything renders in the frame.** Tools set `renderShell: "self"` and return
  `FrameTop` from `renderCall` and `FrameBottom` from `renderResult`. Collapsed output
  is at most 6 lines; the hint says how to expand. Command output goes through
  `kit.print(title, headLines, bodyLines, state?)`, which appends a display-only
  transcript entry drawn in the frame (never `ctx.ui.notify` for multi-line text: it
  paints one dim line and replaces the previous status).
- **Config lives in settings.json** under the module id (`kit.config`), unless it is
  large user-edited data (agents, permissions rules), which gets its own file under
  `kit.paths.toolkitDir`. Create such files with defaults on first use so users can edit them.
- **State lives under `<agent-dir>/toolkit/`** (`toolkitPath("learn", ...)`). Never write
  into the extension directory or the project directory.
- **Fail open.** A module bug must never break the session: wrap risky work in try/catch,
  return `undefined` from hooks on error, and log with `kit.log(id, msg)`.
- **Children.** `kit.role.isChild` is true inside a subagent process; there is no TUI
  there (`ctx.mode` is "json"/"print" and `ctx.hasUI` is false). Guard dialogs.
- **Cross-platform.** Windows (Git Bash) and macOS. Use `node:path`, never hardcode
  slashes, and normalize `\r\n`.

## TypeScript constraints

Files are executed by pi through jiti and by tests through Node's built-in type
stripping (`node --test x.test.ts`). Strip-only mode forbids:

- constructor parameter properties (`constructor(public x: string)`) — declare fields
- `enum`, `namespace`, decorators, `import x = require()`
- value imports of types: use `import type { … }`

Always import relative files with the `.ts` extension. No npm dependencies: pi
provides `@earendil-works/pi-coding-agent`, `@earendil-works/pi-tui`,
`@earendil-works/pi-ai` and `typebox`. Node built-ins are fine.

## Built-in tool patches

Several modules wrap the same built-in tool. Do **not** call `pi.registerTool` for a
built-in name. Use:

```ts
kit.patchTool("bash", (def) => ({
  ...def,
  renderShell: "self",
  renderCall(args, theme, context) { ... },
  async execute(id, params, signal, onUpdate, ctx) { return def.execute(id, params, signal, onUpdate, ctx); },
}));
```

Patches compose in load order; the entry point registers the final definition once.

## Tests

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { FakePi, makeCtx, tempAgentDir } from "../../../test/harness.ts";
import module from "../index.ts";
import { createToolkit } from "../../../core/kit.ts";

test("does the thing", async () => {
  tempAgentDir();                       // isolates settings/state
  const pi = new FakePi();
  const kit = createToolkit(pi as any, { modules: {} });
  await module.setup(pi as any, kit);
  const result = await pi.chainToolResult({ toolName: "bash", toolCallId: "1", input: {}, content: [{ type: "text", text: "..." }], details: {}, isError: false }, makeCtx());
  assert.equal(...);
});
```

Run one module: `node --test modules/<id>/test/*.test.ts`. Run all: `npm test`.
First run `node scripts/link-pi.mjs` once so bare node can resolve pi's packages.
