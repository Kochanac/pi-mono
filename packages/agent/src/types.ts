import type {
	AssistantMessageEvent,
	ImageContent,
	Message,
	Model,
	SimpleStreamOptions,
	streamSimple,
	TextContent,
	Tool,
	ToolResultMessage,
} from "@mariozechner/pi-ai";
import type { Static, TSchema } from "@sinclair/typebox";

// ── Advisor types ──────────────────────────────────────────────────────────

/** Parameters passed to an advisor trigger function. */
export interface AdvisorTriggerParams {
	messages: AgentMessage[];
	toolName: string;
	toolArgs: Record<string, any>;
	toolResult: ToolResultMessage;
}

/**
 * Predicate that decides whether an advisor should run after a tool execution.
 * Receives the full agent context plus the triggering tool call details.
 */
export type AdvisorTrigger = (params: AdvisorTriggerParams) => boolean | Promise<boolean>;

/** Message produced by an advisor, injected into the parent agent's context. */
export interface AdvisorMessage {
	role: "advisor";
	advisorName: string;
	content: string;
	model: string;
	timestamp: number;
}

/**
 * Configuration for an advisor — a sub-agent that runs after specific tool
 * executions and injects feedback into the parent agent's context.
 */
export interface AdvisorConfig {
	/** Unique name for this advisor. */
	name: string;

	/** Model used for the advisor's LLM calls. */
	model: Model<any>;

	/** Decides whether this advisor fires after a given tool execution. */
	trigger: AdvisorTrigger;

	/** Tools available to the advisor. Omit for a pure single-LLM-call advisor. */
	tools?: AgentTool<any>[];

	/** Nested advisors for this advisor (recursive). Typically empty. */
	advisors?: AdvisorConfig[];

	/**
	 * Build the advisor's starting context from the parent's full context.
	 * Return a system prompt and messages (ending with a user message as the task).
	 */
	createContext: (params: {
		systemPrompt: string;
		messages: AgentMessage[];
		toolName: string;
		toolArgs: Record<string, any>;
		toolResult: ToolResultMessage;
	}) =>
		| { systemPrompt: string; messages: AgentMessage[] }
		| Promise<{ systemPrompt: string; messages: AgentMessage[] }>;

	/**
	 * Extract the final advisory text from the advisor's completed messages.
	 * Default: text content of the last assistant message.
	 */
	extractResult?: (messages: AgentMessage[]) => string;

	/**
	 * Custom convertToLlm for the advisor's own agent loop.
	 * Default handles standard messages + advisor messages.
	 */
	convertToLlm?: (messages: AgentMessage[]) => Message[] | Promise<Message[]>;

	/** Static API key for the advisor model. */
	apiKey?: string;

	/** Dynamic API key resolver for the advisor model. */
	getApiKey?: (provider: string) => Promise<string | undefined> | string | undefined;

	/** Thinking/reasoning level for the advisor model. */
	thinkingLevel?: ThinkingLevel;
}

/** Stream function - can return sync or Promise for async config lookup */
export type StreamFn = (
	...args: Parameters<typeof streamSimple>
) => ReturnType<typeof streamSimple> | Promise<ReturnType<typeof streamSimple>>;

/**
 * Configuration for the agent loop.
 */
export interface AgentLoopConfig extends SimpleStreamOptions {
	model: Model<any>;

	/**
	 * Converts AgentMessage[] to LLM-compatible Message[] before each LLM call.
	 *
	 * Each AgentMessage must be converted to a UserMessage, AssistantMessage, or ToolResultMessage
	 * that the LLM can understand. AgentMessages that cannot be converted (e.g., UI-only notifications,
	 * status messages) should be filtered out.
	 *
	 * @example
	 * ```typescript
	 * convertToLlm: (messages) => messages.flatMap(m => {
	 *   if (m.role === "custom") {
	 *     // Convert custom message to user message
	 *     return [{ role: "user", content: m.content, timestamp: m.timestamp }];
	 *   }
	 *   if (m.role === "notification") {
	 *     // Filter out UI-only messages
	 *     return [];
	 *   }
	 *   // Pass through standard LLM messages
	 *   return [m];
	 * })
	 * ```
	 */
	convertToLlm: (messages: AgentMessage[]) => Message[] | Promise<Message[]>;

	/**
	 * Optional transform applied to the context before `convertToLlm`.
	 *
	 * Use this for operations that work at the AgentMessage level:
	 * - Context window management (pruning old messages)
	 * - Injecting context from external sources
	 *
	 * @example
	 * ```typescript
	 * transformContext: async (messages) => {
	 *   if (estimateTokens(messages) > MAX_TOKENS) {
	 *     return pruneOldMessages(messages);
	 *   }
	 *   return messages;
	 * }
	 * ```
	 */
	transformContext?: (messages: AgentMessage[], signal?: AbortSignal) => Promise<AgentMessage[]>;

	/**
	 * Resolves an API key dynamically for each LLM call.
	 *
	 * Useful for short-lived OAuth tokens (e.g., GitHub Copilot) that may expire
	 * during long-running tool execution phases.
	 */
	getApiKey?: (provider: string) => Promise<string | undefined> | string | undefined;

	/**
	 * Returns steering messages to inject into the conversation mid-run.
	 *
	 * Called after each tool execution to check for user interruptions.
	 * If messages are returned, remaining tool calls are skipped and
	 * these messages are added to the context before the next LLM call.
	 *
	 * Use this for "steering" the agent while it's working.
	 */
	getSteeringMessages?: () => Promise<AgentMessage[]>;

	/**
	 * Returns follow-up messages to process after the agent would otherwise stop.
	 *
	 * Called when the agent has no more tool calls and no steering messages.
	 * If messages are returned, they're added to the context and the agent
	 * continues with another turn.
	 *
	 * Use this for follow-up messages that should wait until the agent finishes.
	 */
	getFollowUpMessages?: () => Promise<AgentMessage[]>;

	/**
	 * Advisors that run after matching tool executions.
	 * Each advisor is a sub-agent that reviews the context and injects
	 * a feedback message before the next LLM call.
	 */
	advisors?: AdvisorConfig[];
}

/**
 * Thinking/reasoning level for models that support it.
 * Note: "xhigh" is only supported by OpenAI gpt-5.1-codex-max, gpt-5.2, gpt-5.2-codex, gpt-5.3, and gpt-5.3-codex models.
 */
export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

/**
 * Extensible interface for custom app messages.
 * Apps can extend via declaration merging:
 *
 * @example
 * ```typescript
 * declare module "@mariozechner/agent" {
 *   interface CustomAgentMessages {
 *     artifact: ArtifactMessage;
 *     notification: NotificationMessage;
 *   }
 * }
 * ```
 */
export interface CustomAgentMessages {
	advisor: AdvisorMessage;
}

/**
 * AgentMessage: Union of LLM messages + custom messages.
 * This abstraction allows apps to add custom message types while maintaining
 * type safety and compatibility with the base LLM messages.
 */
export type AgentMessage = Message | CustomAgentMessages[keyof CustomAgentMessages];

/**
 * Agent state containing all configuration and conversation data.
 */
export interface AgentState {
	systemPrompt: string;
	model: Model<any>;
	thinkingLevel: ThinkingLevel;
	tools: AgentTool<any>[];
	messages: AgentMessage[]; // Can include attachments + custom message types
	isStreaming: boolean;
	streamMessage: AgentMessage | null;
	pendingToolCalls: Set<string>;
	error?: string;
}

export interface AgentToolResult<T> {
	// Content blocks supporting text and images
	content: (TextContent | ImageContent)[];
	// Details to be displayed in a UI or logged
	details: T;
}

// Callback for streaming tool execution updates
export type AgentToolUpdateCallback<T = any> = (partialResult: AgentToolResult<T>) => void;

// AgentTool extends Tool but adds the execute function
export interface AgentTool<TParameters extends TSchema = TSchema, TDetails = any> extends Tool<TParameters> {
	// A human-readable label for the tool to be displayed in UI
	label: string;
	execute: (
		toolCallId: string,
		params: Static<TParameters>,
		signal?: AbortSignal,
		onUpdate?: AgentToolUpdateCallback<TDetails>,
	) => Promise<AgentToolResult<TDetails>>;
}

// AgentContext is like Context but uses AgentTool
export interface AgentContext {
	systemPrompt: string;
	messages: AgentMessage[];
	tools?: AgentTool<any>[];
}

/**
 * Events emitted by the Agent for UI updates.
 * These events provide fine-grained lifecycle information for messages, turns, and tool executions.
 */
export type AgentEvent =
	// Agent lifecycle
	| { type: "agent_start" }
	| { type: "agent_end"; messages: AgentMessage[] }
	// Turn lifecycle - a turn is one assistant response + any tool calls/results
	| { type: "turn_start" }
	| { type: "turn_end"; message: AgentMessage; toolResults: ToolResultMessage[] }
	// Message lifecycle - emitted for user, assistant, and toolResult messages
	| { type: "message_start"; message: AgentMessage }
	// Only emitted for assistant messages during streaming
	| { type: "message_update"; message: AgentMessage; assistantMessageEvent: AssistantMessageEvent }
	| { type: "message_end"; message: AgentMessage }
	// Tool execution lifecycle
	| { type: "tool_execution_start"; toolCallId: string; toolName: string; args: any }
	| { type: "tool_execution_update"; toolCallId: string; toolName: string; args: any; partialResult: any }
	| { type: "tool_execution_end"; toolCallId: string; toolName: string; result: any; isError: boolean }
	// Advisor lifecycle
	| { type: "advisor_start"; advisorName: string; toolName: string }
	| { type: "advisor_event"; advisorName: string; event: AgentEvent }
	| { type: "advisor_end"; advisorName: string; content: string }
	| { type: "advisor_error"; advisorName: string; error: string };
