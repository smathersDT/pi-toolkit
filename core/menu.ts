/**
 * `/toolkit` — the on/off menu for every module, plus a few subcommands:
 *
 *   /toolkit            open the menu
 *   /toolkit list       print modules and their state
 *   /toolkit on <id>    enable a module (then reload)
 *   /toolkit off <id>   disable a module (then reload)
 *   /toolkit stats      this session's savings ledger
 *   /toolkit path       where the settings file lives
 *
 * Toggles are written to settings.json immediately; the process reloads its
 * extensions when the menu closes with changes, so the new set takes effect
 * without restarting pi.
 */
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { getSettingsListTheme } from "@earendil-works/pi-coding-agent";
import { Container, type SettingItem, SettingsList, Text } from "@earendil-works/pi-tui";
import { moduleEnabled, type Toolkit, type ToolkitModule } from "./kit.ts";
import { saveSettings, settingsPath } from "./settings.ts";

export function registerMenu(pi: ExtensionAPI, kit: Toolkit, modules: ToolkitModule[]): void {
	pi.registerCommand("toolkit", {
		description: "Toolkit: toggle modules, show stats (/toolkit list|on|off|stats|path)",
		getArgumentCompletions: (prefix) => {
			const words = ["list", "on", "off", "stats", "path"];
			const [head, tail] = prefix.split(/\s+/, 2);
			if (tail !== undefined && (head === "on" || head === "off")) {
				const items = modules.filter((m) => m.id.startsWith(tail)).map((m) => ({ value: `${head} ${m.id}`, label: `${head} ${m.id}` }));
				return items.length ? items : null;
			}
			const items = words.filter((w) => w.startsWith(prefix)).map((w) => ({ value: w, label: w }));
			return items.length ? items : null;
		},
		handler: async (args, ctx) => {
			const [sub, id] = (args ?? "").trim().split(/\s+/);
			switch (sub) {
				case "list":
					return list(ctx, kit, modules);
				case "stats":
					return stats(ctx, kit);
				case "path":
					ctx.ui.notify(settingsPath(), "info");
					return;
				case "on":
				case "off": {
					const module = modules.find((m) => m.id === id);
					if (!module) {
						ctx.ui.notify(`Unknown module "${id ?? ""}". Modules: ${modules.map((m) => m.id).join(", ")}`, "error");
						return;
					}
					kit.settings.modules[module.id] = sub === "on";
					saveSettings(kit.settings);
					ctx.ui.notify(`${module.id} ${sub} — reloading extensions`, "info");
					await ctx.reload();
					return;
				}
				default:
					return menu(ctx, kit, modules);
			}
		},
	});
}

function list(ctx: ExtensionCommandContext, kit: Toolkit, modules: ToolkitModule[]): void {
	const theme = ctx.ui.theme;
	const lines = modules.map((m) => {
		const on = moduleEnabled(m, kit.settings);
		const loaded = kit.enabled.has(m.id);
		const mark = on ? theme.fg("success", "on ") : theme.fg("dim", "off");
		const note = on && !loaded ? theme.fg("warning", " (takes effect after /reload)") : "";
		return `${mark}  ${m.id.padEnd(14)} ${theme.fg("muted", m.description)}${note}`;
	});
	kit.print("toolkit", [`${modules.length} modules · ${settingsPath()}`], lines);
}

function stats(_ctx: ExtensionCommandContext, kit: Toolkit): void {
	kit.print("toolkit stats", ["bytes removed from tool output and prompts this session"], kit.ledger.report());
}

async function menu(ctx: ExtensionCommandContext, kit: Toolkit, modules: ToolkitModule[]): Promise<void> {
	if (ctx.mode !== "tui") {
		list(ctx, kit, modules);
		return;
	}
	const before = new Map(modules.map((m) => [m.id, moduleEnabled(m, kit.settings)]));
	const items: SettingItem[] = modules.map((m) => ({
		id: m.id,
		label: m.label,
		description: m.description,
		currentValue: before.get(m.id) ? "on" : "off",
		values: ["on", "off"],
	}));

	await ctx.ui.custom<void>((_tui, theme, _kb, done) => {
		const container = new Container();
		container.addChild(new Text(theme.fg("accent", theme.bold("Toolkit modules")) + theme.fg("muted", "  enter/space toggles · esc closes"), 1, 0));
		const listComponent = new SettingsList(
			items,
			Math.min(items.length + 2, 20),
			getSettingsListTheme(),
			(id, value) => {
				kit.settings.modules[id] = value === "on";
				saveSettings(kit.settings);
			},
			() => done(undefined),
			{ enableSearch: true },
		);
		container.addChild(listComponent);
		return {
			render: (w) => container.render(w),
			invalidate: () => container.invalidate(),
			handleInput: (data) => listComponent.handleInput?.(data),
		};
	});

	const changed = modules.filter((m) => before.get(m.id) !== moduleEnabled(m, kit.settings));
	if (changed.length === 0) return;
	ctx.ui.notify(`Changed: ${changed.map((m) => `${m.id} ${moduleEnabled(m, kit.settings) ? "on" : "off"}`).join(", ")} — reloading extensions`, "info");
	await ctx.reload();
}
