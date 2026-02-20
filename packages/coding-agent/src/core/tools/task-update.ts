/**
 * TaskUpdate tool - Update task status, add blockers, modify details.
 */

import type { AgentTool } from "@mariozechner/pi-agent-core";
import type { TextContent } from "@mariozechner/pi-ai";
import { type Static, Type } from "@sinclair/typebox";
import {
	getCurrentTaskListId,
	getOrCreateTaskList,
	type TaskList,
	type TaskStatus,
	type TaskStorageOperations,
} from "./tasks-storage.js";

const taskUpdateSchema = Type.Object({
	taskId: Type.String({
		description: "ID of the task to update",
	}),
	status: Type.Optional(
		Type.Union([Type.Literal("pending"), Type.Literal("in_progress"), Type.Literal("completed")], {
			description: "New status for the task",
		}),
	),
	addBlockedBy: Type.Optional(
		Type.Array(Type.String(), {
			description: "Task IDs that block this task",
		}),
	),
	removeBlockedBy: Type.Optional(
		Type.Array(Type.String(), {
			description: "Task IDs to remove from blockedBy",
		}),
	),
	addBlocks: Type.Optional(
		Type.Array(Type.String(), {
			description: "Task IDs that this task blocks",
		}),
	),
	removeBlocks: Type.Optional(
		Type.Array(Type.String(), {
			description: "Task IDs to remove from blocks",
		}),
	),
	clearBlockedBy: Type.Optional(
		Type.Boolean({
			description: "Clear all blockedBy dependencies",
		}),
	),
	clearBlocks: Type.Optional(
		Type.Boolean({
			description: "Clear all blocks dependencies",
		}),
	),
});

export type TaskUpdateInput = Static<typeof taskUpdateSchema>;

export interface TaskUpdateDetails {
	taskId: string;
	subject: string;
	status: TaskStatus;
	changes: string[];
	timestamp: number;
}

/**
 * Create a custom TaskUpdate tool with storage operations.
 * Useful for testing or remote storage backends.
 */
export function createTaskUpdateTool(
	storage?: TaskStorageOperations,
): AgentTool<typeof taskUpdateSchema, TaskUpdateDetails> {
	const getStorage = () => storage;

	return {
		name: "taskUpdate",
		label: "TaskUpdate",
		description: `Update an existing task's status, dependencies, or other properties.

Status lifecycle: pending → in_progress → completed

Use cases:
- Mark task as in_progress when starting work
- Mark task as completed when done
- Add blockers to prevent starting until dependencies complete
- Remove blockers once dependencies are done

Examples:
- Start work: status="in_progress"
- Complete: status="completed"
- Add dependency: addBlockedBy=["task-123"]
- Remove dependency: removeBlockedBy=["task-123"]

When a blocking task is marked completed, update dependent tasks to remove that blocker from their blockedBy list.`,
		parameters: taskUpdateSchema,
		execute: async (
			_toolCallId: string,
			{
				taskId,
				status,
				addBlockedBy,
				removeBlockedBy,
				addBlocks,
				removeBlocks,
				clearBlockedBy,
				clearBlocks,
			}: TaskUpdateInput,
			_signal?: AbortSignal,
		) => {
			const taskListId = getCurrentTaskListId();
			const storage = getOrCreateTaskList(taskListId, getStorage() || undefined);

			return new Promise<{ content: TextContent[]; details: TaskUpdateDetails }>((resolve, reject) => {
				(async () => {
					try {
						const taskList = await storage;
						const task = taskList.tasks.find((t) => t.id === taskId);

						if (!task) {
							reject(new Error(`Task ${taskId} not found`));
							return;
						}

						const changes: string[] = [];
						const now = Date.now();

						// Update status
						if (status && status !== task.status) {
							const oldStatus = task.status;
							task.status = status;
							task.updatedAt = now;

							if (status === "completed") {
								task.completedAt = now;
							} else if (oldStatus === "completed") {
								// Clear completedAt if un-completing
								delete task.completedAt;
							}

							changes.push(`status: ${oldStatus} → ${status}`);
						}

						// Update blockedBy
						if (addBlockedBy && addBlockedBy.length > 0) {
							const newBlockers = addBlockedBy.filter((id: string) => !task.blockedBy.includes(id));
							if (newBlockers.length > 0) {
								task.blockedBy.push(...newBlockers);
								task.updatedAt = now;
								changes.push(`added blockers: ${newBlockers.join(", ")}`);
							}
						}

						if (removeBlockedBy && removeBlockedBy.length > 0) {
							const removed = removeBlockedBy.filter((id: string) => task.blockedBy.includes(id));
							if (removed.length > 0) {
								task.blockedBy = task.blockedBy.filter((id: string) => !removed.includes(id));
								task.updatedAt = now;
								changes.push(`removed blockers: ${removed.join(", ")}`);
							}
						}

						if (clearBlockedBy && task.blockedBy.length > 0) {
							task.blockedBy = [];
							task.updatedAt = now;
							changes.push("cleared all blockers");
						}

						// Update blocks (reverse relationship)
						if (addBlocks && addBlocks.length > 0) {
							const existingBlocks = taskList.tasks
								.filter((t) => addBlocks.includes(t.id))
								.filter((t) => !t.blockedBy.includes(taskId));

							for (const blockedTask of existingBlocks) {
								if (!blockedTask.blockedBy.includes(taskId)) {
									blockedTask.blockedBy.push(taskId);
								}
							}

							if (existingBlocks.length > 0) {
								task.blocks.push(...addBlocks);
								task.updatedAt = now;
								changes.push(`now blocks: ${existingBlocks.map((t) => t.subject).join(", ")}`);
							}
						}

						if (removeBlocks && removeBlocks.length > 0) {
							const unblocked = taskList.tasks
								.filter((t) => removeBlocks.includes(t.id))
								.filter((t) => t.blockedBy.includes(taskId));

							for (const blockedTask of unblocked) {
								blockedTask.blockedBy = blockedTask.blockedBy.filter((id: string) => id !== taskId);
							}

							task.blocks = task.blocks.filter((id: string) => !removeBlocks.includes(id));
							task.updatedAt = now;
							changes.push(`no longer blocks: ${unblocked.map((t) => t.subject).join(", ")}`);
						}

						if (clearBlocks && task.blocks.length > 0) {
							const unblocked = taskList.tasks.filter((t) => task.blocks.includes(t.id));
							for (const blockedTask of unblocked) {
								blockedTask.blockedBy = blockedTask.blockedBy.filter((id: string) => id !== taskId);
							}
							task.blocks = [];
							task.updatedAt = now;
							changes.push("cleared all blocked tasks");
						}

						// Save the task list
						await (getStorage()?.writeTaskList ?? defaultWriteTaskList)(taskList);

						const details: TaskUpdateDetails = {
							taskId,
							subject: task.subject,
							status: task.status,
							changes,
							timestamp: now,
						};

						const content: TextContent[] = [
							{
								type: "text",
								text: `Updated task "${task.subject}"\nTask ID: ${taskId}\nStatus: ${task.status}\n\nChanges: ${
									changes.length > 0 ? changes.join("\n- ") : "none"
								}`,
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

// Helper to access default writeTaskList
async function defaultWriteTaskList(taskList: TaskList): Promise<void> {
	const { defaultTaskStorageOperations } = await import("./tasks-storage.js");
	await defaultTaskStorageOperations.writeTaskList(taskList);
}

/** Default TaskUpdate tool using local filesystem storage */
export const taskUpdateTool = createTaskUpdateTool();
