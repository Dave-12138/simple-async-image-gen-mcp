import { readFile } from "node:fs/promises";
import type { CallToolResult, McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import type { AppConfig } from "./config.js";
import type { Logger } from "./logger.js";
import { type ImageTask, type TaskImageState, type TaskListResult, type TaskStatus, type TaskStore, TASK_STATUSES, isTerminalStatus } from "./tasks.js";

const STATUS_LABELS: Record<TaskStatus, string> = {
    queued: "排队中",
    running: "生成中",
    downloading: "下载中",
    succeeded: "已完成",
    failed: "失败"
};

const generateInputSchema = z.object({
    prompt: z.string().trim().min(1, "提示词不能为空。").describe("图片描述。描述越具体，生成结果越符合预期。"),
    model: z
        .string()
        .trim()
        .min(1)
        .optional()
        .describe("生图模型名称，例如 Qwen/Qwen-Image、black-forest-labs/FLUX.1-schnell、Kwai-Kolors/Kolors。省略时使用 SILICONFLOW_IMAGE_MODEL，默认 Qwen/Qwen-Image。"),
    negativePrompt: z.string().trim().min(1).optional().describe("反向提示词，描述不希望出现在图片中的内容。"),
    imageSize: z
        .string()
        .trim()
        .regex(/^\d{2,5}x\d{2,5}$/i, "图片尺寸格式应为 宽x高，例如 1024x1024。")
        .transform((value) => value.toLowerCase())
        .optional()
        .describe("图片尺寸，格式为 宽x高，例如 1024x1024、768x1024。不同模型支持的尺寸不同，省略时使用模型默认值。"),
    batchSize: z.number().int().min(1).max(4).optional().describe("一次生成的图片数量，取值 1 到 4。部分模型不支持该参数。"),
    seed: z.number().int().min(0).max(9_999_999_999).optional().describe("随机种子，用于复现同一结果。省略时由接口随机生成。"),
    numInferenceSteps: z.number().int().min(1).max(100).optional().describe("推理步数。不同模型和尺寸支持的取值范围不同。"),
    guidanceScale: z.number().min(0).max(20).optional().describe("提示词引导强度。数值越高，结果越贴近提示词。"),
    outputFormat: z.enum(["png", "jpeg"]).optional().describe("输出图片格式。")
});

const listInputSchema = z.object({
    status: z.enum(TASK_STATUSES).optional().describe("只查看该状态的任务。省略时返回全部状态。"),
    limit: z.number().int().min(1).max(200).default(50).describe("最多返回多少个任务，默认 50。")
});

const resultInputSchema = z.object({
    taskId: z.string().trim().min(1).describe("生成图片时返回的任务 ID。"),
    waitSeconds: z
        .number()
        .int()
        .min(0)
        .max(30)
        .default(0)
        .describe("等待任务完成的最长秒数，默认 0，即立即返回当前状态，最大 30。"),
    includeImages: z.boolean().default(true).describe("是否在结果中返回 base64 图片内容。批量生图或只需要文件路径和链接时设为 false。"),
    imageIndex: z.number().int().min(1).optional().describe("只获取第几张图片，从 1 开始。省略时返回全部图片。")
});

export function registerImageTools(server: McpServer, config: AppConfig, store: TaskStore, logger: Logger): void {
    server.registerTool(
        "generate_image",
        {
            title: "异步生成图片",
            description:
                "提交一个异步生图任务并立即返回 taskId，不会等待图片生成完成。任务在后台调用硅基流动接口生成图片，并把图片下载到本地。未设置 SILICONFLOW_API_KEY 时返回配置错误。结构化结果中的 task.taskId 用于后续查询。之后用 list_image_tasks 查看进度，或用 get_image_result 获取图片。任务状态只保存在当前服务进程内，服务重启后清空。",
            inputSchema: generateInputSchema,
            annotations: {
                title: "异步生成图片",
                readOnlyHint: false,
                destructiveHint: false,
                idempotentHint: false,
                openWorldHint: true
            }
        },
        async (args) => {
            if (!config.apiKey) {
                return toolError(
                    "未设置 SILICONFLOW_API_KEY 环境变量，无法提交生图任务。请在 MCP 客户端配置中设置该变量后重启服务。"
                );
            }

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
        }
    );

    server.registerTool(
        "list_image_tasks",
        {
            title: "查看生图任务列表",
            description:
                "查看当前服务进程内的生图任务进度列表和状态统计。用 generate_image 返回的 taskId 定位任务。状态包括 queued（排队中）、running（生成中）、downloading（下载中）、succeeded（已完成）、failed（失败）。可按状态筛选并限制返回数量。",
            inputSchema: listInputSchema,
            annotations: {
                title: "查看生图任务列表",
                readOnlyHint: true,
                idempotentHint: true,
                openWorldHint: false
            }
        },
        async (args) => {
            const result = store.list({ status: args.status, limit: args.limit });
            return textResult(formatTaskList(result, args.status), {
                total: result.total,
                matched: result.matched,
                counts: result.counts,
                tasks: result.tasks.map((task) => summarizeTask(task))
            });
        }
    );

    server.registerTool(
        "get_image_result",
        {
            title: "获取生图结果",
            description:
                "获取 generate_image 提交的任务结果。任务未完成时返回当前状态；完成后默认返回图片内容、本地文件路径和原始链接；失败时返回错误信息。可用 waitSeconds 等待任务完成，用 includeImages=false 只取元数据和链接，用 imageIndex 只取某张图片。原始链接约 1 小时有效，文件路径在服务所在机器上。任务只保存在当前服务进程内，服务重启后无法获取。",
            inputSchema: resultInputSchema,
            annotations: {
                title: "获取生图结果",
                readOnlyHint: true,
                idempotentHint: true,
                openWorldHint: false
            }
        },
        async (args) => {
            const task = await waitForTask(store, args.taskId, args.waitSeconds);
            if (!task) {
                return toolError(`找不到任务 \`${args.taskId}\`。可以先用 \`list_image_tasks\` 查看现有任务。`);
            }

            if (!isTerminalStatus(task.status)) {
                return textResult(formatPending(task, args.waitSeconds), {
                    task: detailOf(task, task.images, task.warnings)
                });
            }

            if (task.status === "failed") {
                return textResult(formatFailed(task), { task: detailOf(task, task.images, task.warnings) });
            }

            if (args.imageIndex !== undefined && args.imageIndex > task.images.length) {
                return toolError(
                    `任务 \`${task.id}\` 只有 ${task.images.length} 张图片，无法获取第 ${args.imageIndex} 张。`
                );
            }
            if (task.images.length === 0) {
                return textResult(`任务 \`${task.id}\` 已完成，但接口没有返回图片。`, {
                    task: detailOf(task, [], task.warnings)
                });
            }

            const indexes =
                args.imageIndex === undefined
                    ? task.images.map((_, index) => index)
                    : [args.imageIndex - 1];
            const warnings = [...task.warnings];
            const imageBlocks: Array<{ type: "image"; data: string; mimeType: string }> = [];

            for (const index of indexes) {
                let image = task.images[index];
                if (args.includeImages && !image.filePath) {
                    try {
                        const downloaded = await store.client.downloadImage(
                            image.url,
                            task.dir,
                            index + 1,
                            { signal: new AbortController().signal }
                        );
                        store.attachDownloadedImage(task.id, index, downloaded);
                        image = task.images[index];
                    } catch (error) {
                        const message = `第 ${index + 1} 张图片下载失败：${messageOf(error)}`;
                        warnings.push(message);
                        logger.warn(`任务 ${task.id} 的${message}`);
                    }
                }

                if (!args.includeImages || !image.filePath) continue;
                try {
                    const data = await readFile(image.filePath);
                    const mimeType = image.mimeType ?? mimeTypeFromPath(image.filePath);
                    if (!mimeType) {
                        warnings.push(`第 ${index + 1} 张图片的格式无法识别，未返回图片内容。`);
                        continue;
                    }
                    imageBlocks.push({ type: "image", data: data.toString("base64"), mimeType });
                } catch (error) {
                    const message = `读取第 ${index + 1} 张图片失败：${messageOf(error)}`;
                    warnings.push(message);
                    logger.warn(`任务 ${task.id} 的${message}`);
                }
            }

            const selectedImages = indexes.map((index) => task.images[index]);
            const result: CallToolResult = {
                content: [
                    {
                        type: "text",
                        text: formatSucceeded(task, selectedImages, warnings, args.includeImages)
                    },
                    ...imageBlocks
                ],
                structuredContent: {
                    task: detailOf(task, selectedImages, warnings)
                }
            };
            return result;
        }
    );
}

async function waitForTask(store: TaskStore, taskId: string, waitSeconds: number): Promise<ImageTask | undefined> {
    const deadline = Date.now() + waitSeconds * 1000;
    let task = store.get(taskId);
    while (task && !isTerminalStatus(task.status) && Date.now() < deadline) {
        await delay(Math.min(250, Math.max(0, deadline - Date.now())));
        task = store.get(taskId);
    }
    return task;
}

function summarizeTask(task: ImageTask): Record<string, unknown> {
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

function detailOf(task: ImageTask, images: TaskImageState[], warnings: string[]): Record<string, unknown> {
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
        startedAt: task.startedAt === undefined ? undefined : new Date(task.startedAt).toISOString(),
        completedAt: task.completedAt === undefined ? undefined : new Date(task.completedAt).toISOString(),
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
        warnings: warnings.length > 0 ? warnings : undefined
    };
}

function formatSubmitted(task: ImageTask): string {
    const lines = [
        "已提交生图任务，当前调用已立即返回。",
        `任务 ID：\`${task.id}\``,
        `状态：${STATUS_LABELS[task.status]}`,
        `模型：\`${task.params.model}\``,
        `提示词：${task.params.prompt}`
    ];
    if (task.params.imageSize) lines.push(`图片尺寸：${task.params.imageSize}`);
    if (task.params.batchSize !== undefined && task.params.batchSize > 1) {
        lines.push(`图片数量：${task.params.batchSize}`);
    }
    lines.push("", "任务在后台执行。使用 \`list_image_tasks\` 查看进度，完成后使用 \`get_image_result\` 获取图片。");
    return lines.join("\n");
}

function formatTaskList(result: TaskListResult, statusFilter: TaskStatus | undefined): string {
    if (result.total === 0) {
        return "当前没有任务。";
    }

    const counts = TASK_STATUSES.map((status) => `${STATUS_LABELS[status]} ${result.counts[status]}`).join("，");
    const lines = [`任务总数：${result.total}（${counts}）。`];
    if (statusFilter) {
        lines.push(`当前按状态筛选：${STATUS_LABELS[statusFilter]}。`);
    }

    if (result.matched === 0) {
        lines.push("", "没有符合筛选条件的任务。");
        return lines.join("\n");
    }

    lines.push(
        "",
        "| 任务 ID | 状态 | 模型 | 耗时 | 图片 | 提示词 |",
        "| --- | --- | --- | --- | --- | --- |"
    );
    for (const task of result.tasks) {
        const end = task.completedAt ?? Date.now();
        const downloaded = task.images.filter((image) => image.filePath).length;
        const imageCell = task.images.length > 0 ? `${downloaded}/${task.images.length}` : "-";
        lines.push(
            `| \`${task.id}\` | ${STATUS_LABELS[task.status]} | \`${escapeCell(task.params.model)}\` | ${formatDuration(
                Math.max(0, end - task.createdAt)
            )} | ${imageCell} | ${escapeCell(preview(task.params.prompt))} |`
        );
    }
    if (result.matched > result.tasks.length) {
        lines.push("", `还有 ${result.matched - result.tasks.length} 个任务未显示，可以调整 limit 或状态筛选。`);
    }
    if (result.counts.failed > 0) {
        lines.push("", "失败原因可以在 \`get_image_result\` 中查看。");
    }
    return lines.join("\n");
}

function formatPending(task: ImageTask, waitSeconds: number): string {
    const lines = [
        `任务 \`${task.id}\` 尚未完成。`,
        `当前状态：${STATUS_LABELS[task.status]}`,
        `已等待：${formatDuration(Math.max(0, Date.now() - task.createdAt))}`,
        `模型：\`${task.params.model}\``,
        `提示词：${task.params.prompt}`
    ];
    if (task.attempts > 1) {
        lines.push(`已尝试：${task.attempts} 次`);
    }
    if (waitSeconds > 0) {
        lines.push("", `本次调用最多等待了 ${waitSeconds} 秒，任务仍未完成。`);
    }
    lines.push("", "可以稍后再次调用 \`get_image_result\`，或先用 \`list_image_tasks\` 查看全部任务进度。");
    return lines.join("\n");
}

function formatFailed(task: ImageTask): string {
    const error = task.error;
    const lines = [
        `任务 \`${task.id}\` 生成失败。`,
        `模型：\`${task.params.model}\``,
        `提示词：${task.params.prompt}`,
        `错误：${error?.message ?? "未知错误。"}`
    ];
    if (task.attempts > 0) {
        lines.push(`已尝试：${task.attempts} 次`);
    }
    const details: string[] = [];
    if (error?.code) details.push(`错误码 ${error.code}`);
    if (error?.status) details.push(`HTTP ${error.status}`);
    if (details.length > 0) {
        lines.push(`错误详情：${details.join("，")}`);
    }
    lines.push("", "可以修改提示词、尺寸或模型后重新提交任务。");
    return lines.join("\n");
}

function formatSucceeded(
    task: ImageTask,
    images: TaskImageState[],
    warnings: string[],
    includeImages: boolean
): string {
    const lines = [
        `任务 \`${task.id}\` 已完成。`,
        `模型：\`${task.params.model}\``,
        `提示词：${task.params.prompt}`,
        `耗时：${formatDuration(Math.max(0, (task.completedAt ?? Date.now()) - task.createdAt))}`
    ];
    if (task.inferenceSeconds !== undefined) {
        lines.push(`模型推理耗时：${task.inferenceSeconds.toFixed(2)} 秒`);
    }
    lines.push("", `图片（${images.length} 张）：`);
    for (let index = 0; index < images.length; index++) {
        const image = images[index];
        lines.push(`${index + 1}. 文件：\`${image.filePath ?? "尚未下载"}\``);
        lines.push(`   链接：${image.url}`);
        if (image.downloadError) {
            lines.push(`   下载错误：${image.downloadError}`);
        }
    }
    lines.push(
        "",
        includeImages
            ? "图片内容已随本次结果返回。"
            : "本次只返回任务信息，未包含图片内容（includeImages=false）。"
    );
    lines.push("链接由硅基流动提供，有效期约 1 小时。");
    if (warnings.length > 0) {
        lines.push("", "注意：");
        for (const warning of warnings) lines.push(`- ${warning}`);
    }
    return lines.join("\n");
}

function textResult(text: string, structuredContent?: unknown): CallToolResult {
    return structuredContent === undefined
        ? { content: [{ type: "text", text }] }
        : { content: [{ type: "text", text }], structuredContent };
}

function toolError(message: string): CallToolResult {
    return { content: [{ type: "text", text: message }], isError: true };
}

function messageOf(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

function delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function preview(value: string, maxLength = 48): string {
    const singleLine = value.replace(/\s+/g, " ").trim();
    return singleLine.length > maxLength ? `${singleLine.slice(0, maxLength - 1)}…` : singleLine;
}

function escapeCell(value: string): string {
    return value.replace(/\|/g, "\\|").replace(/\r?\n/g, " ").trim();
}

function formatDuration(ms: number): string {
    if (ms < 1000) return `${Math.round(ms)} 毫秒`;
    if (ms < 60_000) return `${(ms / 1000).toFixed(1)} 秒`;
    return `${Math.floor(ms / 60_000)} 分 ${Math.round((ms % 60_000) / 1000)} 秒`;
}

function mimeTypeFromPath(filePath: string): string | undefined {
    const lower = filePath.toLowerCase();
    if (lower.endsWith(".png")) return "image/png";
    if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
    if (lower.endsWith(".webp")) return "image/webp";
    if (lower.endsWith(".gif")) return "image/gif";
    return undefined;
}
