#!/usr/bin/env node

import { join, resolve } from "path";
import { SlackAdapter } from "./adapters/slack.js";
import { TelegramAdapter } from "./adapters/telegram.js";
import type { MomEvent, MomHandler, PlatformAdapter } from "./adapters/types.js";
import { type AgentRunner, getOrCreateRunner } from "./agent.js";
import { downloadChannel } from "./download.js";
import { createEventsWatcher } from "./events.js";
import * as log from "./log.js";
import { ChannelStore } from "./store.js";

// ============================================================================
// Config
// ============================================================================

interface ParsedArgs {
	workingDir?: string;
	downloadChannel?: string;
	adapters: string[];
}

function parseArgs(): ParsedArgs {
	const args = process.argv.slice(2);
	let workingDir: string | undefined;
	let downloadChannelId: string | undefined;
	let adapterArg: string | undefined;

	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (arg.startsWith("--download=")) {
			downloadChannelId = arg.slice("--download=".length);
		} else if (arg === "--download") {
			downloadChannelId = args[++i];
		} else if (arg.startsWith("--adapter=")) {
			adapterArg = arg.slice("--adapter=".length);
		} else if (arg === "--adapter") {
			adapterArg = args[++i] || undefined;
		} else if (!arg.startsWith("-")) {
			workingDir = arg;
		}
	}

	// If --adapter specified, use it (comma-separated). Otherwise auto-detect from env vars.
	let adapters: string[];
	if (adapterArg) {
		adapters = adapterArg.split(",").map((a) => a.trim());
	} else {
		adapters = [];
		if (process.env.MOM_SLACK_APP_TOKEN && process.env.MOM_SLACK_BOT_TOKEN) {
			adapters.push("slack");
		}
		if (process.env.MOM_TELEGRAM_BOT_TOKEN) {
			adapters.push("telegram");
		}
		// Default to slack if nothing detected
		if (adapters.length === 0) {
			adapters.push("slack");
		}
	}

	return {
		workingDir: workingDir ? resolve(workingDir) : undefined,
		downloadChannel: downloadChannelId,
		adapters,
	};
}

const parsedArgs = parseArgs();

// Handle --download mode (Slack-only for now)
if (parsedArgs.downloadChannel) {
	const botToken = process.env.MOM_SLACK_BOT_TOKEN;
	if (!botToken) {
		console.error("Missing env: MOM_SLACK_BOT_TOKEN");
		process.exit(1);
	}
	await downloadChannel(parsedArgs.downloadChannel, botToken);
	process.exit(0);
}

// Normal bot mode - require working dir
if (!parsedArgs.workingDir) {
	console.error("Usage: mom [--adapter=slack,telegram] <working-directory>");
	console.error("       mom --download <channel-id>");
	console.error("       (omit --adapter to auto-detect from env vars)");
	process.exit(1);
}

const workingDir = parsedArgs.workingDir;

// ============================================================================
// Create platform adapters
// ============================================================================

type AdapterWithHandler = PlatformAdapter & { setHandler(h: MomHandler): void };

function createAdapter(name: string): AdapterWithHandler {
	switch (name) {
		case "slack": {
			const appToken = process.env.MOM_SLACK_APP_TOKEN;
			const botToken = process.env.MOM_SLACK_BOT_TOKEN;
			if (!appToken || !botToken) {
				console.error("Missing env: MOM_SLACK_APP_TOKEN, MOM_SLACK_BOT_TOKEN");
				process.exit(1);
			}
			const store = new ChannelStore({ workingDir, botToken });
			return new SlackAdapter({ appToken, botToken, workingDir, store });
		}
		case "telegram": {
			const botToken = process.env.MOM_TELEGRAM_BOT_TOKEN;
			if (!botToken) {
				console.error("Missing env: MOM_TELEGRAM_BOT_TOKEN");
				process.exit(1);
			}
			return new TelegramAdapter({ botToken, workingDir });
		}
		default:
			console.error(`Unknown adapter: ${name}. Use 'slack' or 'telegram'.`);
			process.exit(1);
	}
}

const adapters: AdapterWithHandler[] = parsedArgs.adapters.map(createAdapter);

// ============================================================================
// State (per channel)
// ============================================================================

interface ChannelState {
	running: boolean;
	runner: AgentRunner;
	store: ChannelStore;
	stopRequested: boolean;
	stopMessageTs?: string;
}

const channelStates = new Map<string, ChannelState>();

function getState(channelId: string, formatInstructions: string): ChannelState {
	let state = channelStates.get(channelId);
	if (!state) {
		const channelDir = join(workingDir, channelId);
		state = {
			running: false,
			runner: getOrCreateRunner(channelId, channelDir, formatInstructions),
			store: new ChannelStore({ workingDir, botToken: process.env.MOM_SLACK_BOT_TOKEN || "" }),
			stopRequested: false,
		};
		channelStates.set(channelId, state);
	}
	return state;
}

// ============================================================================
// Handler (shared across all adapters)
// ============================================================================

const handler: MomHandler = {
	isRunning(channelId: string): boolean {
		const state = channelStates.get(channelId);
		return state?.running ?? false;
	},

	async handleStop(channelId: string, platform: PlatformAdapter): Promise<void> {
		const state = channelStates.get(channelId);
		if (state?.running) {
			state.stopRequested = true;
			state.runner.abort();
			const ts = await platform.postMessage(channelId, "_Stopping..._");
			state.stopMessageTs = ts;
		} else {
			await platform.postMessage(channelId, "_Nothing running_");
		}
	},

	async handleSession(channelId: string, platform: PlatformAdapter): Promise<void> {
		const state = channelStates.get(channelId);
		if (!state) {
			await platform.postMessage(channelId, "No session for this channel yet.");
			return;
		}

		const stats = state.runner.getSessionStats();

		const formatTokens = (count: number): string => {
			if (count < 1000) return count.toString();
			if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
			if (count < 1000000) return `${Math.round(count / 1000)}k`;
			return `${(count / 1000000).toFixed(1)}M`;
		};

		const lines: string[] = [];
		lines.push("<b>Session Info</b>");
		lines.push("");
		lines.push(`<b>Messages</b>`);
		lines.push(`User: ${stats.userMessages}`);
		lines.push(`Assistant: ${stats.assistantMessages}`);
		lines.push(`Tool Calls: ${stats.toolCalls}`);
		lines.push(`Total: ${stats.totalMessages}`);
		lines.push("");
		lines.push(`<b>Tokens</b>`);
		lines.push(`Input: ${stats.tokens.input.toLocaleString()}`);
		lines.push(`Output: ${stats.tokens.output.toLocaleString()}`);
		if (stats.tokens.cacheRead > 0) {
			lines.push(`Cache Read: ${stats.tokens.cacheRead.toLocaleString()}`);
		}
		if (stats.tokens.cacheWrite > 0) {
			lines.push(`Cache Write: ${stats.tokens.cacheWrite.toLocaleString()}`);
		}
		lines.push(`Total: ${stats.tokens.total.toLocaleString()}`);
		lines.push("");
		lines.push(`<b>Context</b>`);
		if (stats.contextTokens > 0) {
			const percent = ((stats.contextTokens / stats.contextWindow) * 100).toFixed(1);
			lines.push(`${formatTokens(stats.contextTokens)} / ${formatTokens(stats.contextWindow)} (${percent}%)`);
		} else {
			lines.push("No context data yet");
		}

		if (stats.cost > 0) {
			lines.push("");
			lines.push(`<b>Cost</b>`);
			lines.push(`Total: $${stats.cost.toFixed(4)}`);
		}

		await platform.postMessage(channelId, lines.join("\n"));
	},

	async handleNew(channelId: string, platform: PlatformAdapter): Promise<void> {
		const state = channelStates.get(channelId);
		if (state?.running) {
			await platform.postMessage(channelId, "<i>Cannot reset while running. Use /stop first.</i>");
			return;
		}
		if (state) {
			state.runner.resetSession();
		}
		await platform.postMessage(channelId, "<i>Session reset. Starting fresh.</i>");
	},

	async handleEvent(event: MomEvent, platform: PlatformAdapter, isEvent?: boolean): Promise<void> {
		const state = getState(event.channel, platform.formatInstructions);

		// Start run
		state.running = true;
		state.stopRequested = false;

		log.logInfo(`[${platform.name}:${event.channel}] Starting run: ${event.text.substring(0, 50)}`);

		try {
			// Create context from adapter
			const ctx = platform.createContext(event, state.store, isEvent);

			// Run the agent
			await ctx.setTyping(true);
			await ctx.setWorking(true);
			const result = await state.runner.run(ctx, state.store);
			await ctx.setWorking(false);

			if (result.stopReason === "aborted" && state.stopRequested) {
				if (state.stopMessageTs) {
					await platform.updateMessage(event.channel, state.stopMessageTs, "_Stopped_");
					state.stopMessageTs = undefined;
				} else {
					await platform.postMessage(event.channel, "_Stopped_");
				}
			}
		} catch (err) {
			log.logWarning(
				`[${platform.name}:${event.channel}] Run error`,
				err instanceof Error ? err.message : String(err),
			);
		} finally {
			state.running = false;
		}
	},
};

// ============================================================================
// Start
// ============================================================================

log.logStartup(workingDir);
log.logInfo(`Adapters: ${parsedArgs.adapters.join(", ")}`);

for (const adapter of adapters) {
	adapter.setHandler(handler);
}

// Start events watcher (routes to all adapters)
const eventsWatcher = createEventsWatcher(workingDir, adapters);
eventsWatcher.start();

// Handle shutdown
process.on("SIGINT", () => {
	log.logInfo("Shutting down...");
	eventsWatcher.stop();
	for (const adapter of adapters) {
		adapter.stop();
	}
	process.exit(0);
});

process.on("SIGTERM", () => {
	log.logInfo("Shutting down...");
	eventsWatcher.stop();
	for (const adapter of adapters) {
		adapter.stop();
	}
	process.exit(0);
});

// Start all adapters
for (const adapter of adapters) {
	adapter.start();
}
