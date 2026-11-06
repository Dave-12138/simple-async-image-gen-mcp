import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import path from "node:path";
import type { AppConfig } from "./config.js";
import type { Logger } from "./logger.js";
import {
    AbortedError,
    ImageApiClient,
    ImageApiError,
    type DownloadedImage,
    type GenerateImageParams
} from "./image-api.js";

export const TASK_STATUSES = ["queued", "running", "downloading", "succeeded", "failed"] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export interface TaskImageState {
    url: string;
    filePath?: string;
    mimeType?: string;
    bytes?: number;
    downloadError?: string;
}

export interface TaskError {
    message: string;
    code?: string;
    status?: number;
    retryable?: boolean;
}

export interface ImageTask {
    id: string;
    status: TaskStatus;
    params: GenerateImageParams;
    dir: string;
    createdAt: number;
    updatedAt: number;
    startedAt?: number;
    completedAt?: number;
    attempts: number;
    providerSeed?: number;
    inferenceSeconds?: number;
    images: TaskImageState[];
    error?: TaskError;
    warnings: string[];
}

export interface TaskListResult {
    total: number;
    matched: number;
    counts: Record<TaskStatus, number>;
    tasks: ImageTask[];
}

export function isTerminalStatus(status: TaskStatus): status is "succeeded" | "failed" {
    return status === "succeeded" || status === "failed";
}

export class TaskStore {
    readonly client: ImageApiClient;

    private readonly config: AppConfig;
    private readonly logger: Logger;
    private readonly tasks = new Map<string, ImageTask>();
    private readonly queue: string[] = [];
    private readonly controllers = new Map<string, AbortController>();
    private running = 0;
    private closed = false;

    constructor(config: AppConfig, client: ImageApiClient, logger: Logger) {
        this.config = config;
        this.client = client;
        this.logger = logger;
    }

    create(input: GenerateImageParams): ImageTask {
        if (this.closed) {
            throw new Error("任务队列已关闭。");
        }

        const id = this.createTaskId();
        const now = Date.now();
        const task: ImageTask = {
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

    get(id: string): ImageTask | undefined {
        return this.tasks.get(id);
    }

    list(options: { status?: TaskStatus; limit: number }): TaskListResult {
        const counts: Record<TaskStatus, number> = {
            queued: 0,
            running: 0,
            downloading: 0,
            succeeded: 0,
            failed: 0
        };
        const all: ImageTask[] = [];
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

    attachDownloadedImage(taskId: string, imageIndex: number, downloaded: DownloadedImage): void {
        const task = this.tasks.get(taskId);
        const image = task?.images[imageIndex];
        if (!task || !image) return;
        image.filePath = downloaded.filePath;
        image.mimeType = downloaded.mimeType;
        image.bytes = downloaded.bytes;
        delete image.downloadError;
        task.updatedAt = Date.now();
    }

    shutdown(): void {
        if (this.closed) return;
        this.closed = true;
        this.queue.length = 0;

        const now = Date.now();
        for (const task of this.tasks.values()) {
            if (task.status === "queued") {
                task.status = "failed";
                task.error = { message: "服务已关闭，任务未执行。" };
                task.completedAt = now;
                task.updatedAt = now;
            }
        }
        for (const controller of this.controllers.values()) {
            controller.abort(new AbortedError("服务已关闭，任务已取消。"));
        }
        this.controllers.clear();
    }

    private createTaskId(): string {
        let id = `img_${Date.now().toString(36)}_${randomUUID().replaceAll("-", "").slice(0, 8)}`;
        while (this.tasks.has(id)) {
            id = `img_${Date.now().toString(36)}_${randomUUID().replaceAll("-", "").slice(0, 8)}`;
        }
        return id;
    }

    private pump(): void {
        if (this.closed) return;
        while (this.running < this.config.maxConcurrency && this.queue.length > 0) {
            const id = this.queue.shift();
            if (!id) break;
            const task = this.tasks.get(id);
            if (!task || task.status !== "queued") continue;

            this.running++;
            void this.execute(task)
                .catch((error: unknown) => {
                    this.logger.error(`任务 ${task.id} 出现未处理错误`, error);
                    this.failTask(task, error);
                })
                .finally(() => {
                    this.running--;
                    this.pump();
                });
        }
    }

    private async execute(task: ImageTask): Promise<void> {
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
                    const downloaded = await this.client.downloadImage(image.url, task.dir, index + 1, {
                        signal: controller.signal
                    });
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

    private failTask(task: ImageTask, error: unknown): void {
        task.status = "failed";
        task.error = toTaskError(error);
        task.completedAt = Date.now();
        task.updatedAt = task.completedAt;
    }

    private evictOldTasks(): void {
        if (this.tasks.size <= this.config.maxTasks) return;
        for (const [id, task] of this.tasks) {
            if (this.tasks.size <= this.config.maxTasks) break;
            if (!isTerminalStatus(task.status)) continue;
            this.tasks.delete(id);
            void rm(task.dir, { recursive: true, force: true }).catch((error: unknown) => {
                this.logger.warn(`清理任务 ${id} 的图片目录失败`, error);
            });
        }
    }
}

function toTaskError(error: unknown): TaskError {
    if (error instanceof ImageApiError) {
        return {
            message: error.message,
            code: error.code,
            status: error.status,
            retryable: error.retryable
        };
    }
    if (error instanceof Error) {
        return { message: error.message };
    }
    return { message: String(error) };
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
