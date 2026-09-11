/**
 * A small bash-ish reader for the permission gate. It executes nothing: it
 * splits a command line into segments (`&&`, `||`, `;`, `|`, `&`, newline)
 * respecting quotes, tokenizes each segment into words and output redirects,
 * follows `cd` so later segments resolve against the right directory, and
 * lists every filesystem mutation it can see. What it cannot see (variables,
 * substitutions, `xargs`, stdin lists) it reports as a problem so the rules
 * layer can ask instead of guess. No pi imports.
 */
import { resolvePath, type Resolved } from "./paths.ts";

export type Operator = "" | "&&" | "||" | ";" | "|" | "&" | "\n";

export interface Segment {
	/** The operator that joined this segment to the previous one. */
	op: Operator;
	/** Words with quotes removed; redirect operators and their targets are not included. */
	words: string[];
	/** Targets of `>`, `>>`, `&>`; an empty string marks a target the tokenizer could not read. */
	redirects: string[];
	/** The command word after `sudo`/`env`/… wrappers and `VAR=x` assignments: lower-cased basename without `.exe`. */
	verb: string;
	/** Words after the verb. */
	args: string[];
	/** Wrapper words that preceded the verb: sudo, nohup, … */
	wrappers: string[];
	/** True when a `$var`, backtick or `$(…)` appears anywhere in the segment. */
	dynamic: boolean;
	raw: string;
}

export type MutationKind = "delete" | "write" | "move" | "copy";

export interface Mutation {
	/** What did it: `rm`, `mv`, `>`, `find -delete`, … */
	verb: string;
	kind: MutationKind;
	/** The operand as written. */
	target: string;
	/** `rm -r`, `Remove-Item -Recurse`, `rd /s`. */
	recursive: boolean;
	/** `find … -delete`: bounded by a filter, never read as a whole-root deletion. */
	filtered: boolean;
	resolved?: Resolved;
	/** Why the target could not be resolved. */
	problem?: string;
}

export interface CommandReport {
	segments: Segment[];
	mutations: Mutation[];
}

/* ------------------------------------------------------------------------ */
/* Tokenizer                                                                */
/* ------------------------------------------------------------------------ */

const WRAPPERS = new Set(["sudo", "doas", "command", "exec", "nohup", "time", "builtin", "env", "timeout", "nice"]);

/** Wrapper flags that take a value. */
const WRAPPER_VALUE_FLAGS: Record<string, RegExp> = {
	sudo: /^-[ugChprt]$/,
	doas: /^-[uC]$/,
	nice: /^-n$/,
	timeout: /^-[ks]$/,
	env: /^-[uCS]$/,
};

function baseVerb(word: string): string {
	const name = word.replace(/^[({]+/, "").split(/[\\/]/).pop() ?? "";
	return name.toLowerCase().replace(/\.(exe|com)$/, "");
}

function buildSegment(op: Operator, words: string[], redirects: string[], raw: string, dynamic: boolean): Segment {
	if (words.length > 0) {
		words[0] = words[0].replace(/^[({]+/, "");
		words[words.length - 1] = words[words.length - 1].replace(/[)}]+$/, "");
	}
	const wrappers: string[] = [];
	let i = 0;
	while (i < words.length) {
		const word = words[i];
		if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(word)) {
			i++;
			continue;
		}
		const lower = baseVerb(word);
		if (!WRAPPERS.has(lower)) break;
		wrappers.push(lower);
		i++;
		while (i < words.length && words[i].startsWith("-")) {
			const flag = words[i++];
			if (WRAPPER_VALUE_FLAGS[lower]?.test(flag)) i++;
		}
		if (lower === "timeout" && i < words.length) i++; // the duration
		if (lower === "env") while (i < words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[i])) i++;
	}
	return { op, words, redirects, verb: baseVerb(words[i] ?? ""), args: words.slice(i + 1), wrappers, dynamic, raw: raw.trim() };
}

/** Split a command line into segments, respecting quotes, escapes and `$(…)`. */
export function splitSegments(command: string): Segment[] {
	const s = command.replace(/\r\n?/g, "\n");
	const segments: Segment[] = [];
	let op: Operator = "";
	let words: string[] = [];
	let redirects: string[] = [];
	let raw = "";
	let dynamic = false;
	let word = "";
	let hasWord = false;
	let quote: "'" | '"' | "`" | null = null;
	let subDepth = 0;
	let pending: "out" | "in" | null = null;

	const endWord = () => {
		if (hasWord || word) {
			if (pending === "out") redirects.push(word);
			else if (pending === null) words.push(word);
			pending = null;
		}
		word = "";
		hasWord = false;
	};
	const endSegment = (next: Operator) => {
		endWord();
		if (pending === "out") redirects.push("");
		pending = null;
		if (words.length || redirects.length) segments.push(buildSegment(op, words, redirects, raw, dynamic));
		words = [];
		redirects = [];
		raw = "";
		dynamic = false;
		op = next;
	};

	for (let i = 0; i < s.length; i++) {
		const ch = s[i];
		raw += ch;
		if (quote) {
			if (ch === quote) {
				quote = null;
				continue;
			}
			if (quote === '"' && ch === "\\" && i + 1 < s.length && '"\\$`'.includes(s[i + 1])) {
				word += s[++i];
				continue;
			}
			if (quote !== "'" && (ch === "$" || ch === "`")) dynamic = true;
			word += ch;
			continue;
		}
		if (subDepth > 0) {
			if (ch === "(") subDepth++;
			else if (ch === ")") subDepth--;
			word += ch;
			continue;
		}
		if (ch === "'" || ch === '"' || ch === "`") {
			quote = ch;
			hasWord = true;
			if (ch === "`") dynamic = true;
			continue;
		}
		if (ch === "\\") {
			const next = s[i + 1];
			if (next === undefined) continue;
			if (next === "\n") {
				i++;
				continue;
			}
			// Escape shell-special characters; keep `C:\dev\x` readable as a path.
			if (/[\s'"$`\\|&;<>()]/.test(next)) {
				word += next;
				i++;
			} else word += ch;
			hasWord = true;
			continue;
		}
		if (ch === "$") {
			dynamic = true;
			hasWord = true;
			if (s[i + 1] === "(") {
				subDepth = 1;
				word += "$(";
				i++;
			} else word += ch;
			continue;
		}
		if (ch === "\n" || ch === ";") {
			endSegment(ch === "\n" ? "\n" : ";");
			continue;
		}
		if (ch === "&") {
			if (s[i + 1] === "&") {
				i++;
				endSegment("&&");
			} else if (s[i + 1] === ">") {
				endWord();
				i++;
				if (s[i + 1] === ">") i++;
				pending = "out";
			} else endSegment("&");
			continue;
		}
		if (ch === "|") {
			if (s[i + 1] === "|") {
				i++;
				endSegment("||");
			} else {
				if (s[i + 1] === "&") i++;
				endSegment("|");
			}
			continue;
		}
		if (ch === ">" || ch === "<") {
			// `2>file`: a digits-only word glued to the operator is the descriptor.
			if (hasWord && /^\d+$/.test(word)) {
				word = "";
				hasWord = false;
			} else endWord();
			const out = ch === ">";
			if (out && (s[i + 1] === ">" || s[i + 1] === "|")) i++;
			else if (!out && s[i + 1] === "<") {
				i++;
				if (s[i + 1] === "<") i++;
			}
			if (s[i + 1] === "&") {
				i++;
				if (s[i + 1] === "-" || /\d/.test(s[i + 1] ?? "")) {
					while (/[\d-]/.test(s[i + 1] ?? "")) i++;
					continue; // fd duplication, no file
				}
			}
			pending = out ? "out" : "in";
			continue;
		}
		if (/\s/.test(ch)) {
			endWord();
			continue;
		}
		word += ch;
		hasWord = true;
	}
	endSegment("");
	return segments;
}

/* ------------------------------------------------------------------------ */
/* Mutations                                                                */
/* ------------------------------------------------------------------------ */

interface VerbSpec {
	kind: MutationKind;
	/** Which non-flag args are targets. */
	targets: "all" | "last" | "after-first";
	/** Flags that take a value. */
	consumes?: string[];
	recursive?: RegExp;
	/** Only a mutation when a flag matches (sed -i). */
	needsFlag?: RegExp;
	/** cmd.exe style `/s` flags. */
	slashFlags?: boolean;
}

const POSIX_RECURSIVE = /^-[a-zA-Z]*[rR]|^--recursive$/;
const CP_MV_CONSUMES = ["-t", "--target-directory", "-S", "--suffix"];

const VERBS: Record<string, VerbSpec> = {
	rm: { kind: "delete", targets: "all", recursive: POSIX_RECURSIVE },
	unlink: { kind: "delete", targets: "all" },
	shred: { kind: "delete", targets: "all" },
	rmdir: { kind: "delete", targets: "all", slashFlags: true, recursive: /^\/s$/i },
	mv: { kind: "move", targets: "all", consumes: CP_MV_CONSUMES },
	cp: { kind: "copy", targets: "last", consumes: CP_MV_CONSUMES },
	touch: { kind: "write", targets: "all", consumes: ["-d", "-r", "-t", "--date", "--reference"] },
	mkdir: { kind: "write", targets: "all", consumes: ["-m", "--mode"] },
	tee: { kind: "write", targets: "all" },
	truncate: { kind: "write", targets: "all", consumes: ["-s", "--size", "-r", "--reference"] },
	ln: { kind: "write", targets: "last", consumes: CP_MV_CONSUMES },
	chmod: { kind: "write", targets: "after-first", recursive: POSIX_RECURSIVE, consumes: ["--reference"] },
	chown: { kind: "write", targets: "after-first", recursive: POSIX_RECURSIVE, consumes: ["--reference"] },
	chgrp: { kind: "write", targets: "after-first", recursive: POSIX_RECURSIVE, consumes: ["--reference"] },
	sed: { kind: "write", targets: "after-first", needsFlag: /^(-i|--in-place)/, consumes: ["-e", "--expression", "-f", "--file"] },
	// cmd.exe
	del: { kind: "delete", targets: "all", slashFlags: true, recursive: /^\/s$/i },
	erase: { kind: "delete", targets: "all", slashFlags: true, recursive: /^\/s$/i },
	rd: { kind: "delete", targets: "all", slashFlags: true, recursive: /^\/s$/i },
	move: { kind: "move", targets: "all", slashFlags: true },
	copy: { kind: "copy", targets: "last", slashFlags: true },
	xcopy: { kind: "copy", targets: "last", slashFlags: true },
	// PowerShell (flags are dropped; `-Path X` keeps X as a target)
	"remove-item": { kind: "delete", targets: "all", recursive: /^-recurse$/i },
	ri: { kind: "delete", targets: "all", recursive: /^-recurse$/i },
	"move-item": { kind: "move", targets: "all" },
	mi: { kind: "move", targets: "all" },
	"copy-item": { kind: "copy", targets: "last" },
	cpi: { kind: "copy", targets: "last" },
	"new-item": { kind: "write", targets: "all" },
	ni: { kind: "write", targets: "all" },
	"set-content": { kind: "write", targets: "all" },
	"add-content": { kind: "write", targets: "all" },
	"clear-content": { kind: "write", targets: "all" },
	"out-file": { kind: "write", targets: "all" },
};

function isFlag(word: string, spec: VerbSpec): boolean {
	if (word.startsWith("-") && word !== "-") return true;
	return !!spec.slashFlags && /^\/[a-zA-Z](:.*)?$/.test(word);
}

/** Non-flag operands of a verb, honouring `--` and value-taking flags. */
function operands(args: string[], spec: VerbSpec): { targets: string[]; recursive: boolean; consumed: number } {
	const out: string[] = [];
	let recursive = false;
	let consumed = 0;
	let literal = false;
	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (!literal && arg === "--") {
			literal = true;
			continue;
		}
		if (!literal && isFlag(arg, spec)) {
			if (spec.recursive?.test(arg)) recursive = true;
			if (spec.consumes?.includes(arg)) {
				i++;
				consumed++;
			}
			continue;
		}
		if (arg === "-") continue;
		out.push(arg);
	}
	return { targets: out, recursive, consumed };
}

function targetsOf(verb: string, args: string[], spec: VerbSpec): { targets: string[]; recursive: boolean } {
	if (spec.needsFlag && !args.some((a) => spec.needsFlag?.test(a))) return { targets: [], recursive: false };
	const { targets, recursive, consumed } = operands(args, spec);
	switch (spec.targets) {
		case "all":
			return { targets, recursive };
		case "last":
			return { targets: targets.length > 1 ? targets.slice(-1) : [], recursive };
		case "after-first":
			// sed with -e/-f: the script was consumed, every operand is a file.
			return { targets: verb === "sed" && consumed > 0 ? targets : targets.slice(1), recursive };
	}
}

/** `find [paths] [expr]`: paths are the leading non-flag args. */
function findMutations(args: string[]): Array<{ target: string; kind: MutationKind; verb: string }> {
	const paths: string[] = [];
	let i = 0;
	while (i < args.length && !args[i].startsWith("-") && args[i] !== "(" && args[i] !== "!") paths.push(args[i++]);
	if (paths.length === 0) paths.push(".");
	const rest = args.slice(i);
	const out: Array<{ target: string; kind: MutationKind; verb: string }> = [];
	if (rest.includes("-delete")) for (const p of paths) out.push({ target: p, kind: "delete", verb: "find -delete" });
	const exec = rest.findIndex((a) => /^-(exec|execdir|ok|okdir)$/.test(a));
	if (exec >= 0) {
		const execVerb = baseVerb(rest[exec + 1] ?? "");
		const spec = VERBS[execVerb];
		if (spec) {
			for (const p of paths) out.push({ target: p, kind: spec.kind, verb: `find -exec ${execVerb}` });
			const execArgs = rest.slice(exec + 2).filter((a) => a !== "{}" && a !== ";" && a !== "+" && a !== "\\;");
			for (const t of targetsOf(execVerb, execArgs, spec).targets) out.push({ target: t, kind: spec.kind, verb: `find -exec ${execVerb}` });
		}
	}
	return out;
}

/**
 * Every filesystem mutation in a command, with targets resolved against the
 * cwd in effect for their segment (`cd` is followed).
 */
export function parseCommand(command: string, cwd: string, home: string): CommandReport {
	const segments = splitSegments(command);
	const mutations: Mutation[] = [];
	let dir: string | undefined = cwd;

	const add = (verb: string, kind: MutationKind, target: string, recursive: boolean, filtered = false) => {
		const m: Mutation = { verb, kind, target, recursive, filtered };
		if (dir === undefined) m.problem = "runs after a cd the gate could not follow";
		else if (target === "") m.problem = "redirect target missing";
		else {
			const resolved = resolvePath(target, dir, home);
			if (resolved) m.resolved = resolved;
			else m.problem = `"${target}" is a variable or substitution the gate cannot resolve`;
		}
		mutations.push(m);
	};

	for (const seg of segments) {
		for (const target of seg.redirects) add(">", "write", target, false);

		const { verb, args } = seg;
		if (verb === "cd" || verb === "pushd" || verb === "set-location" || verb === "sl") {
			const arg = args.find((a) => !a.startsWith("-"));
			if (arg === undefined) dir = home;
			else if (dir === undefined) dir = undefined;
			else dir = resolvePath(arg, dir, home)?.path;
			continue;
		}
		if (verb === "xargs") {
			const inner = args.find((a) => !a.startsWith("-"));
			const innerVerb = inner ? baseVerb(inner) : "";
			if (VERBS[innerVerb]) mutations.push({ verb: `xargs ${innerVerb}`, kind: VERBS[innerVerb].kind, target: "(stdin)", recursive: true, filtered: true, problem: "targets arrive on stdin" });
			continue;
		}
		if (verb === "find") {
			for (const m of findMutations(args)) add(m.verb, m.kind, m.target, true, true);
			continue;
		}
		if (verb === "dd") {
			for (const arg of args) if (arg.startsWith("of=")) add("dd", "write", arg.slice(3), false);
			continue;
		}
		const spec = VERBS[verb];
		if (!spec) continue;
		const { targets, recursive } = targetsOf(verb, args, spec);
		targets.forEach((target, i) => {
			// `mv a b c dest`: the sources move away, the destination is written.
			const kind = spec.kind === "move" && targets.length > 1 && i === targets.length - 1 ? "write" : spec.kind;
			add(verb, kind, target, recursive);
		});
	}
	return { segments, mutations };
}
