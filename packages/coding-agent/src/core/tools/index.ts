export {
	type BashOperations,
	type BashSpawnContext,
	type BashSpawnHook,
	type BashToolDetails,
	type BashToolInput,
	type BashToolOptions,
	bashTool,
	createBashTool,
} from "./bash.js";
export {
	type BrowserToolInput,
	type BrowserToolOptions,
	browserTool,
	createBrowserTool,
} from "./browser.js";
export {
	createEditTool,
	type EditOperations,
	type EditToolDetails,
	type EditToolInput,
	type EditToolOptions,
	editTool,
} from "./edit.js";
export {
	createFindTool,
	type FindOperations,
	type FindToolDetails,
	type FindToolInput,
	type FindToolOptions,
	findTool,
} from "./find.js";
export {
	createGrepTool,
	type GrepOperations,
	type GrepToolDetails,
	type GrepToolInput,
	type GrepToolOptions,
	grepTool,
} from "./grep.js";
export {
	createLsTool,
	type LsOperations,
	type LsToolDetails,
	type LsToolInput,
	type LsToolOptions,
	lsTool,
} from "./ls.js";
export {
	createReadTool,
	type ReadOperations,
	type ReadToolDetails,
	type ReadToolInput,
	type ReadToolOptions,
	readTool,
} from "./read.js";
// Task tools
export {
	createTaskCreateTool,
	type TaskCreateDetails,
	type TaskCreateInput,
	taskCreateTool,
} from "./task-create.js";
export {
	createTaskGetTool,
	type TaskGetDetails,
	type TaskGetInput,
	taskGetTool,
} from "./task-get.js";
export {
	createTaskListTool,
	type TaskListDetails,
	type TaskListInput,
	taskListTool,
} from "./task-list.js";
export {
	createTaskResetTool,
	type TaskResetDetails,
	type TaskResetInput,
	taskResetTool,
} from "./task-reset.js";
export {
	createTaskUpdateTool,
	type TaskUpdateDetails,
	type TaskUpdateInput,
	taskUpdateTool,
} from "./task-update.js";
export {
	defaultTaskStorageOperations,
	generateTaskId,
	getCurrentTaskListId,
	getOrCreateTaskList,
	type TaskList,
	type TaskStatus,
	type TaskStorageOperations,
} from "./tasks-storage.js";
export {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	formatSize,
	type TruncationOptions,
	type TruncationResult,
	truncateHead,
	truncateLine,
	truncateTail,
} from "./truncate.js";
export {
	createWriteTool,
	type WriteOperations,
	type WriteToolInput,
	type WriteToolOptions,
	writeTool,
} from "./write.js";

import type { AgentTool } from "@mariozechner/pi-agent-core";
import { type BashToolOptions, bashTool, createBashTool } from "./bash.js";
import { type BrowserToolOptions, browserTool, createBrowserTool } from "./browser.js";
import { createEditTool, editTool } from "./edit.js";
import { createFindTool, findTool } from "./find.js";
import { createGrepTool, grepTool } from "./grep.js";
import { createLsTool, lsTool } from "./ls.js";
import { createReadTool, type ReadToolOptions, readTool } from "./read.js";
import { createTaskCreateTool, taskCreateTool } from "./task-create.js";
import { createTaskGetTool, taskGetTool } from "./task-get.js";
import { createTaskListTool, taskListTool } from "./task-list.js";
import { createTaskResetTool, taskResetTool } from "./task-reset.js";
import { createTaskUpdateTool, taskUpdateTool } from "./task-update.js";
import { createWriteTool, writeTool } from "./write.js";

/** Tool type (AgentTool from pi-ai) */
export type Tool = AgentTool<any>;

// Default tools for full access mode (using process.cwd())
export const codingTools: Tool[] = [
	readTool,
	bashTool,
	editTool,
	writeTool,
	browserTool,
	taskCreateTool,
	taskGetTool,
	taskListTool,
	taskResetTool,
	taskUpdateTool,
];

// Read-only tools for exploration without modification (using process.cwd())
export const readOnlyTools: Tool[] = [readTool, grepTool, findTool, lsTool];

// Task management tools
export const taskTools: Tool[] = [taskCreateTool, taskGetTool, taskListTool, taskResetTool, taskUpdateTool];

// All coding tools including task management
export const allTools = {
	read: readTool,
	bash: bashTool,
	edit: editTool,
	write: writeTool,
	grep: grepTool,
	find: findTool,
	ls: lsTool,
	browser: browserTool,
	taskCreate: taskCreateTool,
	taskGet: taskGetTool,
	taskList: taskListTool,
	taskReset: taskResetTool,
	taskUpdate: taskUpdateTool,
};

export type ToolName = keyof typeof allTools;

export interface ToolsOptions {
	/** Options for the read tool */
	read?: ReadToolOptions;
	/** Options for the bash tool */
	bash?: BashToolOptions;
	/** Options for the browser tool */
	browser?: BrowserToolOptions;
}

/**
 * Create coding tools configured for a specific working directory.
 */
export function createCodingTools(cwd: string, options?: ToolsOptions): Tool[] {
	return [
		createReadTool(cwd, options?.read),
		createBashTool(cwd, options?.bash),
		createEditTool(cwd),
		createWriteTool(cwd),
		createBrowserTool(options?.browser),
	];
}

/**
 * Create read-only tools configured for a specific working directory.
 */
export function createReadOnlyTools(cwd: string, options?: ToolsOptions): Tool[] {
	return [createReadTool(cwd, options?.read), createGrepTool(cwd), createFindTool(cwd), createLsTool(cwd)];
}

/**
 * Create all tools configured for a specific working directory.
 */
export function createAllTools(cwd: string, options?: ToolsOptions): Record<ToolName, Tool> {
	return {
		read: createReadTool(cwd, options?.read),
		bash: createBashTool(cwd, options?.bash),
		edit: createEditTool(cwd),
		write: createWriteTool(cwd),
		grep: createGrepTool(cwd),
		find: createFindTool(cwd),
		ls: createLsTool(cwd),
		browser: createBrowserTool(options?.browser),
		taskCreate: createTaskCreateTool(),
		taskGet: createTaskGetTool(),
		taskList: createTaskListTool(),
		taskReset: createTaskResetTool(),
		taskUpdate: createTaskUpdateTool(),
	};
}

/**
 * Create task management tools.
 */
export function createTaskManagementTools(): Record<
	"taskCreate" | "taskGet" | "taskList" | "taskReset" | "taskUpdate",
	Tool
> {
	return {
		taskCreate: createTaskCreateTool(),
		taskGet: createTaskGetTool(),
		taskList: createTaskListTool(),
		taskReset: createTaskResetTool(),
		taskUpdate: createTaskUpdateTool(),
	};
}
