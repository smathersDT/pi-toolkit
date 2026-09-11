/**
 * Link the installed pi packages into ./node_modules so tests can run under
 * bare node. pi itself does not need this: its loader aliases its own packages
 * for extensions.
 *
 *   node scripts/link-pi.mjs [path-to-node_modules-containing-@earendil-works]
 *
 * Without an argument it looks at PI_PACKAGE_DIR, then `~/.pi2/install`, then
 * the global npm root.
 */
import { execSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, rmSync, symlinkSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const candidates = [
	process.argv[2],
	process.env.PI_PACKAGE_DIR,
	join(homedir(), ".pi2", "install", "node_modules"),
	safe(() => execSync("npm root -g", { encoding: "utf8" }).trim()),
].filter(Boolean);

function safe(fn) {
	try {
		return fn();
	} catch {
		return undefined;
	}
}

const source = candidates.find((dir) => existsSync(join(dir, "@earendil-works", "pi-coding-agent")));
if (!source) {
	console.error("Could not find an installed @earendil-works/pi-coding-agent. Pass its node_modules directory as the first argument.");
	process.exit(1);
}

const agent = join(source, "@earendil-works", "pi-coding-agent");
const packages = ["@earendil-works/pi-ai", "@earendil-works/pi-agent-core", "@earendil-works/pi-tui", "typebox", "jiti"];
// A fresh install keeps pi's own packages nested under pi-coding-agent (its
// shrinkwrap); an older one may have hoisted them next to it.
const locate = (name) => [join(agent, "node_modules", name), join(source, name)].find((dir) => existsSync(dir));

const targetRoot = join(root, "node_modules");
const scope = join(targetRoot, "@earendil-works");
// Earlier versions linked the whole scope; remove that link so the per-package
// links below are not written into the pi install.
if (lstatSync(scope, { throwIfNoEntry: false })?.isSymbolicLink()) rmSync(scope);
mkdirSync(scope, { recursive: true });
for (const [name, from] of [["@earendil-works/pi-coding-agent", agent], ...packages.map((name) => [name, locate(name)])]) {
	if (!from) continue;
	const to = join(targetRoot, name);
	rmSync(to, { recursive: true, force: true });
	symlinkSync(from, to, process.platform === "win32" ? "junction" : "dir");
	console.log(`${to} -> ${from}`);
}
