/**
 * TaskCreate tool - Create tasks with subject and description.
 */

import type { AgentTool } from "@mariozechner/pi-agent-core";
import type { TextContent } from "@mariozechner/pi-ai";
import { type Static, Type } from "@sinclair/typebox";
import {
	generateTaskId,
	getCurrentTaskListId,
	getOrCreateTaskList,
	type TaskList,
	type TaskStorageOperations,
} from "./tasks-storage.js";

const taskCreateSchema = Type.Object({
	subject: Type.String({
		description: "Short summary of the task (what needs to be done)",
	}),
	description: Type.Optional(
		Type.String({
			description: "Detailed description of the task, including acceptance criteria",
		}),
	),
});

export type TaskCreateInput = Static<typeof taskCreateSchema>;

export interface TaskCreateDetails {
	taskId: string;
	subject: string;
	status: "pending";
	timestamp: number;
}

/**
 * Create a custom TaskCreate tool with storage operations.
 * Useful for testing or remote storage backends.
 */
export function createTaskCreateTool(
	storage?: TaskStorageOperations,
): AgentTool<typeof taskCreateSchema, TaskCreateDetails> {
	const getStorage = () => storage;

	return {
		name: "taskCreate",
		label: "TaskCreate",
		description: `Create a new task with a subject and optional description. Tasks persist across sessions. Use this for multi-step work that needs tracking.

Status starts as "pending". Use TaskUpdate to change status to "in_progress" when starting work, and mark "completed" when done.

For complex work, break it into multiple tasks with TaskCreate, then use TaskUpdate with addBlockedBy to create dependencies.

Example:
- Subject: "Design authentication system"
- Description: "Create auth schema, implement login/logout, add session management"

Environment variable PI_TASK_LIST_ID controls which task list to use (default: "default"). Multiple sessions can share a task list by setting the same PI_TASK_LIST_ID.`,
		parameters: taskCreateSchema,
		execute: async (_toolCallId: string, { subject, description }: TaskCreateInput, _signal?: AbortSignal) => {
			const taskListId = getCurrentTaskListId();
			const storage = getOrCreateTaskList(taskListId, getStorage() || undefined);

			return new Promise<{ content: TextContent[]; details: TaskCreateDetails }>((resolve, reject) => {
				(async () => {
					try {
						const taskList = await storage;
						const taskId = generateTaskId();
						const now = Date.now();

						const newTask = {
							id: taskId,
							subject,
							description: description || "",
							status: "pending" as const,
							createdAt: now,
							updatedAt: now,
							blockedBy: [],
							blocks: [],
						};

						taskList.tasks.push(newTask);
						taskList.updatedAt = now;

						await (getStorage()?.writeTaskList ?? defaultWriteTaskList)(taskList);

						const details: TaskCreateDetails = {
							taskId,
							subject,
							status: "pending",
							timestamp: now,
						};

						const content: TextContent[] = [
							{
								type: "text",
								text: `Created task "${subject}"\nTask ID: ${taskId}\nStatus: pending\n\nTo update this task, use TaskUpdate with taskId="${taskId}"`,
							},
						];

						resolve({ content, details });
					} catch (error) {
						reject(error);
					}
				})();
			});
		},
	};
}

// Helper to access default writeTaskList (workaround for the scope issue)
async function defaultWriteTaskList(taskList: TaskList): Promise<void> {
	const { defaultTaskStorageOperations } = await import("./tasks-storage.js");
	await defaultTaskStorageOperations.writeTaskList(taskList);
}

/** Default TaskCreate tool using local filesystem storage */
export const taskCreateTool = createTaskCreateTool();
