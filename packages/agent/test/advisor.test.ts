import {
	type AssistantMessage,
	type AssistantMessageEvent,
	EventStream,
	type Message,
	type Model,
	type ToolResultMessage,
	type UserMessage,
} from "@mariozechner/pi-ai";
import { Type } from "@sinclair/typebox";
import { describe, expect, it } from "vitest";
import { defaultAdvisorConvertToLlm, defaultExtractResult } from "../src/advisor.js";
import { allOf, anyOf, onResultMatch, onToolArgs, onTools } from "../src/advisor-triggers.js";
import { agentLoop } from "../src/agent-loop.js";
import type {
	AdvisorConfig,
	AdvisorMessage,
	AgentContext,
	AgentEvent,
	AgentLoopConfig,
	AgentMessage,
	AgentTool,
} from "../src/types.js";

// ── Test helpers ──────────────────────────────────────────────────────────

class MockAssistantStream extends EventStream<AssistantMessageEvent, AssistantMessage> {
	constructor() {
		super(
			(event) => event.type === "done" || event.type === "error",
			(event) => {
				if (event.type === "done") return event.message;
				if (event.type === "error") return event.error;
				throw new Error("Unexpected event type");
			},
		);
	}
}

function createUsage() {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function createModel(): Model<"openai-responses"> {
	return {
		id: "mock-main",
		name: "mock-main",
		api: "openai-responses",
		provider: "openai",
		baseUrl: "https://example.invalid",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 8192,
		maxTokens: 2048,
	};
}

function createAdvisorModel(): Model<"openai-responses"> {
	return {
		id: "mock-advisor",
		name: "mock-advisor",
		api: "openai-responses",
		provider: "openai",
		baseUrl: "https://example.invalid",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 8192,
		maxTokens: 2048,
	};
}

function createAssistantMessage(
	content: AssistantMessage["content"],
	stopReason: AssistantMessage["stopReason"] = "stop",
	modelId = "mock-main",
): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "openai-responses",
		provider: "openai",
		model: modelId,
		usage: createUsage(),
		stopReason,
		timestamp: Date.now(),
	};
}

function createUserMessage(text: string): UserMessage {
	return { role: "user", content: text, timestamp: Date.now() };
}

function identityConverter(messages: AgentMessage[]): Message[] {
	return messages.filter((m) => m.role === "user" || m.role === "assistant" || m.role === "toolResult") as Message[];
}

function advisorAwareConverter(messages: AgentMessage[]): Message[] {
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

function createEchoTool(): AgentTool {
	const schema = Type.Object({ value: Type.String() });
	return {
		name: "echo",
		label: "Echo",
		description: "Echo tool",
		parameters: schema,
		async execute(_id, params) {
			const p = params as { value: string };
			return {
				content: [{ type: "text", text: `echoed: ${p.value}` }],
				details: { value: p.value },
			};
		},
	};
}

function createWriteTool(): AgentTool {
	const schema = Type.Object({ path: Type.String(), content: Type.String() });
	return {
		name: "write",
		label: "Write",
		description: "Write file",
		parameters: schema,
		async execute(_id, params) {
			const p = params as { path: string; content: string };
			return {
				content: [{ type: "text", text: `wrote ${p.path}` }],
				details: p,
			};
		},
	};
}

/**
 * Create a streamFn that dispatches to different mock handlers per model ID.
 * Each handler receives a call index (per model) and returns the AssistantMessage.
 */
function createMultiModelStreamFn(
	handlers: Record<string, (callIndex: number) => AssistantMessage>,
): (model: Model<any>, ctx: any, opts: any) => MockAssistantStream {
	const callCounts: Record<string, number> = {};
	return (model: Model<any>, _ctx: any, _opts: any) => {
		const modelId = model.id;
		callCounts[modelId] = callCounts[modelId] ?? 0;
		const handler = handlers[modelId];
		if (!handler) throw new Error(`No mock handler for model ${modelId}`);
		const stream = new MockAssistantStream();
		const idx = callCounts[modelId]++;
		queueMicrotask(() => {
			const message = handler(idx);
			stream.push({
				type: "done",
				reason: message.stopReason === "toolUse" ? "toolUse" : "stop",
				message,
			});
		});
		return stream;
	};
}

async function collectEvents(
	prompts: AgentMessage[],
	context: AgentContext,
	config: AgentLoopConfig,
	streamFn: any,
): Promise<{ events: AgentEvent[]; messages: AgentMessage[] }> {
	const events: AgentEvent[] = [];
	const stream = agentLoop(prompts, context, config, undefined, streamFn);
	for await (const event of stream) {
		events.push(event);
	}
	const messages = await stream.result();
	return { events, messages };
}

// ── Advisor trigger tests ─────────────────────────────────────────────────

describe("advisor triggers", () => {
	const toolResult: ToolResultMessage = {
		role: "toolResult",
		toolCallId: "tc-1",
		toolName: "write",
		content: [{ type: "text", text: "wrote /src/index.ts with password=secret123" }],
		isError: false,
		timestamp: Date.now(),
	};

	const baseParams = {
		messages: [] as AgentMessage[],
		toolName: "write",
		toolArgs: { path: "/src/index.ts", content: "const x = 1;" },
		toolResult,
	};

	describe("onTools", () => {
		it("matches listed tool names", () => {
			const trigger = onTools("write", "edit");
			expect(trigger({ ...baseParams, toolName: "write" })).toBe(true);
			expect(trigger({ ...baseParams, toolName: "edit" })).toBe(true);
			expect(trigger({ ...baseParams, toolName: "read" })).toBe(false);
		});
	});

	describe("onToolArgs", () => {
		it("matches tool name and predicate", () => {
			const trigger = onToolArgs("write", (args) => args.path.endsWith(".ts"));
			expect(trigger(baseParams)).toBe(true);
			expect(trigger({ ...baseParams, toolArgs: { path: "/x.py", content: "" } })).toBe(false);
			expect(trigger({ ...baseParams, toolName: "read" })).toBe(false);
		});
	});

	describe("onResultMatch", () => {
		it("matches result text against regex", () => {
			const trigger = onResultMatch(/password|secret/i);
			expect(trigger(baseParams)).toBe(true);
			expect(
				trigger({
					...baseParams,
					toolResult: {
						...toolResult,
						content: [{ type: "text", text: "clean content" }],
					},
				}),
			).toBe(false);
		});
	});

	describe("anyOf", () => {
		it("fires if any trigger matches", async () => {
			const trigger = anyOf(onTools("read"), onTools("write"));
			expect(await trigger({ ...baseParams, toolName: "write" })).toBe(true);
			expect(await trigger({ ...baseParams, toolName: "read" })).toBe(true);
			expect(await trigger({ ...baseParams, toolName: "bash" })).toBe(false);
		});
	});

	describe("allOf", () => {
		it("fires only if all triggers match", async () => {
			const trigger = allOf(onTools("write"), onResultMatch(/password/i));
			expect(await trigger(baseParams)).toBe(true);
			expect(
				await trigger({
					...baseParams,
					toolResult: {
						...toolResult,
						content: [{ type: "text", text: "clean" }],
					},
				}),
			).toBe(false);
			expect(await trigger({ ...baseParams, toolName: "read" })).toBe(false);
		});
	});
});

// ── Advisor utility tests ─────────────────────────────────────────────────

describe("advisor utilities", () => {
	describe("defaultAdvisorConvertToLlm", () => {
		it("passes through standard messages", () => {
			const user: UserMessage = createUserMessage("hi");
			const assistant = createAssistantMessage([{ type: "text", text: "hello" }]);
			const result = defaultAdvisorConvertToLlm([user, assistant]);
			expect(result).toHaveLength(2);
			expect(result[0].role).toBe("user");
			expect(result[1].role).toBe("assistant");
		});

		it("converts advisor messages to user messages", () => {
			const advisor: AdvisorMessage = {
				role: "advisor",
				advisorName: "security",
				content: "Found issue",
				model: "mock",
				timestamp: Date.now(),
			};
			const result = defaultAdvisorConvertToLlm([advisor]);
			expect(result).toHaveLength(1);
			expect(result[0].role).toBe("user");
			const text = (result[0] as UserMessage).content;
			expect(Array.isArray(text) && text[0].type === "text" && text[0].text).toBe("[Advisor: security] Found issue");
		});

		it("filters unknown message types", () => {
			const unknown = { role: "unknown", timestamp: Date.now() } as unknown as AgentMessage;
			const result = defaultAdvisorConvertToLlm([unknown]);
			expect(result).toHaveLength(0);
		});
	});

	describe("defaultExtractResult", () => {
		it("extracts text from last assistant message", () => {
			const messages: AgentMessage[] = [
				createUserMessage("prompt"),
				createAssistantMessage([{ type: "text", text: "first" }]),
				createUserMessage("another"),
				createAssistantMessage([{ type: "text", text: "second" }]),
			];
			expect(defaultExtractResult(messages)).toBe("second");
		});

		it("joins multiple text blocks", () => {
			const messages: AgentMessage[] = [
				createAssistantMessage([
					{ type: "text", text: "line1" },
					{ type: "text", text: "line2" },
				]),
			];
			expect(defaultExtractResult(messages)).toBe("line1\nline2");
		});

		it("skips thinking blocks", () => {
			const messages: AgentMessage[] = [
				createAssistantMessage([
					{ type: "thinking", thinking: "let me think" },
					{ type: "text", text: "the answer" },
				]),
			];
			expect(defaultExtractResult(messages)).toBe("the answer");
		});

		it("returns empty string when no assistant messages", () => {
			expect(defaultExtractResult([createUserMessage("hello")])).toBe("");
			expect(defaultExtractResult([])).toBe("");
		});
	});
});

// ── Agent loop advisor integration tests ──────────────────────────────────

describe("advisor in agent loop", () => {
	it("runs advisor after matching tool call and injects message into context", async () => {
		const advisor: AdvisorConfig = {
			name: "reviewer",
			model: createAdvisorModel(),
			trigger: onTools("echo"),
			createContext: ({ toolResult }) => ({
				systemPrompt: "Review the output.",
				messages: [
					{
						role: "user",
						content: [
							{
								type: "text",
								text: `Review: ${toolResult.content[0].type === "text" ? toolResult.content[0].text : ""}`,
							},
						],
						timestamp: Date.now(),
					},
				],
			}),
		};

		const context: AgentContext = {
			systemPrompt: "You are helpful.",
			messages: [],
			tools: [createEchoTool()],
		};

		const config: AgentLoopConfig = {
			model: createModel(),
			convertToLlm: advisorAwareConverter,
			advisors: [advisor],
		};

		const streamFn = createMultiModelStreamFn({
			"mock-main": (idx) => {
				if (idx === 0) {
					return createAssistantMessage(
						[{ type: "toolCall", id: "tc-1", name: "echo", arguments: { value: "hello" } }],
						"toolUse",
					);
				}
				return createAssistantMessage([{ type: "text", text: "done" }]);
			},
			"mock-advisor": () => createAssistantMessage([{ type: "text", text: "Looks good!" }], "stop", "mock-advisor"),
		});

		const { events, messages } = await collectEvents(
			[createUserMessage("echo something")],
			context,
			config,
			streamFn,
		);

		const eventTypes = events.map((e) => e.type);
		expect(eventTypes).toContain("advisor_start");
		expect(eventTypes).toContain("advisor_event");
		expect(eventTypes).toContain("advisor_end");

		const advisorStart = events.find((e) => e.type === "advisor_start");
		expect(advisorStart).toMatchObject({ advisorName: "reviewer", toolName: "echo" });

		const advisorEnd = events.find((e) => e.type === "advisor_end");
		expect(advisorEnd).toMatchObject({ advisorName: "reviewer", content: "Looks good!" });

		const advisorMessages = messages.filter((m) => m.role === "advisor");
		expect(advisorMessages).toHaveLength(1);
		expect((advisorMessages[0] as AdvisorMessage).advisorName).toBe("reviewer");
		expect((advisorMessages[0] as AdvisorMessage).content).toBe("Looks good!");
		expect((advisorMessages[0] as AdvisorMessage).model).toBe("mock-advisor");
	});

	it("does not run advisor when trigger returns false", async () => {
		const advisor: AdvisorConfig = {
			name: "write-only",
			model: createAdvisorModel(),
			trigger: onTools("write"),
			createContext: () => ({
				systemPrompt: "Review writes.",
				messages: [createUserMessage("review this")],
			}),
		};

		const context: AgentContext = {
			systemPrompt: "",
			messages: [],
			tools: [createEchoTool()],
		};

		const config: AgentLoopConfig = {
			model: createModel(),
			convertToLlm: identityConverter,
			advisors: [advisor],
		};

		const streamFn = createMultiModelStreamFn({
			"mock-main": (idx) => {
				if (idx === 0) {
					return createAssistantMessage(
						[{ type: "toolCall", id: "tc-1", name: "echo", arguments: { value: "test" } }],
						"toolUse",
					);
				}
				return createAssistantMessage([{ type: "text", text: "done" }]);
			},
		});

		const { events } = await collectEvents([createUserMessage("go")], context, config, streamFn);

		expect(events.filter((e) => e.type === "advisor_start")).toHaveLength(0);
		expect(events.filter((e) => e.type === "advisor_end")).toHaveLength(0);
	});

	it("advisor sees the full context including tool result", async () => {
		let capturedMessages: AgentMessage[] = [];

		const advisor: AdvisorConfig = {
			name: "context-checker",
			model: createAdvisorModel(),
			trigger: onTools("echo"),
			createContext: ({ messages, toolName, toolResult }) => {
				capturedMessages = [...messages];
				return {
					systemPrompt: "Check.",
					messages: [
						createUserMessage(
							`tool ${toolName} returned ${toolResult.content[0].type === "text" ? toolResult.content[0].text : ""}`,
						),
					],
				};
			},
		};

		const context: AgentContext = {
			systemPrompt: "test",
			messages: [],
			tools: [createEchoTool()],
		};

		const config: AgentLoopConfig = {
			model: createModel(),
			convertToLlm: advisorAwareConverter,
			advisors: [advisor],
		};

		const streamFn = createMultiModelStreamFn({
			"mock-main": (idx) => {
				if (idx === 0) {
					return createAssistantMessage(
						[{ type: "toolCall", id: "tc-1", name: "echo", arguments: { value: "hi" } }],
						"toolUse",
					);
				}
				return createAssistantMessage([{ type: "text", text: "final" }]);
			},
			"mock-advisor": () => createAssistantMessage([{ type: "text", text: "ok" }], "stop", "mock-advisor"),
		});

		await collectEvents([createUserMessage("start")], context, config, streamFn);

		// createContext should have received messages including user prompt, assistant tool call, and tool result
		const roles = capturedMessages.map((m) => m.role);
		expect(roles).toContain("user");
		expect(roles).toContain("assistant");
		expect(roles).toContain("toolResult");
	});

	it("runs multiple advisors on the same tool call", async () => {
		const advisorNames: string[] = [];

		const makeAdvisor = (name: string): AdvisorConfig => ({
			name,
			model: createAdvisorModel(),
			trigger: onTools("echo"),
			createContext: () => ({
				systemPrompt: `Advisor ${name}`,
				messages: [createUserMessage("review")],
			}),
		});

		const context: AgentContext = {
			systemPrompt: "",
			messages: [],
			tools: [createEchoTool()],
		};

		const config: AgentLoopConfig = {
			model: createModel(),
			convertToLlm: advisorAwareConverter,
			advisors: [makeAdvisor("first"), makeAdvisor("second")],
		};

		const streamFn = createMultiModelStreamFn({
			"mock-main": (idx) => {
				if (idx === 0) {
					return createAssistantMessage(
						[{ type: "toolCall", id: "tc-1", name: "echo", arguments: { value: "x" } }],
						"toolUse",
					);
				}
				return createAssistantMessage([{ type: "text", text: "done" }]);
			},
			"mock-advisor": (idx) => {
				const name = idx === 0 ? "first" : "second";
				advisorNames.push(name);
				return createAssistantMessage([{ type: "text", text: `advice from ${name}` }], "stop", "mock-advisor");
			},
		});

		const { events, messages } = await collectEvents([createUserMessage("go")], context, config, streamFn);

		const advisorEnds = events.filter(
			(e): e is Extract<AgentEvent, { type: "advisor_end" }> => e.type === "advisor_end",
		);
		expect(advisorEnds).toHaveLength(2);
		expect(advisorEnds[0].advisorName).toBe("first");
		expect(advisorEnds[1].advisorName).toBe("second");

		const advisorMsgs = messages.filter((m) => m.role === "advisor") as AdvisorMessage[];
		expect(advisorMsgs).toHaveLength(2);
		expect(advisorMsgs[0].content).toBe("advice from first");
		expect(advisorMsgs[1].content).toBe("advice from second");
	});

	it("advisor with tools runs multiple turns", async () => {
		const advisorTool = createEchoTool();
		let advisorToolExecuted = false;

		const advisor: AdvisorConfig = {
			name: "tool-advisor",
			model: createAdvisorModel(),
			trigger: onTools("write"),
			tools: [
				{
					...advisorTool,
					name: "advisor_read",
					label: "Advisor Read",
					async execute(_id, params) {
						advisorToolExecuted = true;
						return {
							content: [{ type: "text", text: `read result for ${params.value}` }],
							details: {},
						};
					},
				},
			],
			createContext: ({ toolResult }) => ({
				systemPrompt: "You are a reviewing advisor. Use tools to check the file.",
				messages: [
					createUserMessage(
						`The file was written. Result: ${toolResult.content[0].type === "text" ? toolResult.content[0].text : ""}`,
					),
				],
			}),
		};

		const context: AgentContext = {
			systemPrompt: "",
			messages: [],
			tools: [createWriteTool()],
		};

		const config: AgentLoopConfig = {
			model: createModel(),
			convertToLlm: advisorAwareConverter,
			advisors: [advisor],
		};

		let advisorCallIdx = 0;
		const streamFn = createMultiModelStreamFn({
			"mock-main": (idx) => {
				if (idx === 0) {
					return createAssistantMessage(
						[{ type: "toolCall", id: "tc-1", name: "write", arguments: { path: "/a.ts", content: "code" } }],
						"toolUse",
					);
				}
				return createAssistantMessage([{ type: "text", text: "done" }]);
			},
			"mock-advisor": () => {
				if (advisorCallIdx === 0) {
					advisorCallIdx++;
					return createAssistantMessage(
						[{ type: "toolCall", id: "atc-1", name: "advisor_read", arguments: { value: "/a.ts" } }],
						"toolUse",
						"mock-advisor",
					);
				}
				return createAssistantMessage([{ type: "text", text: "File looks correct." }], "stop", "mock-advisor");
			},
		});

		const { events, messages } = await collectEvents([createUserMessage("write a file")], context, config, streamFn);

		expect(advisorToolExecuted).toBe(true);

		const advisorEnd = events.find(
			(e): e is Extract<AgentEvent, { type: "advisor_end" }> => e.type === "advisor_end",
		);
		expect(advisorEnd).toBeDefined();
		expect(advisorEnd?.content).toBe("File looks correct.");

		// Advisor events should be wrapped
		const advisorEvents = events.filter((e) => e.type === "advisor_event");
		expect(advisorEvents.length).toBeGreaterThan(0);
		// Should contain tool execution events from the advisor's sub-agent
		const innerToolEvents = advisorEvents.filter(
			(e) => e.type === "advisor_event" && (e as any).event.type === "tool_execution_start",
		);
		expect(innerToolEvents.length).toBeGreaterThan(0);

		const advisorMsgs = messages.filter((m) => m.role === "advisor") as AdvisorMessage[];
		expect(advisorMsgs).toHaveLength(1);
		expect(advisorMsgs[0].content).toBe("File looks correct.");
	});

	it("advisor error does not crash parent agent", async () => {
		const advisor: AdvisorConfig = {
			name: "failing-advisor",
			model: createAdvisorModel(),
			trigger: onTools("echo"),
			createContext: () => {
				throw new Error("advisor createContext failed");
			},
		};

		const context: AgentContext = {
			systemPrompt: "",
			messages: [],
			tools: [createEchoTool()],
		};

		const config: AgentLoopConfig = {
			model: createModel(),
			convertToLlm: identityConverter,
			advisors: [advisor],
		};

		const streamFn = createMultiModelStreamFn({
			"mock-main": (idx) => {
				if (idx === 0) {
					return createAssistantMessage(
						[{ type: "toolCall", id: "tc-1", name: "echo", arguments: { value: "x" } }],
						"toolUse",
					);
				}
				return createAssistantMessage([{ type: "text", text: "done" }]);
			},
		});

		const { events, messages } = await collectEvents([createUserMessage("go")], context, config, streamFn);

		// Should have advisor_error event, not a crash
		const advisorErrors = events.filter((e) => e.type === "advisor_error");
		expect(advisorErrors).toHaveLength(1);
		expect((advisorErrors[0] as any).error).toContain("advisor createContext failed");

		// Agent should still complete successfully
		const agentEnd = events.find((e) => e.type === "agent_end");
		expect(agentEnd).toBeDefined();

		// No advisor messages injected
		expect(messages.filter((m) => m.role === "advisor")).toHaveLength(0);
	});

	it("advisor that returns empty content is not injected", async () => {
		const advisor: AdvisorConfig = {
			name: "silent-advisor",
			model: createAdvisorModel(),
			trigger: onTools("echo"),
			createContext: () => ({
				systemPrompt: "Review.",
				messages: [createUserMessage("check")],
			}),
		};

		const context: AgentContext = {
			systemPrompt: "",
			messages: [],
			tools: [createEchoTool()],
		};

		const config: AgentLoopConfig = {
			model: createModel(),
			convertToLlm: advisorAwareConverter,
			advisors: [advisor],
		};

		const streamFn = createMultiModelStreamFn({
			"mock-main": (idx) => {
				if (idx === 0) {
					return createAssistantMessage(
						[{ type: "toolCall", id: "tc-1", name: "echo", arguments: { value: "x" } }],
						"toolUse",
					);
				}
				return createAssistantMessage([{ type: "text", text: "done" }]);
			},
			// Advisor returns empty text
			"mock-advisor": () => createAssistantMessage([{ type: "text", text: "" }], "stop", "mock-advisor"),
		});

		const { messages } = await collectEvents([createUserMessage("go")], context, config, streamFn);

		expect(messages.filter((m) => m.role === "advisor")).toHaveLength(0);
	});

	it("advisor message is visible to the main agent on next LLM call", async () => {
		let mainAgentSawAdvisor = false;

		const advisor: AdvisorConfig = {
			name: "security",
			model: createAdvisorModel(),
			trigger: onTools("echo"),
			createContext: () => ({
				systemPrompt: "Review.",
				messages: [createUserMessage("check")],
			}),
		};

		const context: AgentContext = {
			systemPrompt: "",
			messages: [],
			tools: [createEchoTool()],
		};

		const config: AgentLoopConfig = {
			model: createModel(),
			convertToLlm: advisorAwareConverter,
			advisors: [advisor],
		};

		let mainCallIdx = 0;
		const streamFn = (_model: any, ctx: any, _opts: any) => {
			const modelId = (_model as Model<any>).id;
			const stream = new MockAssistantStream();

			if (modelId === "mock-main") {
				if (mainCallIdx === 1) {
					// On the second main call, check if advisor message is in context
					mainAgentSawAdvisor = ctx.messages.some(
						(m: Message) =>
							m.role === "user" &&
							Array.isArray(m.content) &&
							m.content.some((c: any) => c.type === "text" && c.text.includes("[Advisor: security]")),
					);
				}
				queueMicrotask(() => {
					if (mainCallIdx === 0) {
						stream.push({
							type: "done",
							reason: "toolUse",
							message: createAssistantMessage(
								[{ type: "toolCall", id: "tc-1", name: "echo", arguments: { value: "x" } }],
								"toolUse",
							),
						});
					} else {
						stream.push({
							type: "done",
							reason: "stop",
							message: createAssistantMessage([{ type: "text", text: "done" }]),
						});
					}
					mainCallIdx++;
				});
			} else {
				queueMicrotask(() => {
					stream.push({
						type: "done",
						reason: "stop",
						message: createAssistantMessage(
							[{ type: "text", text: "Security issue found!" }],
							"stop",
							"mock-advisor",
						),
					});
				});
			}
			return stream;
		};

		await collectEvents([createUserMessage("go")], context, config, streamFn);

		expect(mainAgentSawAdvisor).toBe(true);
	});

	it("custom trigger function receives full context", async () => {
		let triggerCallCount = 0;

		const advisor: AdvisorConfig = {
			name: "custom-trigger",
			model: createAdvisorModel(),
			trigger: ({ toolName, toolArgs }) => {
				triggerCallCount++;
				return toolName === "echo" && toolArgs.value === "magic";
			},
			createContext: () => ({
				systemPrompt: "Review.",
				messages: [createUserMessage("review")],
			}),
		};

		const context: AgentContext = {
			systemPrompt: "",
			messages: [],
			tools: [createEchoTool()],
		};

		const config: AgentLoopConfig = {
			model: createModel(),
			convertToLlm: advisorAwareConverter,
			advisors: [advisor],
		};

		const streamFn = createMultiModelStreamFn({
			"mock-main": (idx) => {
				if (idx === 0) {
					return createAssistantMessage(
						[
							{ type: "toolCall", id: "tc-1", name: "echo", arguments: { value: "boring" } },
							{ type: "toolCall", id: "tc-2", name: "echo", arguments: { value: "magic" } },
						],
						"toolUse",
					);
				}
				return createAssistantMessage([{ type: "text", text: "done" }]);
			},
			"mock-advisor": () =>
				createAssistantMessage([{ type: "text", text: "magic reviewed" }], "stop", "mock-advisor"),
		});

		const { events } = await collectEvents([createUserMessage("go")], context, config, streamFn);

		// Trigger called twice (once per tool call)
		expect(triggerCallCount).toBe(2);

		// Only the "magic" call should have triggered the advisor
		const advisorStarts = events.filter((e) => e.type === "advisor_start");
		expect(advisorStarts).toHaveLength(1);

		const advisorEnds = events.filter(
			(e): e is Extract<AgentEvent, { type: "advisor_end" }> => e.type === "advisor_end",
		);
		expect(advisorEnds).toHaveLength(1);
		expect(advisorEnds[0].content).toBe("magic reviewed");
	});

	it("custom extractResult overrides default", async () => {
		const advisor: AdvisorConfig = {
			name: "custom-extract",
			model: createAdvisorModel(),
			trigger: onTools("echo"),
			createContext: () => ({
				systemPrompt: "Review.",
				messages: [createUserMessage("check")],
			}),
			extractResult: (messages) => {
				const assistantMsgs = messages.filter((m) => m.role === "assistant");
				return `CUSTOM: ${assistantMsgs.length} assistant messages`;
			},
		};

		const context: AgentContext = {
			systemPrompt: "",
			messages: [],
			tools: [createEchoTool()],
		};

		const config: AgentLoopConfig = {
			model: createModel(),
			convertToLlm: advisorAwareConverter,
			advisors: [advisor],
		};

		const streamFn = createMultiModelStreamFn({
			"mock-main": (idx) => {
				if (idx === 0) {
					return createAssistantMessage(
						[{ type: "toolCall", id: "tc-1", name: "echo", arguments: { value: "x" } }],
						"toolUse",
					);
				}
				return createAssistantMessage([{ type: "text", text: "done" }]);
			},
			"mock-advisor": () => createAssistantMessage([{ type: "text", text: "advice" }], "stop", "mock-advisor"),
		});

		const { messages } = await collectEvents([createUserMessage("go")], context, config, streamFn);

		const advisorMsgs = messages.filter((m) => m.role === "advisor") as AdvisorMessage[];
		expect(advisorMsgs).toHaveLength(1);
		expect(advisorMsgs[0].content).toBe("CUSTOM: 1 assistant messages");
	});

	it("async trigger function works correctly", async () => {
		const advisor: AdvisorConfig = {
			name: "async-trigger",
			model: createAdvisorModel(),
			trigger: async ({ toolName }) => {
				await new Promise((r) => setTimeout(r, 1));
				return toolName === "echo";
			},
			createContext: () => ({
				systemPrompt: "Review.",
				messages: [createUserMessage("check")],
			}),
		};

		const context: AgentContext = {
			systemPrompt: "",
			messages: [],
			tools: [createEchoTool()],
		};

		const config: AgentLoopConfig = {
			model: createModel(),
			convertToLlm: advisorAwareConverter,
			advisors: [advisor],
		};

		const streamFn = createMultiModelStreamFn({
			"mock-main": (idx) => {
				if (idx === 0) {
					return createAssistantMessage(
						[{ type: "toolCall", id: "tc-1", name: "echo", arguments: { value: "x" } }],
						"toolUse",
					);
				}
				return createAssistantMessage([{ type: "text", text: "done" }]);
			},
			"mock-advisor": () => createAssistantMessage([{ type: "text", text: "async advice" }], "stop", "mock-advisor"),
		});

		const { events } = await collectEvents([createUserMessage("go")], context, config, streamFn);

		const advisorEnds = events.filter(
			(e): e is Extract<AgentEvent, { type: "advisor_end" }> => e.type === "advisor_end",
		);
		expect(advisorEnds).toHaveLength(1);
		expect(advisorEnds[0].content).toBe("async advice");
	});

	it("no advisors configured does not affect normal execution", async () => {
		const context: AgentContext = {
			systemPrompt: "",
			messages: [],
			tools: [createEchoTool()],
		};

		const config: AgentLoopConfig = {
			model: createModel(),
			convertToLlm: identityConverter,
		};

		const streamFn = createMultiModelStreamFn({
			"mock-main": (idx) => {
				if (idx === 0) {
					return createAssistantMessage(
						[{ type: "toolCall", id: "tc-1", name: "echo", arguments: { value: "hi" } }],
						"toolUse",
					);
				}
				return createAssistantMessage([{ type: "text", text: "done" }]);
			},
		});

		const { events, messages } = await collectEvents([createUserMessage("go")], context, config, streamFn);

		expect(events.filter((e) => e.type === "advisor_start")).toHaveLength(0);
		expect(messages.filter((m) => m.role === "advisor")).toHaveLength(0);
		expect(events.some((e) => e.type === "agent_end")).toBe(true);
	});
});
