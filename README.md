# pi-toolkit

One extension for the [pi coding agent](https://www.npmjs.com/package/@earendil-works/pi-coding-agent)
that bundles many small tools, each switchable from a menu. Cost is the first
design constraint: every module exists to make a session cheaper, or to make the
work it does visible without adding tokens to the prompt.

```
/toolkit            open the module menu (enter toggles, esc closes, then reloads)
/toolkit list       print modules and their state
/toolkit on|off <id>
/toolkit stats      bytes the modules removed from context this session
/toolkit path       where the settings file lives
```

## Install

**Auto-discovered (this machine):** the package lives under the agent's extension
directory, so pi loads it on start:

```
~/.pi2/agent/extensions/toolkit/index.ts      → re-exports ./pi-toolkit/index.ts
~/.pi2/agent/extensions/toolkit/pi-toolkit/   → this package
```

**As a package (any machine):** install a release tag; pin a newer tag to upgrade.

```sh
pi install git:github.com/smathersDT/pi-toolkit@v0.1.0
pi remove git:github.com/smathersDT/pi-toolkit
pi -e git:github.com/smathersDT/pi-toolkit      # try it for one run without installing
```

Releases: https://github.com/smathersDT/pi-toolkit/releases. Do not combine a
package install with the auto-discovered copy above, or every module registers twice.

`package.json` declares `"pi": { "extensions": ["./index.ts"] }`; there are no
npm dependencies (pi provides `@earendil-works/*` and `typebox`). Requires
Node 22.19+ (24 recommended) and pi 0.84+. Works on Windows (Git Bash) and macOS.

## Modules

| id | what it does | default |
|---|---|---|
| `permissions` | Claude-Code-style approval gate: refuses destructive commands, asks before risky ones, one global rules file | on |
| `prune` | collapses pi's docs routing table out of the system prompt; drops unused built-in tools (`find`, `ls`) | on |
| `compact` | tool-output and pasted-prompt compaction: ANSI/CR hygiene, line folding, log masking with a legend, JSON→TOON, per-tool caps with spill files | on |
| `images` | downsizes screenshots to the provider's own fit (Anthropic 1568px / 1.15MP) | on |
| `auto-learn` | asks the model to save a verified repo lesson after a tool failure; lessons expire after 7 days, near-duplicates refused, injected write-once with a transcript row | on |
| `tool-fixes` | `grep` retries a pattern that is not a valid regex as a literal; on Windows `bash` says it is Git Bash, not PowerShell | on |
| `keepalive` | hands control back before the provider cache expires during long tool calls; `wait` collects the job | on |
| `subagent` | `delegate` tool: capped child pi processes with roles; model, thinking and caps per role in `toolkit/subagents.json` | on |
| `web` | `web_search` / `web_fetch` inside the web subagent; `/web` lookup in the main session | on |
| `session` | `session_search` / `session_read` over the last two weeks of transcripts, inside the session subagent | on |
| `tool-style` | every tool renders in the boxed frame while it runs, then shrinks to one summary line | on |
| `thinking-hud` | animated working row with a request clock; reasoning text hidden; one settle line with the request's total time | on |
| `footer` | two-line footer: spend, model, thinking, rates, context use, account balance/quota; chips for background jobs, running agents and extension statuses | on |
| `model-sync` | daily refresh of official prices (DeepSeek, OpenAI, Anthropic, Copilot catalogue) into `models.json` | on |
| `sticky-model` | the model and thinking level you switch to become the defaults for the next session | on |
| `alias` | `/clear`, `/exit`, `/q` | on |
| `clear-on-exit` | clears the terminal when pi exits | on |
| `pre-send` | `ctrl+q` queues prompts while the agent works (on Windows/WSL via pi's own follow-up key); `/queue` manages them | on |
| `editor` | prompt history that survives restarts | on |

### The frame

```
/--BASH-------------------------------
| git status --porcelain
|
| M src/index.ts
| ?? notes.md
| … +14 lines (ctrl+o to expand)
\--------------------------------------
```

Header colour: yellow while running, green when done, red on error. While a
tool runs its collapsed frame shows six lines (the tail for `bash`, the head for
everything else). Once it finishes the row shrinks to one line:

```
✓ READ src/a.ts:1-40 · 40 lines
✓ BASH npm test · 42 lines · Tests: 12 passed
✗ GREP foo( · src · rg: regex parse error:
```

The tools key (`ctrl+o` by default), or a click, expands it back to the frame. Toolkit tools (`delegate`, `wait`,
`learn`, `web_*`, `session_*`) and command output use the same frame.

### The HUD

While a request runs the working row reads `Thinking… 12s   (esc to interrupt)`,
then `Responding…`, `Running bash…`, `Running 3 tools…`, with one clock for the
whole request. Reasoning text is hidden (the module sets `hideThinkingBlock` in
pi's settings once). When the request settles one transcript line records it:

```
✻ Worked for 41s
```

### The footer

```
$0.042  deepseek-v4-pro · high (shift+tab) · $0.28/$0.42/$0.028   ctx 31k/1M 3%        balance $11.09
bg 1 job 2m  agents 2 running
```

Line one: session spend, model, thinking level with its cycle key, per-1M
rates (hidden for free models), context use, and the account behind the model
(Copilot premium quota, DeepSeek balance, Codex 5h/7d windows, OpenAI monthly
spend with an admin key). Line two: background jobs, running delegate children,
and any other extension status. Nothing is fetched unless
a TUI footer is on screen; probes run every 5 minutes and after each turn under
a 60-second floor. `/footer off` restores pi's footer; `/footer account` re-probes.

### Subagents

`delegate({ role, task, context?, ownedFiles?, model?, thinking?, maxTurns?, maxTokens?, background? })`
or `delegate({ tasks: [...] })` for a concurrent batch. `background: true` returns a
`[background] job d-N started` reply at once so the agent can keep working; it collects
the report with `wait({ id })`, or gets it as a follow-up message if the turn ends first
(needs the keepalive module; without it the call blocks as usual). Roles and their defaults:

| role | model | thinking | turns | tokens | tools |
|---|---|---|---|---|---|
| researcher | inherit | medium | 25 | 600k | read, grep, find, ls, bash |
| scout | cheap | low | 10 | 250k | read, grep, find, ls |
| finder | cheap | off | 8 | 250k | grep, find, ls, read |
| git | cheap | low | 12 | 250k | bash (read-only git only), read |
| web | cheap | low | 12 | 250k | web_search, web_fetch |
| test | cheap | off | 6 | 250k | bash (test runners, checks such as `php -l` / `node --check` / `git diff --check`, any `pwsh`), read |
| worker | inherit | medium | 40 | 1M | read, write, edit (inside `ownedFiles`), bash, grep, find, ls |
| session | cheap | low | 10 | 250k | session_search, session_read |

`cheap` resolves to the first entry of `cheapModels` that is available, else the
cheapest available model. Everything is editable in `<agent-dir>/toolkit/subagents.json`
(written with defaults on first use; a sample with explicit model and thinking
choices per role is in `docs/subagents.sample.json`). A local model (a `local`
provider in `models.json`, or any loopback `baseUrl`) is probed before spawning;
when the server does not answer, the role's `fallback` model is used instead
(else the next cheap non-local model) and the result notes the swap. Children run
`pi --mode json -p --no-extensions -e <toolkit> --tools <role tools>`, enforce
their own caps (a steer message near the cap, tool calls blocked at it), and are
killed by the parent past the cap, the timeout, or escape. The token cap counts
input + output + cache over every turn and is never below 250k or the role's own
cap (`maxTokens` only raises it); a child on a local model has no token cap. The
parent never kills a final report, and a child calling tools past the cap is
killed only once it is two turns of its current size over (within 120–200 % of
the cap). Each child's
usage is booked as a `toolkit-spend` session entry the moment it ends (inline,
background, failed or cancelled), so the footer total includes it; the tool result
still carries it for pi's own `/session` stats. `/subagents` prints roles,
resolved models and caps. A role's `allow` (regex sources) lets extra bash
commands through the git/test gate; from the second blocked call on, the child is
told to stop and report.

### Compaction

Tool results are cleaned on the way into the session (they are re-sent on every
later request): ANSI and progress frames removed, identical runs folded
(`[+N identical lines]`), similar log lines folded, repeated long tokens replaced
by `§n` with a `[legend: …]` line (lossless), JSON turned into TOON when smaller,
and every result capped per tool (bash 8KB tail, grep 16KB, read 64KB, …) with
the full text spilled to `<agent-dir>/toolkit/spill/` and its path in the marker.
Source-file reads stay byte-exact so edits can quote them. A cut that would not
reclaim its own marker's bytes is skipped; a first line over the cap is cut
mid-line and spills. Jobs collected with `wait` keep the profile of the tool that
started them. Tool-call validation failures lose pi's echo of the arguments
(folded in the `context` hook, since pi skips `tool_result` for them; `echo:
false` turns it off). Pasted prompts get the same lossless hygiene.
`/compact-stats` shows the session ledger.

### Cache keepalive

A `bash` or `delegate` call that would block past the current model's cache TTL
(Anthropic and Copilot 5 min, direct OpenAI GPT-5.6+ 30 min, Codex WebSocket
idle ~5 min, DeepSeek none) returns early with `[background] job b-1 still
running…`. The model calls `wait`, an ordinary request that keeps the prefix warm.
`/keepalive` shows the policy; `/keepalive ttl <provider/model> <seconds>` overrides it.

### Auto-learn

A failed tool call (non-zero exit, failed edit, permission refusal; not a file
tool given a wrong path) gets a note, stored once in its result, asking the model
to save a verified lesson with `learn({ failureId, lesson })`. Lessons live in
`<agent-dir>/toolkit/learn/<repo>.json` (20 per repo, 800 chars, 7-day expiry);
an exact or near-duplicate is refused with the existing text so the model can
replace it. Everything the model sees is written once, so the cache never breaks:

- session start: every lesson of the repo, as a message after the prompt
- mid-run: a lesson saved by this session, a subagent or another session rides
  on the next tool result
- another repo: the first tool call touching a path in a different git repo
  brings that repo's lessons on its own result

The transcript shows `◆ LEARNED · repo · ~N tok` for each save and
`◆ INJECTED · trigger · repo · N lessons · ~N tok` for each delivery. `/learn`
lists them; `/learn forget <n>`.

### Permissions

`<agent-dir>/toolkit/permissions.json`:

```json
{ "mode": "block", "workspaces": [], "allow": ["Bash(git push:*)"], "deny": [], "askOnce": true }
```

`block` (the default) never prompts: it refuses only the block tier (rm of a
root or home, format/mkfs/dd, `curl | sh`, force-push to main, writes to shell
profiles or `~/.ssh`, `npm publish`, `DROP DATABASE`, …) and runs everything else
silently. `guard` additionally asks before the confirm tier (`git reset --hard`,
`git clean -f`, recursive deletes, writes outside the cwd/workspaces/temp,
`sudo`, …); `strict` refuses that tier without asking; `yolo` allows all but
`deny` rules. `/permissions mode|add|allow|deny`.

## Settings

`<agent-dir>/toolkit/settings.json` (created on first change):

```json
{
  "modules": { "web": false },
  "compact": { "guidance": true, "spillDays": 3 },
  "keepalive": { "marginSeconds": 45, "ttlOverrides": { "openai/gpt-5.6": 1800 } },
  "session": { "days": 14, "toolsInMain": false },
  "web": { "toolsInMain": false, "keys": { "brave": "..." } },
  "prune": { "docs": true, "dropTools": ["find", "ls"] },
  "auto-learn": { "ttlDays": 7, "maxPerRepo": 20 },
  "thinking-hud": { "hideThinkingText": true, "spinner": "braille" }
}
```

`modules` holds the switches; every other key is one module's configuration,
merged over its defaults.

Environment: `PI_TOOLKIT_DEBUG=1` logs module loads to stderr;
`PI_TOOLKIT_LEARN=off`, `PI_TOOLKIT_MODEL_SYNC=off`, `PI_TOOLKIT_PRUNE_DOCS=always|never`.

## Commands

| command | module |
|---|---|
| `/toolkit [list|on|off|stats|path]` | core |
| `/permissions [mode g|s|y] [add <dir>] [allow|deny <pattern>]` | permissions |
| `/prune` | prune |
| `/compact-stats` | compact |
| `/images` | images |
| `/learn [forget <n>] [on|off]` | auto-learn |
| `/keepalive [ttl <provider/model> <seconds>]` | keepalive |
| `/subagents [edit]` | subagent |
| `/web <query>`, `/web key <brave|tavily|serper> [key]` | web |
| `/sessions <query>` | session |
| `/model-sync [provider] [--verify]`, `/model-sync prices` | model-sync |
| `/footer [on|off|account]` | footer |
| `/queue [hold|go|drop <n>|pop|clear]` | pre-send |
| `/clear`, `/exit`, `/q` | alias |

## Development

```sh
node scripts/link-pi.mjs        # once: link the installed pi packages into node_modules
npm test                        # node --test over core and every module (638 tests)
node scripts/check.mjs          # load through pi's real loader; list registrations and prompt cost
node scripts/check.mjs --child web
```

Module conventions: [docs/MODULES.md](docs/MODULES.md). Adding a module is one
directory under `modules/` plus one line in `modules/index.ts`.

### Releasing

```sh
npm version patch               # or minor/major: bumps package.json, commits, tags vX.Y.Z
git push --follow-tags
```

The tag starts `.github/workflows/release.yml`: tests on Ubuntu and Windows against
the latest pi, then a GitHub release with generated notes. With an `NPM_TOKEN`
repository secret it also publishes to npm (`pi install npm:pi-toolkit`).
