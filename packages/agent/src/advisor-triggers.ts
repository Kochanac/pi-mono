/**
 * Convenience factories for common advisor trigger patterns.
 */

import type { ToolResultMessage } from "@mariozechner/pi-ai";
import type { AdvisorTrigger } from "./types.js";

/** Trigger when any of the listed tools are called. */
export function onTools(...names: string[]): AdvisorTrigger {
	return ({ toolName }) => names.includes(toolName);
}

/** Trigger when a specific tool is called and its arguments satisfy a predicate. */
export function onToolArgs(toolName: string, predicate: (args: Record<string, any>) => boolean): AdvisorTrigger {
	return (params) => params.toolName === toolName && predicate(params.toolArgs);
}

/** Trigger when the tool result text matches a regex. */
export function onResultMatch(pattern: RegExp): AdvisorTrigger {
	return ({ toolResult }) => pattern.test(extractResultText(toolResult));
}

/** Fire if any of the given triggers match. */
export function anyOf(...triggers: AdvisorTrigger[]): AdvisorTrigger {
	return async (params) => {
		for (const trigger of triggers) {
			if (await trigger(params)) return true;
		}
		return false;
	};
}

/** Fire only if all of the given triggers match. */
export function allOf(...triggers: AdvisorTrigger[]): AdvisorTrigger {
	return async (params) => {
		for (const trigger of triggers) {
			if (!(await trigger(params))) return false;
		}
		return true;
	};
}

function extractResultText(toolResult: ToolResultMessage): string {
	return toolResult.content
		.filter((c) => c.type === "text")
		.map((c) => c.text)
		.join("\n");
}
