/**
 * TaskList tool - List all tasks with current state.
 */

import type { AgentTool } from "@mariozechner/pi-agent-core";
import type { TextContent } from "@mariozechner/pi-ai";
import { type Static, Type } from "@sinclair/typebox";
import {
	getCurrentTaskListId,
	getOrCreateTaskList,
	type Task,
	type TaskStatus,
	type TaskStorageOperations,
} from "./tasks-storage.js";

const taskListSchema = Type.Object({
	status: Type.Optional(
		Type.Union([Type.Literal("pending"), Type.Literal("in_progress"), Type.Literal("completed")], {
			description: "Filter by status (pending, in_progress, completed)",
		}),
	),
	includeCompleted: Type.Optional(
		Type.Boolean({
			description: "Include completed tasks in the list (default: true)",
		}),
	),
});

export type TaskListInput = Static<typeof taskListSchema>;

export interface TaskListDetails {
	taskListId: string;
	totalCount: number;
	pendingCount: number;
	inProgressCount: number;
	completedCount: number;
	tasks: Array<{
		id: string;
		subject: string;
		status: TaskStatus;
		blockedBy: string[];
		blocks: string[];
	}>;
}

/**
 * Format task for list display
 */
function formatTaskList(tasks: Task[], includeCompleted: boolean = true, statusFilter?: TaskStatus): string {
	const filtered = tasks.filter((task) => {
		if (statusFilter && task.status !== statusFilter) {
			return false;
		}
		if (!includeCompleted && task.status === "completed") {
			return false;
		}
		return true;
	});

	if (filtered.length === 0) {
		return "No tasks found.";
	}

	const pending: Task[] = [];
	const inProgress: Task[] = [];
	const completed: Task[] = [];

	for (const task of filtered) {
		if (task.status === "pending") {
			pending.push(task);
		} else if (task.status === "in_progress") {
			inProgress.push(task);
		} else {
			completed.push(task);
		}
	}

	const output: string[] = [];

	if (inProgress.length > 0) {
		output.push("In Progress:");
		for (const task of inProgress) {
			const blockedByCount = task.blockedBy.length;
			const blocksCount = task.blocks.length;
			const blockersNote = blockedByCount > 0 ? ` [blocked by ${blockedByCount}]` : "";
			const blocksNote = blocksCount > 0 ? ` [blocks ${blocksCount}]` : "";
			output.push(`  ◐ ${task.subject}${blockersNote}${blocksNote}`);
		}
		output.push("");
	}

	if (pending.length > 0) {
		output.push("Pending:");
		for (const task of pending) {
			const blockedByCount = task.blockedBy.length;
			const blocksCount = task.blocks.length;
			const blockersNote = blockedByCount > 0 ? ` [blocked by ${blockedByCount}]` : "";
			const blocksNote = blocksCount > 0 ? ` [blocks ${blocksCount}]` : "";
			output.push(`  ○ ${task.subject}${blockersNote}${blocksNote}`);
		}
		output.push("");
	}

	if (includeCompleted && completed.length > 0) {
		output.push("Completed:");
		for (const task of completed) {
			const blockedByCount = task.blockedBy.length;
			const blocksCount = task.blocks.length;
			const blockersNote = blockedByCount > 0 ? ` [was blocked by ${blockedByCount}]` : "";
			const blocksNote = blocksCount > 0 ? ` [was blocking ${blocksCount}]` : "";
			output.push(`  ● ${task.subject}${blockersNote}${blocksNote}`);
		}
	}

	return output.join("\n");
}

/**
 * Create a custom TaskList tool with storage operations.
 * Useful for testing or remote storage backends.
 */
export function createTaskListTool(storage?: TaskStorageOperations): AgentTool<typeof taskListSchema, TaskListDetails> {
	const getStorage = () => storage;

	return {
		name: "taskList",
		label: "TaskList",
		description: `List all tasks in the current task list, optionally filtered by status.

Shows tasks organized by status:
- ◐ In Progress (working on now)
- ○ Pending (waiting to start)
- ● Completed (done)

Shows dependency indicators:
- [blocked by N] - tasks that must complete first
- [blocks N] - tasks waiting on this one

Use TaskUpdate to:
- Mark a pending task as in_progress when starting work
- Mark a task as completed when done
- Add/remove blockers as dependencies change

Environment variable PI_TASK_LIST_ID controls which task list to use. Multiple sessions can share by setting the same value.`,
		parameters: taskListSchema,
		execute: async (_toolCallId: string, { status, includeCompleted }: TaskListInput, _signal?: AbortSignal) => {
			const taskListId = getCurrentTaskListId();
			const storage = getOrCreateTaskList(taskListId, getStorage() || undefined);

			return new Promise<{ content: TextContent[]; details: TaskListDetails }>((resolve, reject) => {
				(async () => {
					try {
						const taskList = await storage;
						const shouldIncludeCompleted = includeCompleted ?? true;

						const tasks = taskList.tasks.filter((task) => {
							if (status && task.status !== status) {
								return false;
							}
							if (!shouldIncludeCompleted && task.status === "completed") {
								return false;
							}
							return true;
						});

						const pendingCount = taskList.tasks.filter((t) => t.status === "pending").length;
						const inProgressCount = taskList.tasks.filter((t) => t.status === "in_progress").length;
						const completedCount = taskList.tasks.filter((t) => t.status === "completed").length;

						const details: TaskListDetails = {
							taskListId,
							totalCount: taskList.tasks.length,
							pendingCount,
							inProgressCount,
							completedCount,
							tasks: tasks.map((t) => ({
								id: t.id,
								subject: t.subject,
								status: t.status,
								blockedBy: t.blockedBy,
								blocks: t.blocks,
							})),
						};

						const summary = [
							`Task List: ${taskListId}`,
							`Total: ${taskList.tasks.length} | Pending: ${pendingCount} | In Progress: ${inProgressCount} | Completed: ${completedCount}`,
							"",
							formatTaskList(taskList.tasks, shouldIncludeCompleted, status),
						].join("\n");

						const content: TextContent[] = [
							{
								type: "text",
								text: summary,
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

/** Default TaskList tool using local filesystem storage */
export const taskListTool = createTaskListTool();
