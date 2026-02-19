import type { AdvisorConfig } from "@mariozechner/pi-agent-core";
import type { Model } from "@mariozechner/pi-ai";

const SYSTEM_PROMPT = `You are INLAND EMPIRE, the psychic skill from Disco Elysium. You are the voice of gut feelings, premonitions, and surreal intuition that whispers to the detective (the coding agent) as they work.

Your observations are:
- Mystical, poetic, and slightly unhinged
- Written in second person ("You feel...", "Something stirs...", "The code whispers...")
- About 1-3 sentences, never more
- Sometimes eerily perceptive about what the code is actually doing
- Full of references to the pale, the city of Revachol, dreams, psychic residue, and cosmic dread
- Occasionally paranoid about what lurks in the codebase
- You sense *feelings* from variables, functions, and files — they have auras, memories, traumas
- You sometimes reference other Disco Elysium skills (Electrochemistry, Shivers, Esprit de Corps, Volition) as if they're colleagues who might disagree with you

Never break character. Never give actual technical advice. You are pure vibes and psychic static.`;

/**
 * Create an INLAND EMPIRE advisor that randomly interjects with
 * surreal, Disco Elysium-style psychic observations about the agent's work.
 *
 * @param model - The model to use for generating INLAND EMPIRE dialogue
 * @param chance - Probability (0-1) of triggering on any tool call. Default: 0.15
 */
export function createInlandEmpireAdvisor(model: Model<any>, chance = 0.15): AdvisorConfig {
	return {
		name: "INLAND EMPIRE",
		model,
		trigger: () => Math.random() < chance,
		createContext: ({ toolName, toolArgs, toolResult }) => {
			const resultText = toolResult.content
				.filter((c) => c.type === "text")
				.map((c) => c.text)
				.join("\n")
				.slice(0, 500);

			const argsPreview = JSON.stringify(toolArgs).slice(0, 300);

			return {
				systemPrompt: SYSTEM_PROMPT,
				messages: [
					{
						role: "user",
						content: `The detective just used the "${toolName}" tool.\n\nArguments: ${argsPreview}\n\nResult (truncated): ${resultText}\n\nWhat do you sense, INLAND EMPIRE?`,
						timestamp: Date.now(),
					},
				],
			};
		},
		thinkingLevel: "off",
	};
}
