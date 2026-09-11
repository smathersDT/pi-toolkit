// A stand-in for `pi --mode json`: prints JSON event lines the way a real child
// would. Scenario from `--scenario <name>`; everything else on argv is ignored.
const argv = process.argv.slice(2);
const at = argv.indexOf("--scenario");
const scenario = at >= 0 ? argv[at + 1] : "ok";

const out = (o) => process.stdout.write(`${JSON.stringify(o)}\n`);
const usage = (input, output) => ({
	input,
	output,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: input + output,
	cost: { input: input / 1e6, output: (output * 4) / 1e6, cacheRead: 0, cacheWrite: 0, total: (input + output * 4) / 1e6 },
});
const assistant = (text, u, stopReason = "stop") => ({
	role: "assistant",
	content: text ? [{ type: "text", text }] : [],
	api: "fake",
	provider: "test",
	model: "fake",
	usage: u,
	stopReason,
});

out({ type: "session", version: 3, id: "fake", timestamp: new Date().toISOString(), cwd: process.cwd() });
out({ type: "agent_start" });

switch (scenario) {
	case "ok": {
		out({ type: "turn_start" });
		out({ type: "message_start", message: assistant("", usage(0, 0), "pending") });
		out({ type: "message_end", message: assistant("Looking at the log.", usage(100, 20), "toolUse") });
		out({ type: "tool_execution_start", toolCallId: "t1", toolName: "bash", args: { command: "git log --oneline -3" } });
		out({ type: "tool_execution_end", toolCallId: "t1", toolName: "bash", result: { content: [{ type: "text", text: "abc123 fix" }] }, isError: false });
		out({ type: "turn_start" });
		out({ type: "message_end", message: assistant("Final report: all good.\nEvidence: src/a.ts:12", usage(200, 50)) });
		out({ type: "turn_end", message: {}, toolResults: [] });
		out({ type: "agent_end", messages: [] });
		process.exit(0);
		break;
	}
	case "env": {
		out({ type: "turn_start" });
		const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => k.startsWith("PI_TOOLKIT_")));
		out({ type: "message_end", message: assistant(JSON.stringify({ env, argv }), usage(1, 1)) });
		process.exit(0);
		break;
	}
	case "fail": {
		process.stderr.write("Error: no API key for provider test\n");
		process.exit(2);
		break;
	}
	case "error-message": {
		out({ type: "turn_start" });
		out({ type: "message_end", message: { ...assistant("", usage(0, 0), "error"), errorMessage: "rate limited" } });
		process.exit(1);
		break;
	}
	case "big-usage": {
		out({ type: "turn_start" });
		out({ type: "message_end", message: assistant("partial findings", usage(3_000_000, 10), "toolUse") });
		// keep running so the parent's kill is observable
		setInterval(() => out({ type: "tool_execution_start", toolCallId: "t", toolName: "read", args: { path: "x" } }), 25);
		setTimeout(() => process.exit(0), 10_000);
		break;
	}
	case "big-final": {
		out({ type: "turn_start" });
		out({ type: "message_end", message: assistant("full report", usage(2_000_000, 10)) });
		process.exit(0);
		break;
	}
	case "steady": {
		// 40k tokens a turn with tool calls, like a researcher re-reading its context
		let n = 0;
		const timer = setInterval(() => {
			n++;
			out({ type: "turn_start" });
			out({ type: "message_end", message: assistant(`turn ${n} text`, usage(40_000, 0), "toolUse") });
			if (n >= 50) {
				clearInterval(timer);
				process.exit(0);
			}
		}, 20);
		break;
	}
	case "many-turns": {
		let n = 0;
		const timer = setInterval(() => {
			n++;
			out({ type: "turn_start" });
			out({ type: "message_end", message: assistant(`turn ${n} text`, usage(10, 5), "toolUse") });
			if (n >= 400) {
				clearInterval(timer);
				process.exit(0);
			}
		}, 20);
		break;
	}
	default:
		process.stderr.write(`unknown scenario ${scenario}\n`);
		process.exit(3);
}
