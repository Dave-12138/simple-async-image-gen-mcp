import os from "node:os";
import path from "node:path";

export const SERVER_NAME = "siliconflow-image-gen-mcp";
export const SERVER_VERSION = "0.1.0";
export const DEFAULT_API_BASE = "https://api.siliconflow.cn/v1";
export const DEFAULT_IMAGE_MODEL = "Qwen/Qwen-Image";

export interface AppConfig {
    /** 硅基流动 API Key；未设置时服务可以启动，但提交任务会报错。 */
    apiKey?: string;
    /** 硅基流动 API 根地址，末尾不带斜杠。 */
    apiBase: string;
    /** 调用生图接口时使用的默认模型。 */
    defaultModel: string;
    /** 下载后的图片保存目录。 */
    outputDir: string;
    /** 单次图片生成请求的超时时间。 */
    requestTimeoutMs: number;
    /** 单张图片下载的超时时间。 */
    downloadTimeoutMs: number;
    /** 生成请求和下载请求的最大重试次数。 */
    maxRetries: number;
    /** 同时执行的生图任务数量。 */
    maxConcurrency: number;
    /** 内存中保留的任务数量上限。 */
    maxTasks: number;
}

export class ConfigError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "ConfigError";
    }
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
    return {
        apiKey: readString(env, "SILICONFLOW_API_KEY"),
        apiBase: normalizeApiBase(readString(env, "SILICONFLOW_API_BASE") ?? DEFAULT_API_BASE),
        defaultModel: readString(env, "SILICONFLOW_IMAGE_MODEL") ?? DEFAULT_IMAGE_MODEL,
        outputDir: path.resolve(readString(env, "SILICONFLOW_IMAGE_OUTPUT_DIR") ?? defaultOutputDir(env)),
        requestTimeoutMs: readInt(env, "SILICONFLOW_REQUEST_TIMEOUT_MS", 180_000, 1_000, 600_000),
        downloadTimeoutMs: readInt(env, "SILICONFLOW_DOWNLOAD_TIMEOUT_MS", 120_000, 1_000, 600_000),
        maxRetries: readInt(env, "SILICONFLOW_MAX_RETRIES", 2, 0, 10),
        maxConcurrency: readInt(env, "SILICONFLOW_MAX_CONCURRENCY", 2, 1, 16),
        maxTasks: readInt(env, "SILICONFLOW_MAX_TASKS", 200, 1, 10_000)
    };
}

export function defaultOutputDir(env: NodeJS.ProcessEnv = process.env, platform = process.platform): string {
    const home = env.HOME ?? env.USERPROFILE ?? os.homedir();
    if (platform === "win32" && env.LOCALAPPDATA) {
        return path.join(env.LOCALAPPDATA, "siliconflow-image-gen-mcp", "images");
    }
    if (env.XDG_CACHE_HOME) {
        return path.join(env.XDG_CACHE_HOME, "siliconflow-image-gen-mcp", "images");
    }
    if (platform === "darwin") {
        return path.join(home, "Library", "Caches", "siliconflow-image-gen-mcp", "images");
    }
    return path.join(home, ".cache", "siliconflow-image-gen-mcp", "images");
}

function readString(env: NodeJS.ProcessEnv, name: string): string | undefined {
    const raw = env[name];
    if (raw === undefined) {
        return undefined;
    }
    const value = raw.trim();
    return value.length > 0 ? value : undefined;
}

function readInt(env: NodeJS.ProcessEnv, name: string, fallback: number, min: number, max: number): number {
    const raw = readString(env, name);
    if (raw === undefined) {
        return fallback;
    }
    if (!/^\d+$/.test(raw)) {
        throw new ConfigError(`${name} 必须是 ${min} 到 ${max} 之间的整数，当前值为“${raw}”。`);
    }
    const value = Number(raw);
    if (!Number.isSafeInteger(value) || value < min || value > max) {
        throw new ConfigError(`${name} 必须是 ${min} 到 ${max} 之间的整数，当前值为“${raw}”。`);
    }
    return value;
}

function normalizeApiBase(raw: string): string {
    let url: URL;
    try {
        url = new URL(raw);
    } catch {
        throw new ConfigError(`SILICONFLOW_API_BASE 不是合法的 URL：“${raw}”。`);
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") {
        throw new ConfigError("SILICONFLOW_API_BASE 只支持 http 或 https 地址。");
    }
    if (url.search.length > 0 || url.hash.length > 0) {
        throw new ConfigError("SILICONFLOW_API_BASE 不能包含查询参数或片段。");
    }
    url.pathname = url.pathname.replace(/\/+$/, "");
    return url.toString().replace(/\/$/, "");
}
