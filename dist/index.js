#!/usr/bin/env node
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import os from "node:os";
import path from "node:path";
import { McpServer } from "@modelcontextprotocol/server";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { z } from "zod";
import { randomUUID } from "node:crypto";
// src/config.ts
var SERVER_NAME = "simple-async-image-gen-mcp";
var SERVER_VERSION = "0.1.0";
var ConfigError = class extends Error {
	constructor(message) {
		super(message);
		this.name = "ConfigError";
	}
};
function loadConfig(env = process.env) {
	return {
		apiKey: readString(env, "IMAGE_GEN_API_KEY"),
		apiBase: normalizeApiBase(readString(env, "IMAGE_GEN_API_BASE") ?? "https://api.siliconflow.cn/v1"),
		defaultModel: readString(env, "IMAGE_GEN_MODEL") ?? "Qwen/Qwen-Image",
		outputDir: path.resolve(readString(env, "IMAGE_GEN_OUTPUT_DIR") ?? defaultOutputDir(env)),
		requestTimeoutMs: readInt(env, "IMAGE_GEN_REQUEST_TIMEOUT_MS", 18e4, 1e3, 6e5),
		downloadTimeoutMs: readInt(env, "IMAGE_GEN_DOWNLOAD_TIMEOUT_MS", 12e4, 1e3, 6e5),
		maxRetries: readInt(env, "IMAGE_GEN_MAX_RETRIES", 2, 0, 10),
		maxConcurrency: readInt(env, "IMAGE_GEN_MAX_CONCURRENCY", 2, 1, 16),
		maxTasks: readInt(env, "IMAGE_GEN_MAX_TASKS", 200, 1, 1e4)
	};
}
function defaultOutputDir(env = process.env, platform = process.platform) {
	const home = env.HOME ?? env.USERPROFILE ?? os.homedir();
	if (platform === "win32" && env.LOCALAPPDATA) return path.join(env.LOCALAPPDATA, "simple-async-image-gen-mcp", "images");
	if (env.XDG_CACHE_HOME) return path.join(env.XDG_CACHE_HOME, "simple-async-image-gen-mcp", "images");
	if (platform === "darwin") return path.join(home, "Library", "Caches", "simple-async-image-gen-mcp", "images");
	return path.join(home, ".cache", "simple-async-image-gen-mcp", "images");
}
function readString(env, name) {
	const raw = env[name];
	if (raw === void 0) return;
	const value = raw.trim();
	return value.length > 0 ? value : void 0;
}
function readInt(env, name, fallback, min, max) {
	const raw = readString(env, name);
	if (raw === void 0) return fallback;
	if (!/^\d+$/.test(raw)) throw new ConfigError(`${name} 必须是 ${min} 到 ${max} 之间的整数，当前值为“${raw}”。`);
	const value = Number(raw);
	if (!Number.isSafeInteger(value) || value < min || value > max) throw new ConfigError(`${name} 必须是 ${min} 到 ${max} 之间的整数，当前值为“${raw}”。`);
	return value;
}
function normalizeApiBase(raw) {
	let url;
	try {
		url = new URL(raw);
	} catch {
		throw new ConfigError(`IMAGE_GEN_API_BASE 不是合法的 URL：“${raw}”。`);
	}
	if (url.protocol !== "http:" && url.protocol !== "https:") throw new ConfigError("IMAGE_GEN_API_BASE 只支持 http 或 https 地址。");
	if (url.search.length > 0 || url.hash.length > 0) throw new ConfigError("IMAGE_GEN_API_BASE 不能包含查询参数或片段。");
	url.pathname = url.pathname.replace(/\/+$/, "");
	return url.toString().replace(/\/$/, "");
}
// src/logger.ts
var LOG_PREFIX = "simple-async-image-gen-mcp";
function createLogger(prefix = LOG_PREFIX) {
	const write = (level, message, error) => {
		const suffix = error === void 0 ? "" : ` ${formatError(error)}`;
		process.stderr.write(`[${prefix}] ${level} ${message}${suffix}\n`);
	};
	return {
		info: (message) => write("info", message),
		warn: (message, error) => write("warn", message, error),
		error: (message, error) => write("error", message, error)
	};
}
function formatError(error) {
	if (error instanceof Error) return error.stack ?? error.message;
	return String(error);
}
// src/image-api.ts
var ImageApiError = class extends Error {
	code;
	status;
	retryable;
	retryAfterMs;
	constructor(message, options = {}) {
		super(message);
		this.name = "ImageApiError";
		this.code = options.code;
		this.status = options.status;
		this.retryable = options.retryable ?? false;
		this.retryAfterMs = options.retryAfterMs;
	}
};
var AbortedError = class extends Error {
	constructor(message = "任务已取消。") {
		super(message);
		this.name = "AbortedError";
	}
};
var ImageApiClient = class {
	options;
	constructor(options) {
		this.options = options;
	}
	async generateImage(params, context) {
		const apiKey = this.options.apiKey;
		if (!apiKey) throw new ImageApiError("配置错误：缺少 IMAGE_GEN_API_KEY 环境变量，无法生成图片。请在 MCP 客户端配置中设置该变量后重启服务。");
		const body = {
			model: params.model,
			prompt: params.prompt
		};
		if (params.negativePrompt !== void 0) body.negative_prompt = params.negativePrompt;
		if (params.imageSize !== void 0) body.image_size = params.imageSize;
		if (params.batchSize !== void 0) body.batch_size = params.batchSize;
		if (params.seed !== void 0) body.seed = params.seed;
		if (params.numInferenceSteps !== void 0) body.num_inference_steps = params.numInferenceSteps;
		if (params.guidanceScale !== void 0) body.guidance_scale = params.guidanceScale;
		if (params.outputFormat !== void 0) body.output_format = params.outputFormat;
		return this.withRetries("图片生成请求", this.options.requestTimeoutMs, context, async (signal) => {
			const response = await fetch(endpointFor(this.options.apiBase), {
				method: "POST",
				headers: {
					"content-type": "application/json",
					accept: "application/json",
					authorization: `Bearer ${apiKey}`,
					"user-agent": `${SERVER_NAME}/${SERVER_VERSION}`
				},
				body: JSON.stringify(body),
				signal
			});
			return this.parseGenerationResponse(response);
		});
	}
	async downloadImage(url, destinationDir, index, context) {
		const buffer = await this.withRetries(`下载第 ${index} 张图片`, this.options.downloadTimeoutMs, context, async (signal) => {
			const response = await fetch(url, {
				signal,
				redirect: "follow"
			});
			if (!response.ok) throw makeHttpError(response, await response.text(), `下载第 ${index} 张图片`);
			return Buffer.from(await response.arrayBuffer());
		});
		if (buffer.length === 0) throw new ImageApiError(`下载第 ${index} 张图片失败：服务器返回了空内容。`);
		const type = detectImageType(buffer);
		if (!type) throw new ImageApiError(`下载第 ${index} 张图片失败：返回的内容不是 PNG、JPEG、WebP 或 GIF 图片。`);
		await mkdir(destinationDir, { recursive: true });
		const filePath = path.join(destinationDir, `image-${index}${type.extension}`);
		await writeFile(filePath, buffer);
		return {
			filePath,
			mimeType: type.mimeType,
			bytes: buffer.length
		};
	}
	async parseGenerationResponse(response) {
		const text = await response.text();
		if (!response.ok) throw makeHttpError(response, text, "图片生成请求");
		let payload;
		try {
			payload = JSON.parse(text);
		} catch {
			throw new ImageApiError("图片生成接口返回的内容不是 JSON。", { retryable: true });
		}
		const record = asRecord(payload);
		if (!record) throw new ImageApiError("图片生成接口返回了无法识别的响应。", { retryable: true });
		const rawImages = Array.isArray(record.images) ? record.images : [];
		const imageUrls = [];
		for (const item of rawImages) {
			const image = asRecord(item);
			if (!image || typeof image.url !== "string") continue;
			try {
				const parsed = new URL(image.url);
				if (parsed.protocol === "http:" || parsed.protocol === "https:") imageUrls.push(image.url);
			} catch {}
		}
		if (imageUrls.length === 0) throw new ImageApiError(extractMessage(payload) ?? "图片生成接口没有返回图片。", {
			code: extractCode(payload),
			retryable: false
		});
		const seed = typeof record.seed === "number" ? record.seed : void 0;
		const timings = asRecord(record.timings);
		return {
			imageUrls,
			seed,
			inferenceSeconds: timings && typeof timings.inference === "number" ? timings.inference : void 0
		};
	}
	async withRetries(label, timeoutMs, context, operation) {
		const maxAttempts = this.options.maxRetries + 1;
		let lastError;
		for (let attempt = 1; attempt <= maxAttempts; attempt++) {
			if (context.signal.aborted) throw new AbortedError();
			context.onAttempt?.(attempt);
			try {
				return await runAttempt(label, timeoutMs, context.signal, operation);
			} catch (error) {
				if (error instanceof AbortedError) throw error;
				const normalized = normalizeError(label, error);
				lastError = normalized;
				if (!normalized.retryable || attempt >= maxAttempts) throw normalized;
				const delay = normalized.retryAfterMs ?? backoffDelay(attempt);
				this.options.logger.warn(`${label}失败，第 ${attempt} 次尝试：${normalized.message}；${delay} 毫秒后重试。`);
				await sleep(delay, context.signal);
			}
		}
		throw lastError ?? new ImageApiError(`${label}失败。`);
	}
};
async function runAttempt(label, timeoutMs, outerSignal, operation) {
	const controller = new AbortController();
	let timedOut = false;
	const onAbort = () => controller.abort(outerSignal.reason);
	if (outerSignal.aborted) controller.abort(outerSignal.reason);
	else outerSignal.addEventListener("abort", onAbort, { once: true });
	const timer = setTimeout(() => {
		timedOut = true;
		controller.abort(/* @__PURE__ */ new Error("请求超时"));
	}, timeoutMs);
	try {
		return await operation(controller.signal);
	} catch (error) {
		if (outerSignal.aborted) throw new AbortedError();
		if (timedOut) throw new ImageApiError(`${label}超时（${timeoutMs} 毫秒）。`, { retryable: true });
		throw error;
	} finally {
		clearTimeout(timer);
		outerSignal.removeEventListener("abort", onAbort);
	}
}
function normalizeError(label, error) {
	if (error instanceof ImageApiError) return error;
	if (error instanceof AbortedError) return new ImageApiError(error.message);
	if (error instanceof Error) return new ImageApiError(`${label}失败：${error.message}`, { retryable: true });
	return new ImageApiError(`${label}失败：${String(error)}`, { retryable: true });
}
function endpointFor(apiBase) {
	const base = apiBase.replace(/\/+$/, "");
	return base.endsWith("/images/generations") ? base : `${base}/images/generations`;
}
function makeHttpError(response, text, label) {
	const status = response.status;
	const payload = parseErrorPayload(text);
	let message = `${label}失败：HTTP ${status}${payload.message ? `：${payload.message}` : ""}`;
	if ((status === 401 || status === 403) && label === "图片生成请求") message += "。请检查 IMAGE_GEN_API_KEY 是否正确。";
	else if (status === 404 && label === "图片生成请求") message += "。请检查 IMAGE_GEN_API_BASE 和模型名称。";
	const retryable = status === 408 || status === 425 || status === 429 || status >= 500;
	return new ImageApiError(message, {
		code: payload.code,
		status,
		retryable,
		retryAfterMs: parseRetryAfter(response.headers.get("retry-after"))
	});
}
function parseErrorPayload(text) {
	const trimmed = text.trim();
	if (trimmed.length === 0) return {};
	if (trimmed.startsWith("<")) return { message: "接口返回了 HTML 页面，请检查 API 地址。" };
	try {
		const payload = JSON.parse(trimmed);
		return {
			message: extractMessage(payload),
			code: extractCode(payload)
		};
	} catch {
		return { message: truncate(trimmed.replace(/\s+/g, " "), 300) };
	}
}
function extractMessage(payload) {
	const record = asRecord(payload);
	if (!record) return void 0;
	for (const key of [
		"message",
		"msg",
		"detail"
	]) if (typeof record[key] === "string" && record[key].length > 0) return record[key];
	const error = asRecord(record.error);
	if (error && typeof error.message === "string" && error.message.length > 0) return error.message;
}
function extractCode(payload) {
	const record = asRecord(payload);
	if (!record) return void 0;
	const code = record.code ?? asRecord(record.error)?.code;
	if (typeof code === "string" || typeof code === "number") return String(code);
}
function asRecord(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value) ? value : void 0;
}
function truncate(value, maxLength) {
	return value.length > maxLength ? `${value.slice(0, maxLength)}...` : value;
}
function parseRetryAfter(value) {
	if (!value) return void 0;
	const seconds = Number(value);
	if (!Number.isFinite(seconds) || seconds < 0) return void 0;
	return Math.min(seconds * 1e3, 15e3);
}
function backoffDelay(attempt) {
	return Math.min(1e3 * 2 ** (attempt - 1), 8e3) + Math.floor(Math.random() * 250);
}
function sleep(ms, signal) {
	return new Promise((resolve, reject) => {
		if (signal.aborted) {
			reject(new AbortedError());
			return;
		}
		const onAbort = () => {
			clearTimeout(timer);
			reject(new AbortedError());
		};
		const timer = setTimeout(() => {
			signal.removeEventListener("abort", onAbort);
			resolve();
		}, ms);
		signal.addEventListener("abort", onAbort, { once: true });
	});
}
function detectImageType(buffer) {
	if (buffer.length >= 8 && buffer[0] === 137 && buffer[1] === 80 && buffer[2] === 78 && buffer[3] === 71 && buffer[4] === 13 && buffer[5] === 10 && buffer[6] === 26 && buffer[7] === 10) return {
		mimeType: "image/png",
		extension: ".png"
	};
	if (buffer.length >= 3 && buffer[0] === 255 && buffer[1] === 216 && buffer[2] === 255) return {
		mimeType: "image/jpeg",
		extension: ".jpg"
	};
	const header = buffer.subarray(0, 6).toString("ascii");
	if (header === "GIF87a" || header === "GIF89a") return {
		mimeType: "image/gif",
		extension: ".gif"
	};
	if (buffer.length >= 12 && buffer.subarray(0, 4).toString("ascii") === "RIFF" && buffer.subarray(8, 12).toString("ascii") === "WEBP") return {
		mimeType: "image/webp",
		extension: ".webp"
	};
}
// src/tasks.ts
var TASK_STATUSES = [
	"queued",
	"running",
	"downloading",
	"succeeded",
	"failed"
];
function isTerminalStatus(status) {
	return status === "succeeded" || status === "failed";
}
var TaskStore = class {
	client;
	config;
	logger;
	tasks = /* @__PURE__ */ new Map();
	queue = [];
	controllers = /* @__PURE__ */ new Map();
	running = 0;
	closed = false;
	constructor(config, client, logger) {
		this.config = config;
		this.client = client;
		this.logger = logger;
	}
	create(input) {
		if (this.closed) throw new Error("任务队列已关闭。");
		const id = this.createTaskId();
		const now = Date.now();
		const task = {
			id,
			status: "queued",
			params: { ...input },
			dir: path.join(this.config.outputDir, id),
			createdAt: now,
			updatedAt: now,
			attempts: 0,
			images: [],
			warnings: []
		};
		this.tasks.set(id, task);
		this.queue.push(id);
		this.evictOldTasks();
		queueMicrotask(() => this.pump());
		this.logger.info(`任务 ${id} 已加入队列。`);
		return task;
	}
	get(id) {
		return this.tasks.get(id);
	}
	list(options) {
		const counts = {
			queued: 0,
			running: 0,
			downloading: 0,
			succeeded: 0,
			failed: 0
		};
		const all = [];
		for (const task of this.tasks.values()) {
			counts[task.status]++;
			all.push(task);
		}
		all.sort((left, right) => right.createdAt - left.createdAt);
		const filtered = options.status ? all.filter((task) => task.status === options.status) : all;
		return {
			total: all.length,
			matched: filtered.length,
			counts,
			tasks: filtered.slice(0, options.limit)
		};
	}
	attachDownloadedImage(taskId, imageIndex, downloaded) {
		const task = this.tasks.get(taskId);
		const image = task?.images[imageIndex];
		if (!task || !image) return;
		image.filePath = downloaded.filePath;
		image.mimeType = downloaded.mimeType;
		image.bytes = downloaded.bytes;
		delete image.downloadError;
		task.updatedAt = Date.now();
	}
	shutdown() {
		if (this.closed) return;
		this.closed = true;
		this.queue.length = 0;
		const now = Date.now();
		for (const task of this.tasks.values()) if (task.status === "queued") {
			task.status = "failed";
			task.error = { message: "服务已关闭，任务未执行。" };
			task.completedAt = now;
			task.updatedAt = now;
		}
		for (const controller of this.controllers.values()) controller.abort(new AbortedError("服务已关闭，任务已取消。"));
		this.controllers.clear();
	}
	createTaskId() {
		let id = `img_${Date.now().toString(36)}_${randomUUID().replaceAll("-", "").slice(0, 8)}`;
		while (this.tasks.has(id)) id = `img_${Date.now().toString(36)}_${randomUUID().replaceAll("-", "").slice(0, 8)}`;
		return id;
	}
	pump() {
		if (this.closed) return;
		while (this.running < this.config.maxConcurrency && this.queue.length > 0) {
			const id = this.queue.shift();
			if (!id) break;
			const task = this.tasks.get(id);
			if (!task || task.status !== "queued") continue;
			this.running++;
			this.execute(task).catch((error) => {
				this.logger.error(`任务 ${task.id} 出现未处理错误`, error);
				this.failTask(task, error);
			}).finally(() => {
				this.running--;
				this.pump();
			});
		}
	}
	async execute(task) {
		const controller = new AbortController();
		this.controllers.set(task.id, controller);
		task.status = "running";
		task.startedAt = Date.now();
		task.updatedAt = task.startedAt;
		try {
			const result = await this.client.generateImage(task.params, {
				signal: controller.signal,
				onAttempt: (attempt) => {
					task.attempts = attempt;
					task.updatedAt = Date.now();
				}
			});
			if (controller.signal.aborted) throw new AbortedError();
			task.providerSeed = result.seed;
			task.inferenceSeconds = result.inferenceSeconds;
			task.images = result.imageUrls.map((url) => ({ url }));
			task.status = "downloading";
			task.updatedAt = Date.now();
			for (let index = 0; index < task.images.length; index++) {
				if (controller.signal.aborted) throw new AbortedError();
				const image = task.images[index];
				try {
					const downloaded = await this.client.downloadImage(image.url, task.dir, index + 1, { signal: controller.signal });
					image.filePath = downloaded.filePath;
					image.mimeType = downloaded.mimeType;
					image.bytes = downloaded.bytes;
				} catch (error) {
					if (error instanceof AbortedError || controller.signal.aborted) throw error;
					image.downloadError = errorMessage(error);
					task.warnings.push(`第 ${index + 1} 张图片下载失败：${image.downloadError}`);
					this.logger.warn(`任务 ${task.id} 的第 ${index + 1} 张图片下载失败`, error);
				}
				task.updatedAt = Date.now();
			}
			task.status = "succeeded";
			task.completedAt = Date.now();
			task.updatedAt = task.completedAt;
			this.logger.info(`任务 ${task.id} 完成，耗时 ${task.completedAt - task.createdAt} 毫秒。`);
		} catch (error) {
			if (error instanceof AbortedError || controller.signal.aborted) {
				task.status = "failed";
				task.error = { message: "任务已取消。" };
				task.completedAt = Date.now();
				task.updatedAt = task.completedAt;
				return;
			}
			this.failTask(task, error);
			this.logger.error(`任务 ${task.id} 失败：${errorMessage(error)}`);
		} finally {
			this.controllers.delete(task.id);
		}
	}
	failTask(task, error) {
		task.status = "failed";
		task.error = toTaskError(error);
		task.completedAt = Date.now();
		task.updatedAt = task.completedAt;
	}
	evictOldTasks() {
		if (this.tasks.size <= this.config.maxTasks) return;
		for (const [id, task] of this.tasks) {
			if (this.tasks.size <= this.config.maxTasks) break;
			if (!isTerminalStatus(task.status)) continue;
			this.tasks.delete(id);
			rm(task.dir, {
				recursive: true,
				force: true
			}).catch((error) => {
				this.logger.warn(`清理任务 ${id} 的图片目录失败`, error);
			});
		}
	}
};
function toTaskError(error) {
	if (error instanceof ImageApiError) return {
		message: error.message,
		code: error.code,
		status: error.status,
		retryable: error.retryable
	};
	if (error instanceof Error) return { message: error.message };
	return { message: String(error) };
}
function errorMessage(error) {
	return error instanceof Error ? error.message : String(error);
}
// src/tools.ts
var STATUS_LABELS = {
	queued: "排队中",
	running: "生成中",
	downloading: "下载中",
	succeeded: "已完成",
	failed: "失败"
};
var generateInputSchema = z.object({
	prompt: z.string().trim().min(1, "提示词不能为空。").describe("图片描述。描述越具体，生成结果越符合预期。"),
	model: z.string().trim().min(1).optional().describe("生图模型名称，例如 Qwen/Qwen-Image、black-forest-labs/FLUX.1-schnell、Kwai-Kolors/Kolors。省略时使用 IMAGE_GEN_MODEL，默认 Qwen/Qwen-Image。"),
	negativePrompt: z.string().trim().min(1).optional().describe("反向提示词，描述不希望出现在图片中的内容。"),
	imageSize: z.string().trim().regex(/^\d{2,5}x\d{2,5}$/i, "图片尺寸格式应为 宽x高，例如 1024x1024。").transform((value) => value.toLowerCase()).optional().describe("图片尺寸，格式为 宽x高，例如 1024x1024、768x1024。不同模型支持的尺寸不同，省略时使用模型默认值。"),
	batchSize: z.number().int().min(1).max(4).optional().describe("一次生成的图片数量，取值 1 到 4。部分模型不支持该参数。"),
	seed: z.number().int().min(0).max(9999999999).optional().describe("随机种子，用于复现同一结果。省略时由接口随机生成。"),
	numInferenceSteps: z.number().int().min(1).max(100).optional().describe("推理步数。不同模型和尺寸支持的取值范围不同。"),
	guidanceScale: z.number().min(0).max(20).optional().describe("提示词引导强度。数值越高，结果越贴近提示词。"),
	outputFormat: z.enum(["png", "jpeg"]).optional().describe("输出图片格式。")
});
var listInputSchema = z.object({
	status: z.enum(TASK_STATUSES).optional().describe("只查看该状态的任务。省略时返回全部状态。"),
	limit: z.number().int().min(1).max(200).default(50).describe("最多返回多少个任务，默认 50。")
});
var resultInputSchema = z.object({
	taskId: z.string().trim().min(1).describe("生成图片时返回的任务 ID。"),
	waitSeconds: z.number().int().min(0).max(30).default(0).describe("等待任务完成的最长秒数，默认 0，即立即返回当前状态，最大 30。"),
	includeImages: z.boolean().default(true).describe("是否在结果中返回 base64 图片内容。批量生图或只需要文件路径和链接时设为 false。"),
	imageIndex: z.number().int().min(1).optional().describe("只获取第几张图片，从 1 开始。省略时返回全部图片。")
});
function registerImageTools(server, config, store, logger) {
	server.registerTool("generate_image", {
		title: "异步生成图片",
		description: "提交一个异步生图任务并立即返回 taskId，不会等待图片生成完成。任务在后台调用图片生成接口生成图片，并把图片下载到本地。结构化结果中的 task.taskId 用于后续查询。之后用 list_image_tasks 查看进度，或用 get_image_result 获取图片。任务状态只保存在当前服务进程内，服务重启后清空。",
		inputSchema: generateInputSchema,
		annotations: {
			title: "异步生成图片",
			readOnlyHint: false,
			destructiveHint: false,
			idempotentHint: false,
			openWorldHint: true
		}
	}, async (args) => {
		if (!config.apiKey) return toolError("配置错误：缺少 IMAGE_GEN_API_KEY 环境变量，无法提交生图任务。请在 MCP 客户端配置中设置该变量后重启服务。");
		try {
			const task = store.create({
				model: args.model ?? config.defaultModel,
				prompt: args.prompt,
				negativePrompt: args.negativePrompt,
				imageSize: args.imageSize,
				batchSize: args.batchSize,
				seed: args.seed,
				numInferenceSteps: args.numInferenceSteps,
				guidanceScale: args.guidanceScale,
				outputFormat: args.outputFormat
			});
			return textResult(formatSubmitted(task), { task: summarizeTask(task) });
		} catch (error) {
			return toolError(messageOf(error));
		}
	});
	server.registerTool("list_image_tasks", {
		title: "查看生图任务列表",
		description: "查看当前服务进程内的生图任务进度列表和状态统计。用 generate_image 返回的 taskId 定位任务。状态包括 queued（排队中）、running（生成中）、downloading（下载中）、succeeded（已完成）、failed（失败）。可按状态筛选并限制返回数量。",
		inputSchema: listInputSchema,
		annotations: {
			title: "查看生图任务列表",
			readOnlyHint: true,
			idempotentHint: true,
			openWorldHint: false
		}
	}, async (args) => {
		const result = store.list({
			status: args.status,
			limit: args.limit
		});
		return textResult(formatTaskList(result, args.status), {
			total: result.total,
			matched: result.matched,
			counts: result.counts,
			tasks: result.tasks.map((task) => summarizeTask(task))
		});
	});
	server.registerTool("get_image_result", {
		title: "获取生图结果",
		description: "获取 generate_image 提交的任务结果。任务未完成时返回当前状态；完成后默认返回图片内容、本地文件路径和原始链接；失败时返回错误信息。可用 waitSeconds 等待任务完成，用 includeImages=false 只取元数据和链接，用 imageIndex 只取某张图片。原始链接约 1 小时有效，文件路径在服务所在机器上。任务只保存在当前服务进程内，服务重启后无法获取。",
		inputSchema: resultInputSchema,
		annotations: {
			title: "获取生图结果",
			readOnlyHint: true,
			idempotentHint: true,
			openWorldHint: false
		}
	}, async (args) => {
		const task = await waitForTask(store, args.taskId, args.waitSeconds);
		if (!task) return toolError(`找不到任务 \`${args.taskId}\`。可以先用 \`list_image_tasks\` 查看现有任务。`);
		if (!isTerminalStatus(task.status)) return textResult(formatPending(task, args.waitSeconds), { task: detailOf(task, task.images, task.warnings) });
		if (task.status === "failed") return textResult(formatFailed(task), { task: detailOf(task, task.images, task.warnings) });
		if (args.imageIndex !== void 0 && args.imageIndex > task.images.length) return toolError(`任务 \`${task.id}\` 只有 ${task.images.length} 张图片，无法获取第 ${args.imageIndex} 张。`);
		if (task.images.length === 0) return textResult(`任务 \`${task.id}\` 已完成，但接口没有返回图片。`, { task: detailOf(task, [], task.warnings) });
		const indexes = args.imageIndex === void 0 ? task.images.map((_, index) => index) : [args.imageIndex - 1];
		const warnings = [...task.warnings];
		const imageBlocks = [];
		for (const index of indexes) {
			let image = task.images[index];
			if (args.includeImages && !image.filePath) try {
				const downloaded = await store.client.downloadImage(image.url, task.dir, index + 1, { signal: new AbortController().signal });
				store.attachDownloadedImage(task.id, index, downloaded);
				image = task.images[index];
			} catch (error) {
				const message = `第 ${index + 1} 张图片下载失败：${messageOf(error)}`;
				warnings.push(message);
				logger.warn(`任务 ${task.id} 的${message}`);
			}
			if (!args.includeImages || !image.filePath) continue;
			try {
				const data = await readFile(image.filePath);
				const mimeType = image.mimeType ?? mimeTypeFromPath(image.filePath);
				if (!mimeType) {
					warnings.push(`第 ${index + 1} 张图片的格式无法识别，未返回图片内容。`);
					continue;
				}
				imageBlocks.push({
					type: "image",
					data: data.toString("base64"),
					mimeType
				});
			} catch (error) {
				const message = `读取第 ${index + 1} 张图片失败：${messageOf(error)}`;
				warnings.push(message);
				logger.warn(`任务 ${task.id} 的${message}`);
			}
		}
		const selectedImages = indexes.map((index) => task.images[index]);
		return {
			content: [{
				type: "text",
				text: formatSucceeded(task, selectedImages, warnings, args.includeImages)
			}, ...imageBlocks],
			structuredContent: { task: detailOf(task, selectedImages, warnings) }
		};
	});
}
async function waitForTask(store, taskId, waitSeconds) {
	const deadline = Date.now() + waitSeconds * 1e3;
	let task = store.get(taskId);
	while (task && !isTerminalStatus(task.status) && Date.now() < deadline) {
		await delay(Math.min(250, Math.max(0, deadline - Date.now())));
		task = store.get(taskId);
	}
	return task;
}
function summarizeTask(task) {
	const end = task.completedAt ?? Date.now();
	return {
		taskId: task.id,
		status: task.status,
		model: task.params.model,
		prompt: task.params.prompt,
		imageSize: task.params.imageSize,
		batchSize: task.params.batchSize ?? 1,
		seed: task.params.seed,
		providerSeed: task.providerSeed,
		createdAt: new Date(task.createdAt).toISOString(),
		elapsedMs: Math.max(0, end - task.createdAt),
		attempts: task.attempts,
		imageCount: task.images.length,
		error: task.error?.message
	};
}
function detailOf(task, images, warnings) {
	const end = task.completedAt ?? Date.now();
	return {
		taskId: task.id,
		status: task.status,
		completed: isTerminalStatus(task.status),
		model: task.params.model,
		prompt: task.params.prompt,
		imageSize: task.params.imageSize,
		batchSize: task.params.batchSize ?? 1,
		seed: task.params.seed,
		providerSeed: task.providerSeed,
		inferenceSeconds: task.inferenceSeconds,
		createdAt: new Date(task.createdAt).toISOString(),
		startedAt: task.startedAt === void 0 ? void 0 : new Date(task.startedAt).toISOString(),
		completedAt: task.completedAt === void 0 ? void 0 : new Date(task.completedAt).toISOString(),
		elapsedMs: Math.max(0, end - task.createdAt),
		attempts: task.attempts,
		images: images.map((image) => ({
			url: image.url,
			filePath: image.filePath,
			mimeType: image.mimeType,
			bytes: image.bytes,
			downloadError: image.downloadError
		})),
		error: task.error,
		warnings: warnings.length > 0 ? warnings : void 0
	};
}
function formatSubmitted(task) {
	const lines = [
		"已提交生图任务，当前调用已立即返回。",
		`任务 ID：\`${task.id}\``,
		`状态：${STATUS_LABELS[task.status]}`,
		`模型：\`${task.params.model}\``,
		`提示词：${task.params.prompt}`
	];
	if (task.params.imageSize) lines.push(`图片尺寸：${task.params.imageSize}`);
	if (task.params.batchSize !== void 0 && task.params.batchSize > 1) lines.push(`图片数量：${task.params.batchSize}`);
	lines.push("", "任务在后台执行。使用 `list_image_tasks` 查看进度，完成后使用 `get_image_result` 获取图片。");
	return lines.join("\n");
}
function formatTaskList(result, statusFilter) {
	if (result.total === 0) return "当前没有任务。";
	const counts = TASK_STATUSES.map((status) => `${STATUS_LABELS[status]} ${result.counts[status]}`).join("，");
	const lines = [`任务总数：${result.total}（${counts}）。`];
	if (statusFilter) lines.push(`当前按状态筛选：${STATUS_LABELS[statusFilter]}。`);
	if (result.matched === 0) {
		lines.push("", "没有符合筛选条件的任务。");
		return lines.join("\n");
	}
	lines.push("", "| 任务 ID | 状态 | 模型 | 耗时 | 图片 | 提示词 |", "| --- | --- | --- | --- | --- | --- |");
	for (const task of result.tasks) {
		const end = task.completedAt ?? Date.now();
		const downloaded = task.images.filter((image) => image.filePath).length;
		const imageCell = task.images.length > 0 ? `${downloaded}/${task.images.length}` : "-";
		lines.push(`| \`${task.id}\` | ${STATUS_LABELS[task.status]} | \`${escapeCell(task.params.model)}\` | ${formatDuration(Math.max(0, end - task.createdAt))} | ${imageCell} | ${escapeCell(preview(task.params.prompt))} |`);
	}
	if (result.matched > result.tasks.length) lines.push("", `还有 ${result.matched - result.tasks.length} 个任务未显示，可以调整 limit 或状态筛选。`);
	if (result.counts.failed > 0) lines.push("", "失败原因可以在 `get_image_result` 中查看。");
	return lines.join("\n");
}
function formatPending(task, waitSeconds) {
	const lines = [
		`任务 \`${task.id}\` 尚未完成。`,
		`当前状态：${STATUS_LABELS[task.status]}`,
		`已等待：${formatDuration(Math.max(0, Date.now() - task.createdAt))}`,
		`模型：\`${task.params.model}\``,
		`提示词：${task.params.prompt}`
	];
	if (task.attempts > 1) lines.push(`已尝试：${task.attempts} 次`);
	if (waitSeconds > 0) lines.push("", `本次调用最多等待了 ${waitSeconds} 秒，任务仍未完成。`);
	lines.push("", "可以稍后再次调用 `get_image_result`，或先用 `list_image_tasks` 查看全部任务进度。");
	return lines.join("\n");
}
function formatFailed(task) {
	const error = task.error;
	const lines = [
		`任务 \`${task.id}\` 生成失败。`,
		`模型：\`${task.params.model}\``,
		`提示词：${task.params.prompt}`,
		`错误：${error?.message ?? "未知错误。"}`
	];
	if (task.attempts > 0) lines.push(`已尝试：${task.attempts} 次`);
	const details = [];
	if (error?.code) details.push(`错误码 ${error.code}`);
	if (error?.status) details.push(`HTTP ${error.status}`);
	if (details.length > 0) lines.push(`错误详情：${details.join("，")}`);
	lines.push("", "可以修改提示词、尺寸或模型后重新提交任务。");
	return lines.join("\n");
}
function formatSucceeded(task, images, warnings, includeImages) {
	const lines = [
		`任务 \`${task.id}\` 已完成。`,
		`模型：\`${task.params.model}\``,
		`提示词：${task.params.prompt}`,
		`耗时：${formatDuration(Math.max(0, (task.completedAt ?? Date.now()) - task.createdAt))}`
	];
	if (task.inferenceSeconds !== void 0) lines.push(`模型推理耗时：${task.inferenceSeconds.toFixed(2)} 秒`);
	lines.push("", `图片（${images.length} 张）：`);
	for (let index = 0; index < images.length; index++) {
		const image = images[index];
		lines.push(`${index + 1}. 文件：\`${image.filePath ?? "尚未下载"}\``);
		lines.push(`   链接：${image.url}`);
		if (image.downloadError) lines.push(`   下载错误：${image.downloadError}`);
	}
	lines.push("", includeImages ? "图片内容已随本次结果返回。" : "本次只返回任务信息，未包含图片内容（includeImages=false）。");
	lines.push("图片链接由接口提供，有效期由站点决定。");
	if (warnings.length > 0) {
		lines.push("", "注意：");
		for (const warning of warnings) lines.push(`- ${warning}`);
	}
	return lines.join("\n");
}
function textResult(text, structuredContent) {
	return structuredContent === void 0 ? { content: [{
		type: "text",
		text
	}] } : {
		content: [{
			type: "text",
			text
		}],
		structuredContent
	};
}
function toolError(message) {
	return {
		content: [{
			type: "text",
			text: message
		}],
		isError: true
	};
}
function messageOf(error) {
	return error instanceof Error ? error.message : String(error);
}
function delay(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
function preview(value, maxLength = 48) {
	const singleLine = value.replace(/\s+/g, " ").trim();
	return singleLine.length > maxLength ? `${singleLine.slice(0, maxLength - 1)}…` : singleLine;
}
function escapeCell(value) {
	return value.replace(/\|/g, "\\|").replace(/\r?\n/g, " ").trim();
}
function formatDuration(ms) {
	if (ms < 1e3) return `${Math.round(ms)} 毫秒`;
	if (ms < 6e4) return `${(ms / 1e3).toFixed(1)} 秒`;
	return `${Math.floor(ms / 6e4)} 分 ${Math.round(ms % 6e4 / 1e3)} 秒`;
}
function mimeTypeFromPath(filePath) {
	const lower = filePath.toLowerCase();
	if (lower.endsWith(".png")) return "image/png";
	if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
	if (lower.endsWith(".webp")) return "image/webp";
	if (lower.endsWith(".gif")) return "image/gif";
}
// src/server.ts
var INSTRUCTIONS = [
	"本服务通过兼容 /images/generations 的图片生成接口生成图片。",
	"generate_image 提交任务后立即返回 taskId，不会等待图片生成；任务在后台执行。",
	"用 list_image_tasks 查看任务状态，用 get_image_result 获取结果。get_image_result 可以等待任务、只取元数据或只取某张图片。",
	"任务状态保存在当前服务进程内，服务重启后任务列表会清空。"
].join("\n");
function createMcpServer(config, store, logger) {
	const server = new McpServer({
		name: SERVER_NAME,
		version: SERVER_VERSION
	}, {
		capabilities: { tools: {} },
		instructions: INSTRUCTIONS
	});
	registerImageTools(server, config, store, logger);
	return server;
}
// src/index.ts
function main() {
	const logger = createLogger();
	let config;
	try {
		config = loadConfig();
	} catch (error) {
		if (error instanceof ConfigError) {
			logger.error(`配置错误：${error.message}`);
			process.exitCode = 1;
			return;
		}
		throw error;
	}
	const client = new ImageApiClient({
		apiKey: config.apiKey,
		apiBase: config.apiBase,
		requestTimeoutMs: config.requestTimeoutMs,
		downloadTimeoutMs: config.downloadTimeoutMs,
		maxRetries: config.maxRetries,
		logger
	});
	const store = new TaskStore(config, client, logger);
	logger.info(`启动：API 地址 ${config.apiBase}，默认模型 ${config.defaultModel}，图片目录 ${config.outputDir}，最大并发 ${config.maxConcurrency}。`);
	if (!config.apiKey) logger.warn("未设置 IMAGE_GEN_API_KEY，generate_image 会返回配置错误，直到设置该变量并重启服务。");
	const handle = serveStdio(() => createMcpServer(config, store, logger), { onerror: (error) => logger.error("stdio 连接错误", error) });
	const shutdown = (reason) => {
		logger.info(`收到 ${reason}，正在关闭。`);
		store.shutdown();
		handle.close().finally(() => process.exit(0));
	};
	process.once("SIGINT", () => shutdown("SIGINT"));
	process.once("SIGTERM", () => shutdown("SIGTERM"));
	const stopTasks = () => {
		store.shutdown();
	};
	process.stdin.once("end", stopTasks);
	process.stdin.once("close", stopTasks);
}
try {
	main();
} catch (error) {
	createLogger().error("服务启动失败", error);
	process.exitCode = 1;
}

//# sourceMappingURL=index.js.map