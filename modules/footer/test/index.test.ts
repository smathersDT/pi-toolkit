import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { createToolkit } from "../../../core/kit.ts";
import { FakePi, makeCtx, plainTheme, tempAgentDir } from "../../../test/harness.ts";
import { resetKeepaliveState, state as keepalive } from "../../keepalive/api.ts";
import module, { hostOf, sessionCost } from "../index.ts";

/** A TUI ctx whose `setFooter` is captured, plus a fake footer data provider. */
function tuiSetup(options: { entries?: unknown[]; statuses?: Map<string, string>; usage?: unknown } = {}) {
	const dir = tempAgentDir();
	const pi = new FakePi();
	const kit = createToolkit(pi as any, { modules: {} });
	kit.enabled.add("keepalive");
	kit.enabled.add("permissions");
	const ctx = makeCtx({ entries: options.entries });
	ctx.getContextUsage = () => options.usage;
	let factory: any;
	ctx.ui.setFooter = (f: any) => {
		factory = f;
	};
	const tui = { requestRender: () => {} };
	const footerData = {
		getExtensionStatuses: () => options.statuses ?? new Map<string, string>(),
		getGitBranch: () => "main",
		getAvailableProviderCount: () => 1,
		onBranchChange: () => () => {},
	};
	const view = () => factory(tui, plainTheme, footerData);
	return { dir, pi, kit, ctx, view, factory: () => factory };
}

describe("footer module", () => {
	it("registers /footer and installs a two-line footer only in the TUI", async () => {
		const s = tuiSetup();
		await module.setup(s.pi as any, s.kit);
		assert.ok(s.pi.commands.has("footer"));

		await s.pi.emit("session_start", {}, makeCtx({ mode: "print" }));
		assert.equal(s.factory(), undefined, "no footer for a headless run");

		await s.pi.emit("session_start", {}, s.ctx);
		assert.equal(typeof s.factory(), "function");
		const view = s.view();
		const lines = view.render(100);
		view.dispose();
		assert.equal(lines.length, 2);
		assert.ok(lines[0].startsWith("$0  test-model · medium"), lines[0]);
		assert.ok(lines[0].includes("$1/$4/$0.1"), lines[0]);
		assert.equal(lines[1], "", "no perms chip, even with the permissions module on");
	});

	it("shows cost, context, jobs, agents and other statuses", async () => {
		const entries = [
			{ type: "message", message: { role: "assistant", usage: { cost: { total: 0.03 } } } },
			{ type: "message", message: { role: "toolResult", usage: { cost: { total: 0.012 } } } },
			{ type: "message", message: { role: "user" } },
		];
		const statuses = new Map([
			["subagent", "subagent: 2 running"],
			["ide", "ide: ✓ repo"],
		]);
		const s = tuiSetup({ entries, statuses, usage: { tokens: 31_000, contextWindow: 1_000_000, percent: 3.1 } });
		mkdirSync(join(s.dir, "toolkit"), { recursive: true });
		writeFileSync(join(s.dir, "toolkit", "permissions.json"), JSON.stringify({ mode: "yolo" }));
		resetKeepaliveState();
		keepalive.registry.start({ tool: "bash", label: "sleep", run: () => new Promise(() => {}) });
		try {
			await module.setup(s.pi as any, s.kit);
			await s.pi.emit("session_start", {}, s.ctx);
			const view = s.view();
			const lines = view.render(100);
			view.dispose();
			assert.ok(lines[0].startsWith("$0.042  test-model · medium"), lines[0]);
			assert.ok(lines[0].includes("ctx 31k/1M 3%"), lines[0]);
			assert.match(lines[1], /^bg 1 job \d+s  agents 2 running  ide ✓ repo$/);
		} finally {
			resetKeepaliveState();
		}
	});

	it("`/footer off` restores pi's footer and `on` brings this one back", async () => {
		const s = tuiSetup();
		await module.setup(s.pi as any, s.kit);
		await s.pi.emit("session_start", {}, s.ctx);
		const cmd = s.pi.commands.get("footer")!;
		await cmd.handler("off", s.ctx);
		assert.equal(s.factory(), undefined);
		await cmd.handler("on", s.ctx);
		assert.equal(typeof s.factory(), "function");
		await cmd.handler("", s.ctx);
		assert.equal(s.factory(), undefined, "no argument toggles");
		assert.ok(s.ctx.ui.notifications.every((n: any) => n.message.startsWith("footer:")));
	});

	it("`/footer account` explains a provider with no probe", async () => {
		const s = tuiSetup();
		await module.setup(s.pi as any, s.kit);
		await s.pi.commands.get("footer")!.handler("account", s.ctx);
		assert.deepEqual(s.ctx.ui.notifications.at(-1), { message: "footer: no account probe for test", type: "info" });
	});

	it("sums the session cost the way pi's footer does, and reads hosts safely", () => {
		assert.equal(
			sessionCost([
				{ type: "message", message: { role: "assistant", usage: { cost: { total: 1 } } } },
				{ type: "compaction", usage: { cost: { total: 0.5 } } },
				{ type: "message", message: { role: "user" } },
			]),
			1.5,
		);
		assert.equal(
			sessionCost([
				{ type: "custom", customType: "toolkit-spend", data: { usage: { cost: { total: 0.25 } } } },
				{ type: "custom", customType: "toolkit-spend", data: { usage: { cost: { total: 0.5 } } } },
				{ type: "message", message: { role: "toolResult", usage: { cost: { total: 0.75 } }, details: { spendBooked: true } } },
				{ type: "message", message: { role: "toolResult", usage: { cost: { total: 2 } } } },
				{ type: "custom", customType: "other", data: { usage: { cost: { total: 9 } } } },
			]),
			2.75,
			"spend entries count once; a spendBooked tool result is not counted again",
		);
		assert.equal(hostOf(undefined), undefined);
		assert.equal(hostOf("https://api.deepseek.com/v1"), "api.deepseek.com");
		assert.equal(hostOf("relay.internal/v1"), "");
	});
});
