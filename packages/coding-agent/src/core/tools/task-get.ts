/**
 * TaskGet tool - Retrieve full task details including dependencies.
 */

import type { AgentTool } from "@mariozechner/pi-agent-core";
import type { TextContent } from "@mariozechner/pi-ai";
import { type Static, Type } from "@sinclair/typebox";
import {
	getCurrentTaskListId,
	getOrCreateTaskList,
	type TaskList,
	type TaskStorageOperations,
} from "./tasks-storage.js";

const taskGetSchema = Type.Object({
	taskId: Type.String({
		description: "ID of the task to retrieve",
	}),
});

export type TaskGetInput = Static<typeof taskGetSchema>;

export interface TaskGetDetails {
	taskId: string;
	subject: string;
	description: string;
	status: string;
	createdAt: number;
	updatedAt: number;
	completedAt?: number;
	blockedBy: string[];
	blocks: string[];
}

/**
 * Format task details for display
 */
function formatTaskDetails(task: NonNullable<TaskList["tasks"][0]>, allTasks: TaskList["tasks"]): string {
	const lines = [
		`Task: ${task.subject}`,
		`ID: ${task.id}`,
		`Status: ${task.status}`,
		`Created: ${new Date(task.createdAt).toISOString()}`,
		`Updated: ${new Date(task.updatedAt).toISOString()}`,
	];

	if (task.description) {
		lines.push("", "Description:", task.description);
	}

	if (task.status === "completed" && task.completedAt) {
		lines.push(`Completed: ${new Date(task.completedAt).toISOString()}`);
	}

	if (task.blockedBy.length > 0) {
		const blockedByTasks = task.blockedBy
			.map((id) => {
				const t = allTasks.find((x) => x.id === id);
				return t ? `  - ${t.subject} (${t.status})` : `  - ${id} (not found)`;
			})
			.join("\n");
		lines.push("", `Blocked by (${task.blockedBy.length}):`, blockedByTasks);
	}

	if (task.blocks.length > 0) {
		const blocksTasks = task.blocks
			.map((id) => {
				const t = allTasks.find((x) => x.id === id);
				return t ? `  - ${t.subject} (${t.status})` : `  - ${id} (not found)`;
			})
			.join("\n");
		lines.push("", `Blocks (${task.blocks.length}):`, blocksTasks);
	}

	return lines.join("\n");
}

/**
 * Create a custom TaskGet tool with storage operations.
 * Useful for testing or remote storage backends.
 */
export function createTaskGetTool(storage?: TaskStorageOperations): AgentTool<typeof taskGetSchema, TaskGetDetails> {
	const getStorage = () => storage;

	return {
		name: "taskGet",
		label: "TaskGet",
		description: `Retrieve detailed information about a specific task, including its subject, description, status, and dependency relationships.

Returns all task details including:
- Subject and description
- Current status and timestamps
- Tasks that block this task (blockedBy)
- Tasks that this task blocks (blocks)

Use this to understand task context and dependencies before updating or completing a task.`,
		parameters: taskGetSchema,
		execute: async (_toolCallId: string, { taskId }: TaskGetInput, _signal?: AbortSignal) => {
			const taskListId = getCurrentTaskListId();
			const storage = getOrCreateTaskList(taskListId, getStorage() || undefined);

			return new Promise<{ content: TextContent[]; details: TaskGetDetails }>((resolve, reject) => {
				(async () => {
					try {
						const taskList = await storage;
						const task = taskList.tasks.find((t) => t.id === taskId);

						if (!task) {
							reject(new Error(`Task ${taskId} not found`));
							return;
						}

						const details: TaskGetDetails = {
							taskId: task.id,
							subject: task.subject,
							description: task.description,
							status: task.status,
							createdAt: task.createdAt,
							updatedAt: task.updatedAt,
							completedAt: task.completedAt,
							blockedBy: task.blockedBy,
							blocks: task.blocks,
						};

						const content: TextContent[] = [
							{
								type: "text",
								text: formatTaskDetails(task, taskList.tasks),
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

/** Default TaskGet tool using local filesystem storage */
export const taskGetTool = createTaskGetTool();
