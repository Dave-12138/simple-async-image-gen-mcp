import { McpServer } from "@modelcontextprotocol/server";
import { SERVER_NAME, SERVER_VERSION, type AppConfig } from "./config.js";
import type { Logger } from "./logger.js";
import type { TaskStore } from "./tasks.js";
import { registerImageTools } from "./tools.js";

const INSTRUCTIONS = [
    "本服务通过硅基流动生成图片。",
    "generate_image 提交任务后立即返回 taskId，不会等待图片生成；任务在后台执行。",
    "用 list_image_tasks 查看任务状态，用 get_image_result 获取结果。get_image_result 可以等待任务、只取元数据或只取某张图片。",
    "任务状态保存在当前服务进程内，服务重启后任务列表会清空。"
].join("\n");

export function createMcpServer(config: AppConfig, store: TaskStore, logger: Logger): McpServer {
    const server = new McpServer(
        { name: SERVER_NAME, version: SERVER_VERSION },
        {
            capabilities: { tools: {} },
            instructions: INSTRUCTIONS
        }
    );
    registerImageTools(server, config, store, logger);
    return server;
}
