/**
 * Task storage module for persistent task management.
 * Tasks are stored in ~/.pi/tasks/ with JSON files for each task list.
 */

import { mkdir, readdir, readFile, unlink, writeFile } from "fs/promises";
import { join } from "path";

/** Task status lifecycle */
export type TaskStatus = "pending" | "in_progress" | "completed";

/** Task object representing a single task */
export interface Task {
	id: string;
	subject: string;
	description: string;
	status: TaskStatus;
	createdAt: number;
	updatedAt: number;
	completedAt?: number;
	blockedBy: string[];
	blocks: string[];
}

/** Task list containing multiple tasks */
export interface TaskList {
	id: string;
	name: string;
	createdAt: number;
	updatedAt: number;
	tasks: Task[];
}

/** Storage operations interface for testability */
export interface TaskStorageOperations {
	readTaskList: (id: string) => Promise<TaskList | null>;
	writeTaskList: (taskList: TaskList) => Promise<void>;
	deleteTaskList: (id: string) => Promise<void>;
	listTaskLists: () => Promise<string[]>;
}

/** Default filesystem-based storage operations */
export const defaultTaskStorageOperations: TaskStorageOperations = {
	readTaskList: async (id: string) => {
		const homeDir = process.env.HOME || process.env.USERPROFILE || "/home/user";
		const taskListPath = join(homeDir, ".pi", "tasks", `${id}.json`);

		try {
			const content = await readFile(taskListPath, "utf-8");
			return JSON.parse(content) as TaskList;
		} catch (error) {
			if (error instanceof Error && "code" in error && error.code === "ENOENT") {
				return null;
			}
			throw error;
		}
	},

	writeTaskList: async (taskList: TaskList) => {
		const homeDir = process.env.HOME || process.env.USERPROFILE || "/home/user";
		const tasksDir = join(homeDir, ".pi", "tasks");
		const taskListPath = join(tasksDir, `${taskList.id}.json`);

		// Ensure directory exists
		await mkdir(tasksDir, { recursive: true });

		await writeFile(taskListPath, JSON.stringify(taskList, null, 2));
	},

	deleteTaskList: async (id: string) => {
		const homeDir = process.env.HOME || process.env.USERPROFILE || "/home/user";
		const taskListPath = join(homeDir, ".pi", "tasks", `${id}.json`);

		try {
			await unlink(taskListPath);
		} catch (error) {
			if (error instanceof Error && "code" in error && error.code === "ENOENT") {
				return;
			}
			throw error;
		}
	},

	listTaskLists: async () => {
		const homeDir = process.env.HOME || process.env.USERPROFILE || "/home/user";
		const tasksDir = join(homeDir, ".pi", "tasks");

		try {
			const files = await readdir(tasksDir);
			return files.filter((f) => f.endsWith(".json")).map((f) => f.replace(/\.json$/, ""));
		} catch (error) {
			if (error instanceof Error && "code" in error && error.code === "ENOENT") {
				return [];
			}
			throw error;
		}
	},
};

/** Get the current task list ID from environment or default */
export function getCurrentTaskListId(): string {
	return process.env.PI_TASK_LIST_ID || "default";
}

/** Create a new task list or get existing one */
export async function getOrCreateTaskList(
	taskListId: string,
	storage: TaskStorageOperations = defaultTaskStorageOperations,
): Promise<TaskList> {
	let taskList = await storage.readTaskList(taskListId);

	if (!taskList) {
		taskList = {
			id: taskListId,
			name: taskListId,
			createdAt: Date.now(),
			updatedAt: Date.now(),
			tasks: [],
		};
		await storage.writeTaskList(taskList);
	}

	return taskList;
}

/** Generate a unique task ID */
export function generateTaskId(): string {
	return `task-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
}
