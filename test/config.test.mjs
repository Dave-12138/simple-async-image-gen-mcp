import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import {
    ConfigError,
    DEFAULT_API_BASE,
    DEFAULT_IMAGE_MODEL,
    defaultOutputDir,
    loadConfig
} from "../src/config.ts";

test("未设置环境变量时使用默认配置", () => {
    const config = loadConfig({ HOME: "/tmp/test-home" });

    assert.equal(config.apiKey, undefined);
    assert.equal(config.apiBase, DEFAULT_API_BASE);
    assert.equal(config.defaultModel, DEFAULT_IMAGE_MODEL);
    assert.equal(config.requestTimeoutMs, 180_000);
    assert.equal(config.downloadTimeoutMs, 120_000);
    assert.equal(config.maxRetries, 2);
    assert.equal(config.maxConcurrency, 2);
    assert.equal(config.maxTasks, 200);
    assert.equal(config.outputDir, path.join("/tmp/test-home", ".cache", "siliconflow-image-gen-mcp", "images"));
});

test("读取自定义配置并规范化 API 地址", () => {
    const config = loadConfig({
        HOME: "/tmp/test-home",
        SILICONFLOW_API_KEY: "  sk-test  ",
        SILICONFLOW_API_BASE: "https://example.com/v1/",
        SILICONFLOW_IMAGE_MODEL: "Qwen/Qwen-Image",
        SILICONFLOW_IMAGE_OUTPUT_DIR: "/tmp/images",
        SILICONFLOW_REQUEST_TIMEOUT_MS: "30000",
        SILICONFLOW_DOWNLOAD_TIMEOUT_MS: "20000",
        SILICONFLOW_MAX_RETRIES: "0",
        SILICONFLOW_MAX_CONCURRENCY: "4",
        SILICONFLOW_MAX_TASKS: "10"
    });

    assert.equal(config.apiKey, "sk-test");
    assert.equal(config.apiBase, "https://example.com/v1");
    assert.equal(config.defaultModel, "Qwen/Qwen-Image");
    assert.equal(config.outputDir, path.resolve("/tmp/images"));
    assert.equal(config.requestTimeoutMs, 30_000);
    assert.equal(config.downloadTimeoutMs, 20_000);
    assert.equal(config.maxRetries, 0);
    assert.equal(config.maxConcurrency, 4);
    assert.equal(config.maxTasks, 10);
});

test("无效的数值配置会抛出 ConfigError", () => {
    assert.throws(
        () => loadConfig({ SILICONFLOW_MAX_CONCURRENCY: "0" }),
        (error) => error instanceof ConfigError && error.message.includes("SILICONFLOW_MAX_CONCURRENCY")
    );
    assert.throws(
        () => loadConfig({ SILICONFLOW_REQUEST_TIMEOUT_MS: "abc" }),
        (error) => error instanceof ConfigError && error.message.includes("SILICONFLOW_REQUEST_TIMEOUT_MS")
    );
});

test("无效的 API 地址会抛出 ConfigError", () => {
    assert.throws(
        () => loadConfig({ SILICONFLOW_API_BASE: "ftp://example.com/v1" }),
        (error) => error instanceof ConfigError && error.message.includes("http")
    );
    assert.throws(
        () => loadConfig({ SILICONFLOW_API_BASE: "not-a-url" }),
        (error) => error instanceof ConfigError
    );
});

test("按平台选择默认图片目录", () => {
    assert.equal(
        defaultOutputDir({ HOME: "/home/me", LOCALAPPDATA: "C:\\Users\\me\\AppData\\Local" }, "win32"),
        path.join("C:\\Users\\me\\AppData\\Local", "siliconflow-image-gen-mcp", "images")
    );
    assert.equal(
        defaultOutputDir({ HOME: "/home/me", XDG_CACHE_HOME: "/var/cache/me" }, "linux"),
        path.join("/var/cache/me", "siliconflow-image-gen-mcp", "images")
    );
    assert.equal(
        defaultOutputDir({ HOME: "/Users/me" }, "darwin"),
        path.join("/Users/me", "Library", "Caches", "siliconflow-image-gen-mcp", "images")
    );
});
