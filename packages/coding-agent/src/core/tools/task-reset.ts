/**
 * TaskReset tool - Delete the current task list.
 */

import type { AgentTool } from "@mariozechner/pi-agent-core";
import type { TextContent } from "@mariozechner/pi-ai";
import { type Static, Type } from "@sinclair/typebox";
import {
	defaultTaskStorageOperations,
	getCurrentTaskListId,
	getOrCreateTaskList,
	type TaskStorageOperations,
} from "./tasks-storage.js";

const taskResetSchema = Type.Object({
	/** Task list ID to reset (defaults to current) */
	taskListId: Type.Optional(Type.String({ description: "Task list ID to reset (defaults to current)" })),
});

export type TaskResetInput = Static<typeof taskResetSchema>;

export interface TaskResetDetails {
	deletedTaskListId: string;
	deletedTaskCount: number;
}

/**
 * Create a custom TaskReset tool with storage operations.
 */
export function createTaskResetTool(
	storage?: TaskStorageOperations,
): AgentTool<typeof taskResetSchema, TaskResetDetails> {
	const getStorage = () => storage;

	return {
		name: "taskReset",
		label: "TaskReset",
		description: `Delete the current task list or a specific task list by ID.

This will permanently remove all tasks in the task list. Use with caution.
After reset, a new empty task list will be created for the given ID.

Environment variable PI_TASK_LIST_ID controls which task list is used.`,
		parameters: taskResetSchema,
		execute: async (_toolCallId: string, { taskListId }: TaskResetInput, _signal?: AbortSignal) => {
			const id = taskListId || getCurrentTaskListId();
			const storage = getStorage() || defaultTaskStorageOperations;

			return new Promise<{ content: TextContent[]; details: TaskResetDetails }>((resolve, reject) => {
				(async () => {
					try {
						// Get the task list first to count tasks
						const taskList = await getOrCreateTaskList(id, storage);
						const taskCount = taskList.tasks.length;

						// Delete the task list
						await storage.deleteTaskList(id);

						const content: TextContent[] = [
							{
								type: "text",
								text: `Deleted task list "${id}" with ${taskCount} task(s).`,
							},
						];

						const details: TaskResetDetails = {
							deletedTaskListId: id,
							deletedTaskCount: taskCount,
						};

						resolve({ content, details });
					} catch (error) {
						reject(error);
					}
				})();
			});
		},
	};
}

/** Default TaskReset tool using local filesystem storage */
export const taskResetTool = createTaskResetTool();
