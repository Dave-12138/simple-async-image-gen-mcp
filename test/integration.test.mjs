import test, { after, before, describe } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

const PNG = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAFgwJ/l8bH3wAAAABJRU5ErkJggg==",
    "base64"
);
const SERVER_PATH = path.resolve("dist/index.js");

function childEnv(overrides) {
    const entries = Object.entries({ ...process.env, ...overrides }).filter(([, value]) => typeof value === "string");
    return Object.fromEntries(entries);
}

async function startFakeApi() {
    const requests = [];
    let port = 0;
    const server = createServer((request, response) => {
        if (request.method === "GET" && request.url.startsWith("/images/")) {
            response.writeHead(200, { "content-type": "image/png" });
            response.end(PNG);
            return;
        }
        if (request.method !== "POST" || request.url !== "/v1/images/generations") {
            response.writeHead(404, { "content-type": "application/json" });
            response.end(JSON.stringify({ message: "not found" }));
            return;
        }

        let raw = "";
        request.setEncoding("utf8");
        request.on("data", (chunk) => {
            raw += chunk;
        });
        request.on("end", () => {
            let body;
            try {
                body = JSON.parse(raw);
            } catch {
                response.writeHead(400, { "content-type": "application/json" });
                response.end(JSON.stringify({ message: "invalid json" }));
                return;
            }
            requests.push({ headers: request.headers, body });

            if (body.prompt.includes("触发失败")) {
                response.writeHead(400, { "content-type": "application/json" });
                response.end(JSON.stringify({ code: 40001, message: "prompt rejected" }));
                return;
            }

            const count = Number.isInteger(body.batch_size) ? body.batch_size : 1;
            setTimeout(() => {
                response.writeHead(200, { "content-type": "application/json" });
                response.end(
                    JSON.stringify({
                        images: Array.from({ length: count }, (_, index) => ({
                            url: `http://127.0.0.1:${port}/images/${requests.length}-${index}.png`
                        })),
                        timings: { inference: 0.42 },
                        seed: 12345
                    })
                );
            }, 1000);
        });
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    port = address.port;
    return { server, requests, port };
}

async function connectClient(env) {
    const client = new Client({ name: "integration-test", version: "1.0.0" });
    const transport = new StdioClientTransport({
        command: process.execPath,
        args: [SERVER_PATH],
        cwd: process.cwd(),
        env,
        stderr: "pipe"
    });
    let stderr = "";
    transport.stderr?.on("data", (chunk) => {
        stderr += chunk.toString();
    });
    try {
        await client.connect(transport);
    } catch (error) {
        throw new Error(`连接测试服务器失败：${error instanceof Error ? error.message : String(error)}\n${stderr}`);
    }
    return { client, transport, stderr: () => stderr };
}

describe("MCP 服务器", { concurrency: false }, () => {
    let api;
    let outputDir;
    let client;
    let transport;
    let stderrText;

    before(async () => {
        api = await startFakeApi();
        outputDir = await mkdtemp(path.join(tmpdir(), "siliconflow-image-gen-mcp-test-"));
        const env = childEnv({
            SILICONFLOW_API_KEY: "test-key",
            SILICONFLOW_API_BASE: `http://127.0.0.1:${api.port}/v1`,
            SILICONFLOW_IMAGE_MODEL: "test/model",
            SILICONFLOW_IMAGE_OUTPUT_DIR: outputDir,
            SILICONFLOW_MAX_CONCURRENCY: "1",
            SILICONFLOW_MAX_RETRIES: "0",
            SILICONFLOW_REQUEST_TIMEOUT_MS: "10000",
            SILICONFLOW_DOWNLOAD_TIMEOUT_MS: "10000"
        });
        ({ client, transport, stderr: stderrText } = await connectClient(env));
    });

    after(async () => {
        await client?.close().catch(() => undefined);
        api?.server.closeAllConnections?.();
        if (api) {
            api.server.close();
            await once(api.server, "close");
        }
        if (outputDir) {
            await rm(outputDir, { recursive: true, force: true });
        }
    });

    test("异步提交、查看进度并取回图片", async () => {
        const tools = await client.listTools();
        assert.deepEqual(
            tools.tools.map((tool) => tool.name).sort(),
            ["generate_image", "get_image_result", "list_image_tasks"]
        );

        const startedAt = performance.now();
        const submitted = await client.callTool({
            name: "generate_image",
            arguments: {
                prompt: "一只坐在窗台上的橘猫，窗边有绿植，午后阳光",
                batchSize: 2,
                imageSize: "1024x1024",
                seed: 42
            }
        });
        const elapsedMs = performance.now() - startedAt;

        assert.equal(submitted.isError, undefined, submitted.content?.[0]?.text);
        assert.ok(elapsedMs < 700, `generate_image 应立即返回，实际耗时 ${elapsedMs.toFixed(1)} 毫秒。`);
        assert.ok(submitted.structuredContent, "generate_image 应返回结构化结果。");
        const taskId = submitted.structuredContent.task.taskId;
        assert.match(taskId, /^img_/);
        assert.ok(["queued", "running", "downloading"].includes(submitted.structuredContent.task.status));
        assert.match(submitted.content[0].text, new RegExp(taskId));

        const listed = await client.callTool({ name: "list_image_tasks", arguments: {} });
        assert.equal(listed.isError, undefined);
        assert.ok(listed.content[0].text.includes(taskId));
        assert.equal(listed.structuredContent.total, 1);
        const listedTask = listed.structuredContent.tasks.find((task) => task.taskId === taskId);
        assert.ok(listedTask);
        assert.ok(["queued", "running"].includes(listedTask.status), `任务应仍在进行中，实际状态为 ${listedTask.status}。`);

        const result = await client.callTool({
            name: "get_image_result",
            arguments: { taskId, waitSeconds: 10 }
        });
        assert.equal(result.isError, undefined, result.content?.[0]?.text);
        const detail = result.structuredContent.task;
        assert.equal(detail.status, "succeeded");
        assert.equal(detail.completed, true);
        assert.equal(detail.images.length, 2);
        assert.equal(detail.providerSeed, 12345);

        const imageBlocks = result.content.filter((block) => block.type === "image");
        assert.equal(imageBlocks.length, 2);
        for (const block of imageBlocks) {
            assert.equal(block.mimeType, "image/png");
            assert.ok(block.data.length > 20);
        }
        for (const image of detail.images) {
            assert.ok(image.filePath, "图片应已保存到本地。");
            assert.equal(image.mimeType, "image/png");
            assert.deepEqual(await readFile(image.filePath), PNG);
        }

        const request = api.requests.find((item) => item.body.prompt.includes("橘猫"));
        assert.ok(request, "应收到图片生成请求。");
        assert.equal(request.headers.authorization, "Bearer test-key");
        assert.equal(request.body.model, "test/model");
        assert.equal(request.body.image_size, "1024x1024");
        assert.equal(request.body.batch_size, 2);
        assert.equal(request.body.seed, 42);

        const metadataOnly = await client.callTool({
            name: "get_image_result",
            arguments: { taskId, includeImages: false }
        });
        assert.equal(metadataOnly.content.filter((block) => block.type === "image").length, 0);
        assert.ok(metadataOnly.content[0].text.includes("includeImages=false"));

        const secondImage = await client.callTool({
            name: "get_image_result",
            arguments: { taskId, imageIndex: 2 }
        });
        assert.equal(secondImage.content.filter((block) => block.type === "image").length, 1);
        assert.equal(secondImage.structuredContent.task.images.length, 1);
        assert.deepEqual(secondImage.structuredContent.task.images[0], detail.images[1]);
    });

    test("接口报错时任务标记为失败", async () => {
        const submitted = await client.callTool({
            name: "generate_image",
            arguments: { prompt: "触发失败的提示词" }
        });
        assert.equal(submitted.isError, undefined, submitted.content?.[0]?.text);
        const taskId = submitted.structuredContent.task.taskId;

        const result = await client.callTool({
            name: "get_image_result",
            arguments: { taskId, waitSeconds: 10 }
        });
        const detail = result.structuredContent.task;
        assert.equal(detail.status, "failed");
        assert.equal(detail.completed, true);
        assert.match(detail.error.message, /prompt rejected/);
        assert.equal(detail.error.code, "40001");
        assert.equal(detail.error.status, 400);
        assert.equal(result.content.filter((block) => block.type === "image").length, 0);
        assert.match(result.content[0].text, /生成失败/);

        const failedOnly = await client.callTool({
            name: "list_image_tasks",
            arguments: { status: "failed" }
        });
        assert.equal(failedOnly.structuredContent.matched, 1);
        assert.ok(failedOnly.structuredContent.tasks.every((task) => task.status === "failed"));
    });
});

test("缺少 API Key 时服务仍可启动，提交任务返回配置错误", async () => {
    const env = childEnv({ SILICONFLOW_IMAGE_OUTPUT_DIR: path.join(tmpdir(), "siliconflow-image-gen-mcp-no-key") });
    delete env.SILICONFLOW_API_KEY;
    const { client } = await connectClient(env);
    try {
        const result = await client.callTool({
            name: "generate_image",
            arguments: { prompt: "测试缺少 API Key" }
        });
        assert.equal(result.isError, true);
        assert.match(result.content[0].text, /SILICONFLOW_API_KEY/);
    } finally {
        await client.close().catch(() => undefined);
    }
});
