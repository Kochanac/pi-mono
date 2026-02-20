/**
 * TaskListComponent - Displays the current task list as a visual overlay.
 */

import { Container, Text } from "@mariozechner/pi-tui";
import { existsSync, readFileSync } from "fs";
import { join } from "path";

export interface TaskListItem {
	id: string;
	subject: string;
	status: "pending" | "in_progress" | "completed";
	blockedBy: string[];
	blocks: string[];
}

/**
 * Parse task list from file content.
 */
function _parseTaskList(text: string): TaskListItem[] {
	const items: TaskListItem[] = [];

	const lines = text.split("\n");
	for (const line of lines) {
		const pendingMatch = line.match(/^│\s*\[ \]\s+(.+?)(?:\s+⚠)?\s*│$/);
		const inProgressMatch = line.match(/^│\s*\[~\]\s+(.+?)(?:\s+⚠)?\s*│$/);
		const completedMatch = line.match(/^│\s*\[✓\]\s+(.+?)\s*│$/);

		let subject: string | undefined;
		let status: "pending" | "in_progress" | "completed" | undefined;

		if (pendingMatch) {
			subject = pendingMatch[1].trim();
			status = "pending";
		} else if (inProgressMatch) {
			subject = inProgressMatch[1].trim();
			status = "in_progress";
		} else if (completedMatch) {
			subject = completedMatch[1].trim();
			status = "completed";
		}

		if (subject && status) {
			items.push({
				id: `task-${items.length}`,
				subject,
				status,
				blockedBy: [],
				blocks: [],
			});
		}
	}

	return items;
}

/**
 * Get the current task list from the filesystem.
 */
export function getCurrentTaskList(): TaskListItem[] {
	const homeDir = process.env.HOME || process.env.USERPROFILE || "/home/user";
	const taskListId = process.env.PI_TASK_LIST_ID || "default";
	const taskListPath = join(homeDir, ".pi", "tasks", `${taskListId}.json`);

	if (!existsSync(taskListPath)) {
		return [];
	}

	try {
		const content = readFileSync(taskListPath, "utf-8");
		const taskList = JSON.parse(content);

		if (!taskList.tasks || !Array.isArray(taskList.tasks)) {
			return [];
		}

		return taskList.tasks.map((task: any) => ({
			id: task.id,
			subject: task.subject,
			status: task.status || "pending",
			blockedBy: task.blockedBy || [],
			blocks: task.blocks || [],
		}));
	} catch {
		return [];
	}
}

/**
 * Format task list for display.
 */
export function formatTaskListForDisplay(items: TaskListItem[]): string {
	const lines: string[] = [];

	if (items.length === 0) {
		lines.push("Pending:");
		lines.push("  No tasks yet");
		return lines.join("\n");
	}

	// Separate into pending/in_progress and completed
	const pending = items.filter((t) => t.status !== "completed");
	const completed = items.filter((t) => t.status === "completed");

	// Pending section
	if (pending.length > 0) {
		lines.push("Pending:");
		for (const task of pending) {
			const check = task.status === "in_progress" ? "○" : "○";
			let line = `  ${check} ${task.subject}`;
			if (task.blockedBy.length > 0) {
				line += ` [blocked by ${task.blockedBy.length}]`;
			}
			lines.push(line);
		}
	}

	// Completed section
	if (completed.length > 0) {
		if (lines.length > 0) {
			lines.push("");
		}
		lines.push("Completed:");
		for (const task of completed) {
			lines.push(`  ● ${task.subject}`);
		}
	}

	return lines.join("\n");
}

export class TaskListComponent extends Container {
	constructor() {
		super();

		const items = getCurrentTaskList();
		const taskText = formatTaskListForDisplay(items);

		const textComponent = new Text(taskText);
		this.addChild(textComponent);
	}
}
