# siliconflow-image-gen-mcp

## Project

- 通过 stdio 提供 MCP 服务的图片生成工具，调用硅基流动图片生成接口。
- 运行时入口是 `src/index.ts`，构建后入口是 `dist/index.js`。
- 对外提供三个工具：`generate_image`、`list_image_tasks`、`get_image_result`。
- 生成任务在进程内排队执行，生成完成后把图片下载到本地目录。
- 默认生图模型是 `Qwen/Qwen-Image`，可用 `SILICONFLOW_IMAGE_MODEL` 覆盖。
- `.github/workflows/publish-dist.yml` 在推送到 `main` 后构建，并强制推送到孤儿分支 `dist`；`dist` 分支用于 `npx -y github:Dave-12138/siliconflow-image-gen-mcp#dist`。

## Commands

- 安装依赖：`npm install`
- 构建：`npm run build`，先执行 tsc 类型检查，再用 Vite 打包成单个 `dist/index.js`。
- 类型检查：`npm run typecheck`
- 测试：`npm test`，先构建，再用 `node --import tsx` 运行 `test/config.test.mjs` 和 `test/integration.test.mjs`。
- 开发运行：`npm run dev`，先构建再运行 `dist/index.js`。
- 监听构建：`npm run watch`，使用 `vite build --watch` 监听源码变化。
- 运行构建产物：`npm start`
- 只跑一个测试文件：先执行 `npm run build`，再执行 `node --import tsx --test test/integration.test.mjs`。
- 发布 `dist` 分支：推送到 `main` 后自动执行，也可以在 Actions 页面手动触发 `workflow_dispatch`。

## Architecture

- `src/config.ts`：读取环境变量，校验数值和 API 地址，给出默认 API 地址、默认模型和缓存目录。
- `src/siliconflow.ts`：封装图片生成请求、超时、重试、错误解析、图片下载和图片格式识别。
- `src/tasks.ts`：维护内存中的任务 Map、FIFO 队列、并发上限、任务状态和图片目录清理。
- `src/tools.ts`：定义三个工具的 Zod 参数、文本结果和 `structuredContent`，并读取图片文件生成 MCP 图片内容。
- `src/server.ts`：创建 `McpServer` 并注册工具。
- `src/index.ts`：加载配置、创建 `SiliconFlowClient` 和 `TaskStore`，通过 `serveStdio` 提供 stdio 服务。
- `vite.config.ts`：把 `src/index.ts` 打包成单个 ESM 文件，保留 shebang，并把运行依赖和 Node 内置模块标记为外部依赖。
- 配置测试通过 tsx 直接导入 `src/config.ts`；端到端测试通过本地模拟的 HTTP 服务和 MCP 客户端启动真实子进程，不访问硅基流动线上接口。
- `.github/workflows/publish-dist.yml`：安装依赖并构建，生成只含运行依赖的精简 `package.json`，用 `git checkout --orphan dist` 创建孤儿分支，再执行 `git push --force origin dist`。

## Conventions

- stdout 只用于 MCP JSON-RPC 消息；日志一律写 stderr。
- TypeScript 使用 `NodeNext` 模块解析，源码中的相对导入必须带 `.js` 扩展名。
- 任务状态固定为 `queued`、`running`、`downloading`、`succeeded`、`failed`。
- 调用硅基流动接口使用 snake_case 字段；工具参数和结构化结果使用 camelCase。
- 工具返回值同时包含便于阅读的中文文本和 `structuredContent`；图片以 MCP image content 返回。
- 只有调用方显式传入的模型参数才发送给接口，避免给不支持该参数的模型传默认值。
- 面向用户的文本和代码注释使用中文。

## Pitfalls

- Node.js 版本要求 20 或更高；项目使用全局 `fetch`、`AbortController` 和 `randomUUID`。
- 缺少 `SILICONFLOW_API_KEY` 时服务仍会启动，但 `generate_image` 会返回带配置提示的错误。
- 任务记录只保存在当前进程内，服务重启后任务列表清空；已下载图片仍留在输出目录。
- `npm start` 不会自动构建；运行前需要先执行 `npm run build`。
- 默认输出目录在用户缓存目录下，测试必须通过 `SILICONFLOW_IMAGE_OUTPUT_DIR` 指向临时目录。
- 批量生图的图片内容以 base64 返回，结果可能很大；需要小结果时使用 `includeImages=false` 或 `imageIndex`。
- stdio 关闭后服务进程可能延迟数秒退出，测试不要以进程立即退出作为通过条件。
- `npm run build` 使用 Vite 8；从源码构建需要 Node.js 20.19 或更高版本，或 22.12 及以上。
- Vite 依赖 rolldown 的平台原生包，`npm ci` 会在 Linux runner 上安装对应 binding。
- `dist` 分支由 CI 覆盖，不要手工提交；分支保护需要允许强制推送。
- `dist` 分支的 `package.json` 不能包含 `prepack`、`prepare` 或 `devDependencies`，否则 npx 从 git 安装时会尝试构建。

## Maintenance

- 发现新的构建、测试、运行命令或项目约定时，直接更新本文件。
- 本文件只记录当前有效的事实，删除已经不适用的内容。
