#!/usr/bin/env node
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { ConfigError, loadConfig } from "./config.js";
import { createLogger } from "./logger.js";
import { createMcpServer } from "./server.js";
import { SiliconFlowClient } from "./siliconflow.js";
import { TaskStore } from "./tasks.js";

function main(): void {
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

    const client = new SiliconFlowClient({
        apiKey: config.apiKey,
        apiBase: config.apiBase,
        requestTimeoutMs: config.requestTimeoutMs,
        downloadTimeoutMs: config.downloadTimeoutMs,
        maxRetries: config.maxRetries,
        logger
    });
    const store = new TaskStore(config, client, logger);

    logger.info(
        `启动：API 地址 ${config.apiBase}，默认模型 ${config.defaultModel}，图片目录 ${config.outputDir}，最大并发 ${config.maxConcurrency}。`
    );
    if (!config.apiKey) {
        logger.warn("未设置 SILICONFLOW_API_KEY，generate_image 会返回配置错误，直到设置该变量并重启服务。");
    }

    const handle = serveStdio(() => createMcpServer(config, store, logger), {
        onerror: (error) => logger.error("stdio 连接错误", error)
    });

    const shutdown = (reason: string): void => {
        logger.info(`收到 ${reason}，正在关闭。`);
        store.shutdown();
        void handle.close().finally(() => process.exit(0));
    };
    process.once("SIGINT", () => shutdown("SIGINT"));
    process.once("SIGTERM", () => shutdown("SIGTERM"));
    const stopTasks = (): void => {
        store.shutdown();
    };
    process.stdin.once("end", stopTasks);
    process.stdin.once("close", stopTasks);
}

try {
    main();
} catch (error) {
    const logger = createLogger();
    logger.error("服务启动失败", error);
    process.exitCode = 1;
}
