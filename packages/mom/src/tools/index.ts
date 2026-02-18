import type { AgentTool } from "@mariozechner/pi-agent-core";
import { createCodingTools } from "@mariozechner/pi-coding-agent";
import { attachTool } from "./attach.js";

export { setUploadFunction } from "./attach.js";

export function createMomTools(cwd: string): AgentTool<any>[] {
	return [...createCodingTools(cwd), attachTool];
}
