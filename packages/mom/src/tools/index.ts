import type { AgentTool } from "@mariozechner/pi-agent-core";
import {
	createCodingTools,
	createFindTool,
	createGrepTool,
	createLsTool,
	createTaskCreateTool,
	createTaskGetTool,
	createTaskListTool,
	createTaskUpdateTool,
} from "@mariozechner/pi-coding-agent";
import { attachTool } from "./attach.js";

export { setUploadFunction } from "./attach.js";

export function createMomTools(cwd: string): AgentTool<any>[] {
	return [
		...createCodingTools(cwd),
		createGrepTool(cwd),
		createFindTool(cwd),
		createLsTool(cwd),
		createTaskCreateTool(),
		createTaskGetTool(),
		createTaskListTool(),
		createTaskUpdateTool(),
		attachTool,
	];
}
