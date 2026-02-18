import type { AgentTool } from "@mariozechner/pi-agent-core";
import type { ImageContent, TextContent } from "@mariozechner/pi-ai";
import { type Static, Type } from "@sinclair/typebox";
import type { Browser, BrowserContext, Page } from "playwright";
import { chromium } from "playwright";

const browserSchema = Type.Object({
	action: Type.String({
		description:
			"Action: navigate, snapshot, click, type, fill, select, press, screenshot, evaluate, scroll, back, forward, close",
	}),
	url: Type.Optional(Type.String({ description: "URL for navigate action" })),
	ref: Type.Optional(Type.Number({ description: "Element ref number from snapshot" })),
	text: Type.Optional(Type.String({ description: "Text for type/fill actions" })),
	value: Type.Optional(Type.String({ description: "Value for select action" })),
	key: Type.Optional(Type.String({ description: "Key for press action (e.g. Enter, Tab, Escape)" })),
	js: Type.Optional(Type.String({ description: "JavaScript for evaluate action" })),
	direction: Type.Optional(Type.String({ description: "Scroll direction: up or down" })),
});

export type BrowserToolInput = Static<typeof browserSchema>;

export interface BrowserToolOptions {
	/** Launch in headless mode. Default: false (visible browser window) */
	headless?: boolean;
	/** Viewport width in pixels. Default: 1280 */
	viewportWidth?: number;
	/** Viewport height in pixels. Default: 720 */
	viewportHeight?: number;
}

interface CollectedElement {
	ref: number;
	role: string;
	name: string;
	type?: string;
	href?: string;
	placeholder?: string;
	value?: string;
	checked?: boolean;
	disabled?: boolean;
	required?: boolean;
}

const MAX_SNAPSHOT_CHARS = 20000;

/**
 * JavaScript injected into the page to collect interactive elements.
 * Each element is tagged with a data-pi-ref attribute for later targeting.
 */
const COLLECT_ELEMENTS_JS = `(() => {
	document.querySelectorAll('[data-pi-ref]').forEach(el => el.removeAttribute('data-pi-ref'));

	const selectors = [
		'a[href]', 'button', 'input:not([type="hidden"])', 'select', 'textarea',
		'[role="button"]', '[role="link"]', '[role="textbox"]', '[role="checkbox"]',
		'[role="radio"]', '[role="combobox"]', '[role="menuitem"]', '[role="menuitemcheckbox"]',
		'[role="menuitemradio"]', '[role="option"]', '[role="switch"]', '[role="tab"]',
		'[role="slider"]', '[role="spinbutton"]', '[role="searchbox"]', '[role="treeitem"]',
		'[contenteditable="true"]'
	];

	const elements = [...document.querySelectorAll(selectors.join(','))];
	const seen = new Set();
	const results = [];
	let refNum = 0;

	for (const el of elements) {
		if (seen.has(el)) continue;
		seen.add(el);

		const style = window.getComputedStyle(el);
		if (style.display === 'none' || style.visibility === 'hidden') continue;

		const rect = el.getBoundingClientRect();
		if (rect.width === 0 && rect.height === 0) continue;

		refNum++;
		el.setAttribute('data-pi-ref', String(refNum));

		let role = el.getAttribute('role');
		if (!role) {
			const tag = el.tagName.toLowerCase();
			const type = (el.getAttribute('type') || '').toLowerCase();
			if (tag === 'a') role = 'link';
			else if (tag === 'button' || (tag === 'input' && (type === 'button' || type === 'submit' || type === 'reset'))) role = 'button';
			else if (tag === 'input' && type === 'checkbox') role = 'checkbox';
			else if (tag === 'input' && type === 'radio') role = 'radio';
			else if (tag === 'input' && type === 'range') role = 'slider';
			else if (tag === 'input' && type === 'number') role = 'spinbutton';
			else if (tag === 'input' && type === 'search') role = 'searchbox';
			else if (tag === 'input') role = 'textbox';
			else if (tag === 'textarea') role = 'textbox';
			else if (tag === 'select') role = 'combobox';
			else role = tag;
		}

		let name = el.getAttribute('aria-label') || '';
		if (!name) {
			const labelledBy = el.getAttribute('aria-labelledby');
			if (labelledBy) {
				const labelEl = document.getElementById(labelledBy);
				if (labelEl) name = labelEl.textContent?.trim() || '';
			}
		}
		if (!name) {
			const id = el.getAttribute('id');
			if (id) {
				const label = document.querySelector('label[for="' + id + '"]');
				if (label) name = label.textContent?.trim() || '';
			}
		}
		if (!name) name = el.getAttribute('title') || el.getAttribute('alt') || '';
		if (!name && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA')) {
			name = el.getAttribute('placeholder') || '';
		}
		if (!name) {
			name = (el.textContent || '').trim().substring(0, 80);
		}

		results.push({
			ref: refNum,
			role,
			name,
			type: el.getAttribute('type') || undefined,
			href: el.getAttribute('href') || undefined,
			placeholder: el.getAttribute('placeholder') || undefined,
			value: (el.value != null && el.value !== '') ? String(el.value).substring(0, 100) : undefined,
			checked: el.checked || undefined,
			disabled: el.disabled || undefined,
			required: el.required || undefined,
		});
	}

	return results;
})()`;

function formatElement(el: CollectedElement): string {
	let line = `[${el.ref}] ${el.role}`;
	if (el.name) line += ` "${el.name}"`;

	const attrs: string[] = [];
	if (el.href) {
		const href = el.href.length > 60 ? `${el.href.substring(0, 60)}...` : el.href;
		attrs.push(`href="${href}"`);
	}
	if (el.placeholder) attrs.push(`placeholder="${el.placeholder}"`);
	if (el.value) attrs.push(`value="${el.value}"`);
	if (el.checked) attrs.push("checked");
	if (el.disabled) attrs.push("disabled");
	if (el.required) attrs.push("required");

	if (attrs.length > 0) line += ` (${attrs.join(", ")})`;
	return line;
}

function textResult(t: string): { content: (TextContent | ImageContent)[]; details: undefined } {
	return { content: [{ type: "text", text: t }], details: undefined };
}

export function createBrowserTool(options?: BrowserToolOptions): AgentTool<typeof browserSchema> {
	const headless = options?.headless ?? false;
	const viewportWidth = options?.viewportWidth ?? 1280;
	const viewportHeight = options?.viewportHeight ?? 720;

	let browser: Browser | null = null;
	let context: BrowserContext | null = null;
	let page: Page | null = null;

	async function ensurePage(): Promise<Page> {
		if (!browser || !page) {
			const args: string[] = [];
			if (!headless && process.env.WAYLAND_DISPLAY && !process.env.DISPLAY) {
				args.push("--ozone-platform=wayland");
			}

			try {
				browser = await chromium.launch({ headless, args });
			} catch (e: unknown) {
				const msg = e instanceof Error ? e.message : String(e);
				if (msg.includes("Executable doesn't exist") || msg.includes("browserType.launch")) {
					throw new Error("Chromium not found. Install with: npx playwright install chromium");
				}
				throw e;
			}
			context = await browser.newContext({
				viewport: { width: viewportWidth, height: viewportHeight },
			});
			page = await context.newPage();

			context.on("page", (newPage: Page) => {
				page = newPage;
			});
		}
		return page;
	}

	function ref(p: Page, refNum: number) {
		return p.locator(`[data-pi-ref="${refNum}"]`);
	}

	return {
		name: "browser",
		label: "browser",
		description: `Control a headed browser to navigate and interact with web pages.

Actions:
- navigate: Go to URL. Params: url
- snapshot: Get page accessibility tree and numbered interactive elements. Call after navigate or page changes.
- click: Click element. Params: ref (number from snapshot)
- type: Type text into element (appends). Params: ref, text
- fill: Clear and replace text in element. Params: ref, text
- select: Select dropdown option. Params: ref, value
- press: Press keyboard key. Params: key (e.g. "Enter", "Tab", "Escape", "ArrowDown")
- screenshot: Take page screenshot (returns image)
- evaluate: Run JavaScript in page. Params: js
- scroll: Scroll page. Params: direction ("up" or "down")
- back: Go back in history
- forward: Go forward in history
- close: Close browser

Workflow: navigate -> snapshot -> interact with elements using ref numbers -> snapshot again to verify.`,
		parameters: browserSchema,
		execute: async (_toolCallId: string, params: BrowserToolInput, signal?: AbortSignal) => {
			if (signal?.aborted) throw new Error("Operation aborted");

			const { action } = params;

			if (action === "close") {
				if (browser) {
					await browser.close();
					browser = null;
					context = null;
					page = null;
				}
				return textResult("Browser closed.");
			}

			const p = await ensurePage();

			switch (action) {
				case "navigate": {
					if (!params.url) throw new Error("url is required for navigate");
					const response = await p.goto(params.url, {
						waitUntil: "domcontentloaded",
						timeout: 30000,
					});
					const status = response?.status() ?? "unknown";
					return textResult(`Navigated to ${params.url} (status: ${status}). Call snapshot to see the page.`);
				}

				case "snapshot": {
					let ariaTree = "";
					try {
						ariaTree = await p.locator("body").ariaSnapshot({ timeout: 5000 });
						if (ariaTree.length > MAX_SNAPSHOT_CHARS) {
							ariaTree = `${ariaTree.substring(0, MAX_SNAPSHOT_CHARS)}\n... (truncated)`;
						}
					} catch {
						ariaTree = "(accessibility tree unavailable)";
					}

					const elements: CollectedElement[] = await p.evaluate(COLLECT_ELEMENTS_JS);

					const title = await p.title();
					const url = p.url();

					let output = `Page: ${title}\nURL: ${url}\n\n`;
					output += `--- Accessibility Tree ---\n${ariaTree}\n\n`;
					output += "--- Interactive Elements ---\n";

					if (elements.length === 0) {
						output += "(no interactive elements found)\n";
					} else {
						for (const el of elements) {
							output += `${formatElement(el)}\n`;
						}
					}

					return textResult(output);
				}

				case "click": {
					if (params.ref == null) throw new Error("ref is required for click");
					try {
						await ref(p, params.ref).click({ timeout: 5000 });
					} catch (e: unknown) {
						const msg = e instanceof Error ? e.message : String(e);
						throw new Error(`Failed to click [${params.ref}]: ${msg}. Call snapshot to refresh refs.`);
					}
					return textResult(`Clicked [${params.ref}]. Call snapshot to see updated page.`);
				}

				case "type": {
					if (params.ref == null) throw new Error("ref is required for type");
					if (params.text == null) throw new Error("text is required for type");
					try {
						await ref(p, params.ref).pressSequentially(params.text, { timeout: 5000 });
					} catch (e: unknown) {
						const msg = e instanceof Error ? e.message : String(e);
						throw new Error(`Failed to type into [${params.ref}]: ${msg}`);
					}
					return textResult(`Typed "${params.text}" into [${params.ref}].`);
				}

				case "fill": {
					if (params.ref == null) throw new Error("ref is required for fill");
					if (params.text == null) throw new Error("text is required for fill");
					try {
						await ref(p, params.ref).fill(params.text, { timeout: 5000 });
					} catch (e: unknown) {
						const msg = e instanceof Error ? e.message : String(e);
						throw new Error(`Failed to fill [${params.ref}]: ${msg}`);
					}
					return textResult(`Filled [${params.ref}] with "${params.text}".`);
				}

				case "select": {
					if (params.ref == null) throw new Error("ref is required for select");
					if (params.value == null) throw new Error("value is required for select");
					try {
						await ref(p, params.ref).selectOption(params.value, { timeout: 5000 });
					} catch (e: unknown) {
						const msg = e instanceof Error ? e.message : String(e);
						throw new Error(`Failed to select in [${params.ref}]: ${msg}`);
					}
					return textResult(`Selected "${params.value}" in [${params.ref}].`);
				}

				case "press": {
					if (!params.key) throw new Error("key is required for press");
					await p.keyboard.press(params.key);
					return textResult(`Pressed "${params.key}".`);
				}

				case "screenshot": {
					const buffer = await p.screenshot({ type: "png", fullPage: false });
					const base64 = buffer.toString("base64");
					return {
						content: [
							{ type: "text", text: `Screenshot of ${p.url()}` },
							{ type: "image", data: base64, mimeType: "image/png" },
						],
						details: undefined,
					};
				}

				case "evaluate": {
					if (!params.js) throw new Error("js is required for evaluate");
					try {
						const result = await p.evaluate(params.js);
						const str = typeof result === "string" ? result : JSON.stringify(result, null, 2);
						return textResult(str ?? "(no return value)");
					} catch (e: unknown) {
						const msg = e instanceof Error ? e.message : String(e);
						throw new Error(`JavaScript error: ${msg}`);
					}
				}

				case "scroll": {
					const dir = params.direction ?? "down";
					const deltaY = dir === "up" ? -500 : 500;
					await p.mouse.wheel(0, deltaY);
					await p.waitForTimeout(300);
					return textResult(`Scrolled ${dir}. Call snapshot to see updated content.`);
				}

				case "back": {
					await p.goBack({ waitUntil: "domcontentloaded", timeout: 10000 });
					return textResult(`Navigated back to ${p.url()}. Call snapshot to see page.`);
				}

				case "forward": {
					await p.goForward({ waitUntil: "domcontentloaded", timeout: 10000 });
					return textResult(`Navigated forward to ${p.url()}. Call snapshot to see page.`);
				}

				default:
					throw new Error(
						`Unknown action: "${action}". Valid: navigate, snapshot, click, type, fill, select, press, screenshot, evaluate, scroll, back, forward, close`,
					);
			}
		},
	};
}

export const browserTool = createBrowserTool();
