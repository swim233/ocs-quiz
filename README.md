# OCS Quiz

给 [OCS 网课助手](https://docs.ocsjs.com/) 用的 AI 题库。部署在 Cloudflare Workers 上，把 OCS 发来的题目转交给大模型作答，再把答案返回给 OCS 自动填写。

- 支持单选、多选、判断、填空，图片题需要使用支持视觉输入的模型
- 兼容所有 OpenAI 格式的接口，例如 OpenAI、DeepSeek、通义千问（阿里云百炼）、硅基流动
- 模型不支持图片或 JSON 输出时，会自动降级重试
- 自带日志页，可以查看每道题的题目、答案、理由、耗时和 token 用量
- Cloudflare 免费套餐足够个人使用

<p align="center">
  <img width="2320" height="1237" alt="image" src="https://github.com/user-attachments/assets/86887f58-da26-4c5b-9604-c13a3138d63b" />
  <br>
  <sub>效果演示</sub>
</p>

## 为什么要自己部署

本项目采用 BYOK（Bring Your Own Key）模式：API Key 由你在 OCS 中填写，每次搜题时随请求一起发送给 Worker，再由 Worker 转发给大模型服务商。服务端不保存 Key，也不写入日志。

因此，**请只使用自己部署的实例**，不要把 Key 填进别人部署的地址。别人的 Worker 能看到你的 Key。

## 使用流程

1. [部署到 Cloudflare](#一部署到-cloudflare)，得到一个域名，例如 `quiz.example.com`
2. [在 OCS 中配置题库](#二在-ocs-中配置题库)，填入域名、访问 Token 和你的大模型 API 信息
3. [放行 OCS 的跨域请求](#三解决-ocs-跨域问题)，否则 OCS 会提示「题库连接失败」

---

## 一、部署到 Cloudflare

### 准备

- 一个 [Cloudflare](https://dash.cloudflare.com/sign-up) 账号，免费套餐即可
- [Node.js](https://nodejs.org/) **22 或更高版本**（Wrangler 的要求）
- 一个托管在 Cloudflare 上的域名。可选，但在中国大陆使用时强烈建议准备，原因见[绑定自定义域名](#绑定自定义域名)

### 步骤

**1. 下载代码并安装依赖**

```bash
git clone https://github.com/swim233/ocs-quiz.git
cd ocs-quiz
npm install
npm --prefix web install   # 日志页前端的依赖，不装会导致部署失败
```

**2. 登录 Cloudflare**

```bash
npx wrangler login
```

浏览器会弹出授权页面，点击允许即可。

**3. 创建 D1 数据库（用于保存日志）**

```bash
npx wrangler d1 create ocs-quiz-db
```

命令会输出一个 `database_id`。打开 `wrangler.toml`，**用它替换掉文件中原有的 `database_id`**：

```toml
[[d1_databases]]
binding = "DB"
database_name = "ocs-quiz-db"
database_id = "这里换成你自己的 database_id"
```

表结构会在第一次写日志时自动创建，不需要手动初始化。

**4. 部署**

```bash
npm run deploy
```

部署成功后会输出 Worker 地址，形如 `https://ocs-quiz.<你的子域>.workers.dev`。

**5. 设置访问 Token（强烈建议）**

```bash
npx wrangler secret put AUTH_TOKEN
```

按提示输入一个足够长的随机字符串，可以用 `openssl rand -hex 16` 生成。设置后立即生效，不需要重新部署。

> [!WARNING]
> 不设置 `AUTH_TOKEN` 时，任何知道地址的人都能查看你的日志页，也能把你的 Worker 当作中转站使用。

**6. 检查部署**

浏览器打开 `https://<你的域名>/api/health`，页面显示 `{"ok":true}` 就说明部署成功。

### 绑定自定义域名

OCS 运行在你自己的浏览器里，所以浏览器必须能访问到 Worker。**`*.workers.dev` 域名在中国大陆通常无法直接访问**，建议绑定自己的域名。该域名需要已托管在 Cloudflare。

以下两种方式任选其一：

- **控制台**：Workers 和 Pages → `ocs-quiz` → 设置（Settings）→ 域和路由（Domains & Routes）→ 添加（Add）→ 自定义域（Custom domain），填入 `quiz.example.com`
- **配置文件**：在 `wrangler.toml` **顶部**（`[assets]` 之前）加上下面的配置，然后重新执行 `npm run deploy`

  ```toml
  routes = [
    { pattern = "quiz.example.com", custom_domain = true }
  ]
  ```

绑定后，后文所有的 `<你的域名>` 都填这个自定义域名。

### 可选配置

以下变量都在 `wrangler.toml` 的 `[vars]` 中，修改后需要重新执行 `npm run deploy`：

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `LLM_TEMPERATURE` | `0` | 模型温度 |
| `LLM_TIMEOUT_MS` | `110000` | 单次模型请求的超时时间（毫秒），见[常见问题](#超时)中的说明 |
| `VISION_ENABLED` | `true` | 是否把题目中的图片发给模型；设为 `false` 时只发送文字 |
| `LOG_ENABLED` | `true` | 是否记录日志；设为 `false` 时不写入 D1 |

如果完全不需要日志，也可以删掉 `wrangler.toml` 中的整个 `[[d1_databases]]` 段，并跳过第 3 步。

### 更新到最新版本

```bash
git pull
npm install && npm --prefix web install
npm run deploy
```

---

## 二、在 OCS 中配置题库

### 1. 获取配置模板

浏览器打开：

```
https://<你的域名>/ocs-config.json
```

页面会返回一段 JSON，其中的地址已经是你的域名。复制它，下一步要修改：

```json
[
  {
    "name": "OCS Quiz (LLM)",
    "homepage": "https://quiz.example.com",
    "url": "https://quiz.example.com/api/search",
    "method": "post",
    "contentType": "json",
    "type": "GM_xmlhttpRequest",
    "headers": {
      "Content-Type": "application/json",
      "Authorization": "Bearer <YOUR_TOKEN>"
    },
    "data": {
      "title": "${title}",
      "options": "${options}",
      "type": "${type}",
      "apiKey": "",
      "baseUrl": "",
      "model": "",
      "thinkEffort": ""
    },
    "handler": "return (res)=> res.code === 0 ? [res.data.question, res.data.answers.join('#')] : [res.msg, undefined]"
  }
]
```

> 在地址后加上 `?token=<你的 AUTH_TOKEN>` 再打开，返回的 JSON 会直接填好 Token。

### 2. 填写你的信息

| 位置 | 填什么 |
| --- | --- |
| `headers.Authorization` | 把 `<YOUR_TOKEN>` 换成部署时设置的 `AUTH_TOKEN`，保留前面的 `Bearer `。没有设置 `AUTH_TOKEN` 时可以删掉这一行 |
| `data.apiKey` | 大模型服务商的 API Key，**必填** |
| `data.baseUrl` | 接口地址，**必填**，见下方说明 |
| `data.model` | 模型名称，**必填**，以服务商文档为准。要做图片题，请选择支持视觉输入的模型 |
| `data.thinkEffort` | 思考强度，可选。会原样作为 `reasoning_effort` 参数发给服务商（如 OpenAI 的 `low` / `medium` / `high`）。**不确定时请留空**，服务商不支持该参数时可能导致请求报错 |

其余字段（`${title}` 等占位符、`handler`）保持原样，不要改。

**`baseUrl` 怎么填？** Worker 会在 `baseUrl` 后面拼上 `/chat/completions` 发起请求，所以只填到 `/chat/completions` 之前的部分，一般以 `/v1` 结尾：

| 服务商 | baseUrl |
| --- | --- |
| OpenAI | `https://api.openai.com/v1` |
| DeepSeek | `https://api.deepseek.com` |
| 阿里云百炼（通义千问） | `https://dashscope.aliyuncs.com/compatible-mode/v1` |
| 硅基流动 | `https://api.siliconflow.cn/v1` |

其他 OpenAI 兼容服务同理，以服务商文档中的 base URL 为准。

### 3. 粘贴到 OCS

打开任意网课页面，在 OCS 悬浮窗中进入 **通用 → 全局设置 → 题库配置**，粘贴改好的 JSON，然后保存。

### 另一种方式：填写订阅链接

OCS 的题库配置也可以直接填一个链接，OCS 会在保存时读取一次。你可以把参数都写进 `/ocs-config.json` 的链接里（参数值需要进行 URL 编码）：

```
https://<你的域名>/ocs-config.json?token=<TOKEN>&apiKey=<KEY>&baseUrl=<URL>&model=<MODEL>
```

这样更省事，但 API Key 和 Token 会以明文出现在链接里，也会留在浏览器历史记录中。介意的话请使用上面粘贴 JSON 的方式。

---

## 三、解决 OCS 跨域问题

题库配置中的 `"type": "GM_xmlhttpRequest"` 表示通过脚本管理器（油猴 Tampermonkey、脚本猫等）发送跨域请求。脚本管理器只允许脚本访问它在 `@connect` 中声明过的域名，而 OCS 标准版的声明里没有你的域名，所以请求会被拦截，OCS 面板上显示为「题库连接失败」。

需要放行的域名是题库配置 `url` 中的域名：绑定了自定义域名就填自定义域名（如 `quiz.example.com`），否则填 `ocs-quiz.<你的子域>.workers.dev`。

以下三种方法任选一种。

### 方法 A：在脚本设置中添加域名白名单（推荐）

1. 点击浏览器右上角的油猴图标 → 管理面板
2. 找到「OCS 网课助手」，点击右侧的编辑按钮
3. 切换到顶部的「设置」标签页，找到「XHR 安全」下的「用户域名白名单」，添加你的域名
4. 保存

这种方法不修改脚本代码，脚本自动更新后依然有效。不同版本油猴中的选项名称可能略有差异；如果找不到该选项，或者使用的是脚本猫，请改用方法 B 或 C。

### 方法 B：修改脚本头部的 `@connect`

1. 同上，进入「OCS 网课助手」的代码编辑界面
2. 在开头 `// ==UserScript==` 和 `// ==/UserScript==` 之间的任意位置，加一行：

   ```js
   // @connect quiz.example.com
   ```

3. 按 `Ctrl + S` 保存

注意：OCS 脚本自动更新后，这行修改会被覆盖，需要重新添加。

### 方法 C：安装 OCS 全域名通用版

OCS 官方提供一个 `@connect` 中带 `*` 通配符的版本，可以请求任意域名：

- GreasyFork：<https://greasyfork.org/zh-CN/scripts/481438>
- 脚本猫：<https://scriptcat.org/zh-CN/script-show-page/1398>

安装后，第一次搜题时脚本管理器会弹窗，询问是否允许访问你的域名，选择「总是允许」即可。

---

## 日志页

浏览器打开 `https://<你的域名>/`，输入 `AUTH_TOKEN` 登录，就能看到最近的答题记录，包括题目、选项、图片、模型给出的答案与理由、耗时、token 用量和请求方 IP。日志页支持按状态筛选、全文搜索，默认每 3 秒自动刷新。

日志中不包含 API Key。

---

## 常见问题

### OCS 显示「题库连接失败」

OCS 只要收到的不是 HTTP 200 响应，都会显示这个提示，且不会显示具体原因。按以下顺序排查：

1. **跨域没有放行**：见[第三节](#三解决-ocs-跨域问题)。如果之前在弹窗中误点了禁止，请到脚本设置中把域名从黑名单里移除
2. **域名无法访问**：浏览器直接打开 `https://<你的域名>/api/health`，看能否返回 `{"ok":true}`。在中国大陆打不开 `workers.dev` 时，请[绑定自定义域名](#绑定自定义域名)
3. **Token 错误**：检查 `Authorization` 是否为 `Bearer <你的 AUTH_TOKEN>`，是否漏改了 `<YOUR_TOKEN>` 占位符
4. **超时**：见下一条

其他错误（如缺少参数、API Key 无效、模型报错）都会以文字形式显示在 OCS 面板上，按提示修改即可。

### 超时

较新版本的 OCS 可以在高级设置中调整「搜题最大耗时」（默认 120 秒）。Worker 默认的模型超时时间为 110 秒，比 OCS 的限制略短，这样超时后 OCS 面板能显示具体原因。

旧版 OCS（4.11.8 之前）固定 30 秒超时。请升级 OCS，或把 `wrangler.toml` 中的 `LLM_TIMEOUT_MS` 改为 `25000` 左右后重新部署。

使用推理模型时，如果经常超时，可以把 `thinkEffort` 调低，或者换用非推理模型。

### 图片题答不出来

图片题需要选择支持视觉输入的模型。如果模型不支持图片，Worker 会自动改为只发送文字，此时模型看不到图片，答案可能不准确。

### 用命令行测试 Worker

下面的命令可以绕过 OCS，直接测试 Worker 和 API Key 是否正常，方便判断问题出在 Worker 一侧还是 OCS/跨域一侧：

```bash
curl -X POST https://<你的域名>/api/search \
  -H 'Content-Type: application/json' \
  -H 'Authorization: Bearer <你的 AUTH_TOKEN>' \
  -d '{
    "title": "1+1=?",
    "options": "1\n2\n3",
    "type": "single",
    "apiKey": "<你的 API Key>",
    "baseUrl": "https://api.deepseek.com",
    "model": "<模型名称>"
  }'
```

正常时会返回类似下面的结果：

```json
{
  "code": 0,
  "data": {
    "question": "1+1=?",
    "answers": ["2"],
    "reason": "1+1 等于 2",
    "model": "<模型名称>",
    "latency_ms": 1234,
    "usage": { "prompt_tokens": 120, "completion_tokens": 30, "cached_tokens": 0 }
  }
}
```

失败时返回 `{"code": 1, "msg": "错误原因"}`。

---

## 本地开发

```bash
# .dev.vars（已加入 .gitignore）
AUTH_TOKEN=dev-token
```

```bash
npm run build:web          # 构建日志页前端，修改前端后需要重新构建
npm run dev                # 启动 Worker：http://localhost:8790
node scripts/stub-llm.mjs  # 可选：启动一个假的大模型服务，baseUrl 填 http://localhost:8788/v1
```

## 许可证

[MIT](LICENSE)

## 免责声明

本项目仅供学习和技术交流使用。使用者需自行遵守所在学校、课程平台和大模型服务商的相关规定，因使用本项目产生的一切后果由使用者自行承担。
