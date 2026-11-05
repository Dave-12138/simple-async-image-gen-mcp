import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { SERVER_NAME, SERVER_VERSION } from "./config.js";
import type { Logger } from "./logger.js";

export interface GenerateImageParams {
    model: string;
    prompt: string;
    negativePrompt?: string;
    imageSize?: string;
    batchSize?: number;
    seed?: number;
    numInferenceSteps?: number;
    guidanceScale?: number;
    outputFormat?: "png" | "jpeg";
}

export interface GenerateImageResult {
    imageUrls: string[];
    seed?: number;
    inferenceSeconds?: number;
}

export interface DownloadedImage {
    filePath: string;
    mimeType: string;
    bytes: number;
}

export interface RequestContext {
    signal: AbortSignal;
    onAttempt?: (attempt: number) => void;
}

export interface SiliconFlowClientOptions {
    apiKey?: string;
    apiBase: string;
    requestTimeoutMs: number;
    downloadTimeoutMs: number;
    maxRetries: number;
    logger: Logger;
}

interface SiliconFlowErrorOptions {
    code?: string;
    status?: number;
    retryable?: boolean;
    retryAfterMs?: number;
}

export class SiliconFlowError extends Error {
    readonly code?: string;
    readonly status?: number;
    readonly retryable: boolean;
    readonly retryAfterMs?: number;

    constructor(message: string, options: SiliconFlowErrorOptions = {}) {
        super(message);
        this.name = "SiliconFlowError";
        this.code = options.code;
        this.status = options.status;
        this.retryable = options.retryable ?? false;
        this.retryAfterMs = options.retryAfterMs;
    }
}

export class AbortedError extends Error {
    constructor(message = "任务已取消。") {
        super(message);
        this.name = "AbortedError";
    }
}

export class SiliconFlowClient {
    private readonly options: SiliconFlowClientOptions;

    constructor(options: SiliconFlowClientOptions) {
        this.options = options;
    }

    async generateImage(params: GenerateImageParams, context: RequestContext): Promise<GenerateImageResult> {
        const apiKey = this.options.apiKey;
        if (!apiKey) {
            throw new SiliconFlowError(
                "未设置 SILICONFLOW_API_KEY 环境变量，无法提交生图任务。请在 MCP 客户端配置中设置该变量。"
            );
        }

        const body: Record<string, unknown> = {
            model: params.model,
            prompt: params.prompt
        };
        if (params.negativePrompt !== undefined) body.negative_prompt = params.negativePrompt;
        if (params.imageSize !== undefined) body.image_size = params.imageSize;
        if (params.batchSize !== undefined) body.batch_size = params.batchSize;
        if (params.seed !== undefined) body.seed = params.seed;
        if (params.numInferenceSteps !== undefined) body.num_inference_steps = params.numInferenceSteps;
        if (params.guidanceScale !== undefined) body.guidance_scale = params.guidanceScale;
        if (params.outputFormat !== undefined) body.output_format = params.outputFormat;

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

    async downloadImage(
        url: string,
        destinationDir: string,
        index: number,
        context: RequestContext
    ): Promise<DownloadedImage> {
        const buffer = await this.withRetries(
            `下载第 ${index} 张图片`,
            this.options.downloadTimeoutMs,
            context,
            async (signal) => {
                const response = await fetch(url, { signal, redirect: "follow" });
                if (!response.ok) {
                    const text = await response.text();
                    throw makeHttpError(response, text, `下载第 ${index} 张图片`);
                }
                return Buffer.from(await response.arrayBuffer());
            }
        );

        if (buffer.length === 0) {
            throw new SiliconFlowError(`下载第 ${index} 张图片失败：服务器返回了空内容。`);
        }
        const type = detectImageType(buffer);
        if (!type) {
            throw new SiliconFlowError(`下载第 ${index} 张图片失败：返回的内容不是 PNG、JPEG、WebP 或 GIF 图片。`);
        }

        await mkdir(destinationDir, { recursive: true });
        const filePath = path.join(destinationDir, `image-${index}${type.extension}`);
        await writeFile(filePath, buffer);
        return { filePath, mimeType: type.mimeType, bytes: buffer.length };
    }

    private async parseGenerationResponse(response: Response): Promise<GenerateImageResult> {
        const text = await response.text();
        if (!response.ok) {
            throw makeHttpError(response, text, "图片生成请求");
        }

        let payload: unknown;
        try {
            payload = JSON.parse(text);
        } catch {
            throw new SiliconFlowError("图片生成接口返回的内容不是 JSON。", { retryable: true });
        }
        const record = asRecord(payload);
        if (!record) {
            throw new SiliconFlowError("图片生成接口返回了无法识别的响应。", { retryable: true });
        }

        const rawImages = Array.isArray(record.images) ? record.images : [];
        const imageUrls: string[] = [];
        for (const item of rawImages) {
            const image = asRecord(item);
            if (!image || typeof image.url !== "string") continue;
            try {
                const parsed = new URL(image.url);
                if (parsed.protocol === "http:" || parsed.protocol === "https:") {
                    imageUrls.push(image.url);
                }
            } catch {
                // 忽略无效地址，下面统一报错。
            }
        }
        if (imageUrls.length === 0) {
            const message = extractMessage(payload) ?? "图片生成接口没有返回图片。";
            throw new SiliconFlowError(message, {
                code: extractCode(payload),
                retryable: false
            });
        }

        const seed = typeof record.seed === "number" ? record.seed : undefined;
        const timings = asRecord(record.timings);
        const inferenceSeconds = timings && typeof timings.inference === "number" ? timings.inference : undefined;
        return { imageUrls, seed, inferenceSeconds };
    }

    private async withRetries<T>(
        label: string,
        timeoutMs: number,
        context: RequestContext,
        operation: (signal: AbortSignal) => Promise<T>
    ): Promise<T> {
        const maxAttempts = this.options.maxRetries + 1;
        let lastError: SiliconFlowError | undefined;

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
                this.options.logger.warn(
                    `${label}失败，第 ${attempt} 次尝试：${normalized.message}；${delay} 毫秒后重试。`
                );
                await sleep(delay, context.signal);
            }
        }

        throw lastError ?? new SiliconFlowError(`${label}失败。`);
    }
}

async function runAttempt<T>(
    label: string,
    timeoutMs: number,
    outerSignal: AbortSignal,
    operation: (signal: AbortSignal) => Promise<T>
): Promise<T> {
    const controller = new AbortController();
    let timedOut = false;
    const onAbort = (): void => controller.abort(outerSignal.reason);

    if (outerSignal.aborted) {
        controller.abort(outerSignal.reason);
    } else {
        outerSignal.addEventListener("abort", onAbort, { once: true });
    }
    const timer = setTimeout(() => {
        timedOut = true;
        controller.abort(new Error("请求超时"));
    }, timeoutMs);

    try {
        return await operation(controller.signal);
    } catch (error) {
        if (outerSignal.aborted) throw new AbortedError();
        if (timedOut) {
            throw new SiliconFlowError(`${label}超时（${timeoutMs} 毫秒）。`, { retryable: true });
        }
        throw error;
    } finally {
        clearTimeout(timer);
        outerSignal.removeEventListener("abort", onAbort);
    }
}

function normalizeError(label: string, error: unknown): SiliconFlowError {
    if (error instanceof SiliconFlowError) {
        return error;
    }
    if (error instanceof AbortedError) {
        return new SiliconFlowError(error.message);
    }
    if (error instanceof Error) {
        return new SiliconFlowError(`${label}失败：${error.message}`, { retryable: true });
    }
    return new SiliconFlowError(`${label}失败：${String(error)}`, { retryable: true });
}

function endpointFor(apiBase: string): string {
    const base = apiBase.replace(/\/+$/, "");
    return base.endsWith("/images/generations") ? base : `${base}/images/generations`;
}

function makeHttpError(response: Response, text: string, label: string): SiliconFlowError {
    const status = response.status;
    const payload = parseErrorPayload(text);
    const detail = payload.message ? `：${payload.message}` : "";
    let message = `${label}失败：HTTP ${status}${detail}`;
    if ((status === 401 || status === 403) && label === "图片生成请求") {
        message += "。请检查 SILICONFLOW_API_KEY 是否正确。";
    } else if (status === 404 && label === "图片生成请求") {
        message += "。请检查 SILICONFLOW_API_BASE 和模型名称。";
    }

    const retryable = status === 408 || status === 425 || status === 429 || status >= 500;
    return new SiliconFlowError(message, {
        code: payload.code,
        status,
        retryable,
        retryAfterMs: parseRetryAfter(response.headers.get("retry-after"))
    });
}

function parseErrorPayload(text: string): { message?: string; code?: string } {
    const trimmed = text.trim();
    if (trimmed.length === 0) {
        return {};
    }
    if (trimmed.startsWith("<")) {
        return { message: "接口返回了 HTML 页面，请检查 API 地址。" };
    }
    try {
        const payload: unknown = JSON.parse(trimmed);
        return { message: extractMessage(payload), code: extractCode(payload) };
    } catch {
        return { message: truncate(trimmed.replace(/\s+/g, " "), 300) };
    }
}

function extractMessage(payload: unknown): string | undefined {
    const record = asRecord(payload);
    if (!record) return undefined;
    for (const key of ["message", "msg", "detail"]) {
        if (typeof record[key] === "string" && record[key].length > 0) {
            return record[key];
        }
    }
    const error = asRecord(record.error);
    if (error && typeof error.message === "string" && error.message.length > 0) {
        return error.message;
    }
    return undefined;
}

function extractCode(payload: unknown): string | undefined {
    const record = asRecord(payload);
    if (!record) return undefined;
    const code = record.code ?? asRecord(record.error)?.code;
    if (typeof code === "string" || typeof code === "number") {
        return String(code);
    }
    return undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
    return typeof value === "object" && value !== null && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : undefined;
}

function truncate(value: string, maxLength: number): string {
    return value.length > maxLength ? `${value.slice(0, maxLength)}...` : value;
}

function parseRetryAfter(value: string | null): number | undefined {
    if (!value) return undefined;
    const seconds = Number(value);
    if (!Number.isFinite(seconds) || seconds < 0) return undefined;
    return Math.min(seconds * 1000, 15_000);
}

function backoffDelay(attempt: number): number {
    return Math.min(1000 * 2 ** (attempt - 1), 8000) + Math.floor(Math.random() * 250);
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
        if (signal.aborted) {
            reject(new AbortedError());
            return;
        }
        const onAbort = (): void => {
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

function detectImageType(buffer: Buffer): { mimeType: string; extension: string } | undefined {
    if (
        buffer.length >= 8 &&
        buffer[0] === 0x89 &&
        buffer[1] === 0x50 &&
        buffer[2] === 0x4e &&
        buffer[3] === 0x47 &&
        buffer[4] === 0x0d &&
        buffer[5] === 0x0a &&
        buffer[6] === 0x1a &&
        buffer[7] === 0x0a
    ) {
        return { mimeType: "image/png", extension: ".png" };
    }
    if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
        return { mimeType: "image/jpeg", extension: ".jpg" };
    }
    const header = buffer.subarray(0, 6).toString("ascii");
    if (header === "GIF87a" || header === "GIF89a") {
        return { mimeType: "image/gif", extension: ".gif" };
    }
    if (
        buffer.length >= 12 &&
        buffer.subarray(0, 4).toString("ascii") === "RIFF" &&
        buffer.subarray(8, 12).toString("ascii") === "WEBP"
    ) {
        return { mimeType: "image/webp", extension: ".webp" };
    }
    return undefined;
}
