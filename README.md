# siliconflow-image-gen-mcp

通过硅基流动图片生成接口异步生成图片的 MCP 服务器。服务通过 stdio 与 MCP 客户端连接，提交任务后立即返回任务 ID，图片在后台生成并保存到本地。

## 使用

需要 Node.js 20 或更高版本。

通过 npx 启动：

```bash
npx -y github:Dave-12138/siliconflow-image-gen-mcp#dist
```

MCP 客户端配置：

```json
{
  "mcpServers": {
    "siliconflow-image-gen": {
      "command": "npx",
      "args": ["-y", "github:Dave-12138/siliconflow-image-gen-mcp#dist"],
      "env": {
        "SILICONFLOW_API_KEY": "sk-...",
        "SILICONFLOW_IMAGE_MODEL": "Qwen/Qwen-Image"
      }
    }
  }
}
```

`npx` 首次运行会下载仓库和依赖，之后使用本地缓存。

## 环境变量

| 变量 | 必填 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `SILICONFLOW_API_KEY` | 是 | 无 | 硅基流动 API Key。未设置时服务仍可启动，但 `generate_image` 会返回配置错误。 |
| `SILICONFLOW_API_BASE` | 否 | `https://api.siliconflow.cn/v1` | API 根地址，通常以 `/v1` 结尾。国际站可改为 `https://api.siliconflow.com/v1`。 |
| `SILICONFLOW_IMAGE_MODEL` | 否 | `Qwen/Qwen-Image` | 默认生图模型。模型名称需要与 API 平台支持的模型一致。 |
| `SILICONFLOW_IMAGE_OUTPUT_DIR` | 否 | 系统缓存目录 | 图片保存目录。Linux 下默认为 `~/.cache/siliconflow-image-gen-mcp/images`。 |
| `SILICONFLOW_REQUEST_TIMEOUT_MS` | 否 | `180000` | 单次图片生成请求的超时时间，单位毫秒。 |
| `SILICONFLOW_DOWNLOAD_TIMEOUT_MS` | 否 | `120000` | 单张图片下载的超时时间，单位毫秒。 |
| `SILICONFLOW_MAX_RETRIES` | 否 | `2` | 单次请求的最大重试次数，取值 0 到 10。 |
| `SILICONFLOW_MAX_CONCURRENCY` | 否 | `2` | 同时执行的生图任务数量，取值 1 到 16。 |
| `SILICONFLOW_MAX_TASKS` | 否 | `200` | 内存中保留的任务数量上限，取值 1 到 10000。 |

数值变量的值必须是整数，超出范围或格式错误会让服务在启动时退出。API 地址必须是 http 或 https 地址，且不能包含查询参数或片段。

## 工具

### generate_image

提交一个异步生图任务并立即返回 `taskId`，不会等待图片生成完成。任务在后台调用硅基流动接口生成图片，并下载到本地。

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `prompt` | string | 是 | 图片描述。 |
| `model` | string | 否 | 生图模型，省略时使用 `SILICONFLOW_IMAGE_MODEL`。 |
| `negativePrompt` | string | 否 | 反向提示词。 |
| `imageSize` | string | 否 | 图片尺寸，格式为 `宽x高`，例如 `1024x1024`。不同模型支持的尺寸不同。 |
| `batchSize` | integer | 否 | 一次生成的图片数量，取值 1 到 4。部分模型不支持该参数。 |
| `seed` | integer | 否 | 随机种子，用于复现结果。 |
| `numInferenceSteps` | integer | 否 | 推理步数。 |
| `guidanceScale` | number | 否 | 提示词引导强度。 |
| `outputFormat` | string | 否 | 输出格式，可选 `png` 或 `jpeg`。 |

返回文本摘要和结构化字段 `task`，其中 `task.taskId` 用于后续查询。

### list_image_tasks

查看当前服务进程内的任务进度列表和状态统计。用 `generate_image` 返回的 `taskId` 定位任务。

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `status` | string | 否 | 只查看某个状态，可选 `queued`、`running`、`downloading`、`succeeded`、`failed`。 |
| `limit` | integer | 否 | 最多返回多少个任务，默认 50，最大 200。 |

状态含义：

- `queued`：排队中。
- `running`：生成中。
- `downloading`：接口已返回图片，正在下载到本地。
- `succeeded`：已完成。
- `failed`：失败。

### get_image_result

获取 `generate_image` 提交的任务结果。任务未完成时返回当前状态；完成后默认返回图片内容、本地文件路径和原始链接；失败时返回错误信息。

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `taskId` | string | 是 | `generate_image` 返回的 `taskId`。 |
| `waitSeconds` | integer | 否 | 等待任务完成的最长秒数，默认 0，最大 30。 |
| `includeImages` | boolean | 否 | 是否返回 base64 图片内容，默认 `true`。 |
| `imageIndex` | integer | 否 | 只获取第几张图片，从 1 开始。省略时返回全部图片。 |

批量生图时，图片内容以 base64 形式随工具结果返回，结果可能较大。只需要文件路径或链接时把 `includeImages` 设置为 `false`；只需要其中一张图片时设置 `imageIndex`。

## 任务与文件

- 任务保存在当前服务进程的内存中，服务重启后任务列表会清空。
- 图片保存在 `<SILICONFLOW_IMAGE_OUTPUT_DIR>/<taskId>/image-N.png` 之类的路径下。
- 创建新任务后超过 `SILICONFLOW_MAX_TASKS` 时，服务会删除最早完成的任务记录及其图片目录。运行中的任务不会被删除。
- 图片生成成功但下载失败时，任务仍标记为 `succeeded`，结果中保留原始链接和下载错误。再次调用 `get_image_result` 会重试下载。
- 原始链接由硅基流动提供，有效期约 1 小时。

## 故障排查

- `HTTP 401` 或 `HTTP 403`：检查 `SILICONFLOW_API_KEY`。
- `HTTP 404`：检查 `SILICONFLOW_API_BASE` 是否包含正确的 `/v1` 路径，以及模型名称是否受当前平台支持。
- `HTTP 429` 或 `HTTP 5xx`：服务会按退避策略重试。持续失败时降低 `SILICONFLOW_MAX_CONCURRENCY`。
- 客户端没有收到图片：确认输出目录可写；如果使用远程客户端，本地文件路径在客户端机器上不可访问，需要读取工具返回的图片内容。
- 服务日志输出到 stderr，stdout 只用于 MCP 协议消息。

## 开发

### 环境要求

从源码构建需要 Node.js 20.19 或更高版本，或 22.12 及以上（Vite 8 的要求）。GitHub Actions 使用 Node 24。

### 安装与构建

```bash
npm install
npm run build
```

构建会先执行类型检查，再用 Vite 把服务打包成单个 ESM 文件，输出到 `dist/index.js`，并生成 source map。

### 测试

```bash
npm test
```

测试使用本地模拟的硅基流动接口和临时目录，不需要真实 API Key。配置测试通过 tsx 直接导入 `src/config.ts`，端到端测试启动 Vite 打包后的 `dist/index.js`。

### 项目结构

- `src/index.ts`：stdio 入口、启动和关闭处理。
- `src/config.ts`：环境变量解析和默认值。
- `src/siliconflow.ts`：硅基流动接口调用、重试、超时和图片下载。
- `src/tasks.ts`：任务队列、状态和图片文件管理。
- `src/tools.ts`：三个 MCP 工具的定义和结果格式化。
- `src/server.ts`：MCP 服务器组装。
- `test/`：单元测试和端到端测试。
- `vite.config.ts`：Vite 打包配置。
