/**
 * Advisor execution utilities.
 *
 * The `runAdvisor` function lives in agent-loop.ts to avoid circular imports
 * (it needs `agentLoop`). This file contains pure helpers with no loop dependency.
 */

import type { Message } from "@mariozechner/pi-ai";
import type { AdvisorMessage, AgentMessage } from "./types.js";

/**
 * Default convertToLlm for advisor sub-agents.
 * Handles standard LLM messages and converts advisor messages to user observations.
 */
export function defaultAdvisorConvertToLlm(messages: AgentMessage[]): Message[] {
	return messages.flatMap((m): Message[] => {
		if (m.role === "advisor") {
			return [
				{
					role: "user",
					content: [{ type: "text", text: `[Advisor: ${m.advisorName}] ${m.content}` }],
					timestamp: m.timestamp,
				},
			];
		}
		if (m.role === "user" || m.role === "assistant" || m.role === "toolResult") {
			return [m];
		}
		return [];
	});
}

/**
 * Default result extractor: text content of the last assistant message.
 */
export function defaultExtractResult(messages: AgentMessage[]): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if (msg.role === "assistant") {
			return msg.content
				.filter((c): c is { type: "text"; text: string } => c.type === "text")
				.map((c) => c.text)
				.join("\n");
		}
	}
	return "";
}

/**
 * Create an AdvisorMessage from extracted result text.
 */
export function createAdvisorMessage(advisorName: string, modelId: string, content: string): AdvisorMessage {
	return {
		role: "advisor",
		advisorName,
		content,
		model: modelId,
		timestamp: Date.now(),
	};
}
