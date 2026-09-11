/**
 * Load pi-toolkit through pi's real extension loader (jiti) in a throwaway
 * agent dir and report what it registered. No model calls, no network.
 *
 *   node scripts/check.mjs [installed-pi-package-dir] [--child <role>]
 *
 * The package dir defaults to the one linked into ./node_modules.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const childIndex = args.indexOf("--child");
const childRole = childIndex >= 0 ? args[childIndex + 1] : undefined;
const pkgArg = args.find((a, i) => !a.startsWith("--") && (childIndex < 0 || i !== childIndex + 1));
const pkg = pkgArg ?? path.join(root, "node_modules", "@earendil-works", "pi-coding-agent");
if (!fs.existsSync(path.join(pkg, "dist", "core", "extensions", "loader.js"))) {
	console.error(`pi package not found at ${pkg}; run node scripts/link-pi.mjs or pass the package dir`);
	process.exit(1);
}

const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-toolkit-check-"));
process.env.PI_CODING_AGENT_DIR = agentDir;
process.env.PI_OFFLINE = "1";
if (childRole) {
	process.env.PI_TOOLKIT_ROLE = childRole;
	process.env.PI_TOOLKIT_DEPTH = "1";
}

try {
	const { loadExtensions } = await import(pathToFileURL(path.join(pkg, "dist", "core", "extensions", "loader.js")));
	const started = Date.now();
	const loaded = await loadExtensions([path.join(root, "index.ts")], process.cwd());
	const ms = Date.now() - started;
	if (loaded.errors.length) {
		console.error("load errors:");
		for (const e of loaded.errors) console.error(" ", e.path ?? "", e.error ?? e);
		process.exit(1);
	}
	const ext = loaded.extensions[0];
	const tools = [...(ext.tools?.keys?.() ?? [])];
	const commands = [...(ext.commands?.keys?.() ?? [])];
	const events = [...(ext.handlers?.keys?.() ?? [])];
	const shortcuts = [...(ext.shortcuts?.keys?.() ?? [])];
	console.log(`loaded ${path.basename(root)} in ${ms}ms${childRole ? ` as child role "${childRole}"` : ""}`);
	console.log(`tools (${tools.length}): ${tools.join(", ")}`);
	console.log(`commands (${commands.length}): ${commands.map((c) => `/${c}`).join(", ")}`);
	console.log(`shortcuts (${shortcuts.length}): ${shortcuts.join(", ")}`);
	console.log(`events (${events.length}): ${events.join(", ")}`);
	// Prompt cost: what each registered tool adds to every request.
	let promptChars = 0;
	for (const [name, entry] of ext.tools ?? []) {
		const tool = entry.definition ?? entry;
		const schema = JSON.stringify(tool.parameters ?? {});
		const chars = (tool.description?.length ?? 0) + schema.length + (tool.promptSnippet?.length ?? 0) + (tool.promptGuidelines ?? []).join("").length;
		promptChars += chars;
		console.log(`  ${name.padEnd(16)} ~${Math.ceil(chars / 4)} tokens/request`);
	}
	console.log(`registered tools add ~${Math.ceil(promptChars / 4)} tokens to every request (built-in overrides replace pi's own, so their cost is not new)`);
} finally {
	fs.rmSync(agentDir, { recursive: true, force: true });
}
