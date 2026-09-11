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
import { existsSync, mkdirSync, rmSync, symlinkSync } from "node:fs";
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

const targetRoot = join(root, "node_modules");
mkdirSync(targetRoot, { recursive: true });
for (const name of ["@earendil-works", "typebox", "jiti"]) {
	const from = join(source, name);
	const to = join(targetRoot, name);
	if (!existsSync(from)) continue;
	rmSync(to, { recursive: true, force: true });
	symlinkSync(from, to, process.platform === "win32" ? "junction" : "dir");
	console.log(`${to} -> ${from}`);
}
