# ESA CORS 反向代理网关

一个部署在**阿里云 ESA Pages** 边缘节点上的通用 CORS 反向代理网关。可将任意外部资源（图片、视频、文件等）通过你的域名转发，自动解决跨域（`Access-Control-Allow-Origin: *`）与防盗链（自动伪装 Referer/Origin）问题。

> 本项目由腾讯云 EdgeOne Pages 迁移而来，核心代理逻辑完全保留，仅适配了 ESA 的边缘函数运行时 API。

## 功能特性

- **CORS 全开放**：对浏览器暴露 `Access-Control-Allow-Origin: *`，支持任意来源跨域读取。
- **智能防盗链重试**：先以「Clean 模式」直连；若上游返回 401/403/404/451（疑似防盗链），自动切换到「Disguise 模式」伪装成目标源自身再试一次。
- **伪装域名模式**：请求路径可写入自定义伪装域名，强制使用该域名的 Referer/Origin（应对更严格的防盗链）。
- **301/302 重定向改写**：上游重定向的 `Location` 会被改写为经过本代理的地址，对外隐藏真实目标。
- **调试响应头**：每个响应携带 `X-Debug-*` 头，方便排查走了哪条路径、用了什么 Referer/UA。
- **无构建依赖**：纯边缘函数 + 静态资源，无需 `npm install`，零运行时依赖。

## 目录结构

```
.
├── esa.jsonc              # ESA Pages 构建/路由配置（入口、静态目录、跳过构建）
├── package.json           # 占位配置，build 为无操作（仅用于让 ESA 构建通过）
├── src/
│   └── proxy.js           # 核心边缘函数（catch-all 反向代理）
├── public/
│   ├── index.html         # 前端测试页（含代理用法示例）
│   ├── favicon.ico
│   └── favicon.svg
├── edgeone.config.json.bak   # 迁移前 EdgeOne 配置（留作回退，不参与部署）
└── functions.edgeone.bak/     # 迁移前 EdgeOne 函数（留作回退，不参与部署）
```

> `.bak` 后缀的文件不会被 ESA 加载，仅用于从历史版本回退参考。

## 使用方式

代理地址格式：

```
https://你的域名/https://目标URL
```

- **模式一（直连）**：`https://你的域名/https://example.com/image.jpg`
  代理会直接请求 `https://example.com/image.jpg` 并转发。
- **模式二（伪装域名）**：`https://你的域名/伪装域名/https://目标URL`
  例如 `https://你的域名/img.example.com/https://example.com/a.jpg`，
  代理会以 `img.example.com` 作为 Referer/Origin 去请求目标，突破更严格的防盗链。

请求方法支持 `GET` / `HEAD` / `POST`（POST 透传请求体），`OPTIONS` 预检直接放行。

## 调试

每个响应都带有以下调试头，可在浏览器开发者工具「网络」面板查看：

| 响应头 | 含义 |
|---|---|
| `X-Debug-Proxy-Status` | 实际命中的模式与上游状态码，如 `clean -> Layer-1: 200` |
| `X-Debug-Fake-Referer` | 本次请求使用的 Referer（Clean/Auto Disguise/Forced） |
| `X-Debug-Upstream-UA` | 发送给上游的 User-Agent |
| `X-Debug-Upstream-IP` | 透传给上游的客户端 IP（X-Forwarded-For 等） |

## 部署到阿里云 ESA Pages

本项目通过 Git 仓库拉取代码部署：

1. 将整个仓库推送到 GitHub（或 Gitee）。
2. 登录阿里云 ESA 控制台 → **边缘计算 → 函数和 Pages** → 创建 → **导入 Git 仓库**。
3. 授权并选中本仓库与 `main` 分支，系统会自动读取根目录的 `esa.jsonc` 作为配置（无需手动填构建参数）。
4. 等待构建完成（因 `package.json` 的 build 为无操作，构建秒过）。
5. 在「设置」中添加你的自定义域名，并按提示添加 CNAME 解析，生效后即可使用。

### `esa.jsonc` 关键配置

| 字段 | 值 | 说明 |
|---|---|---|
| `name` | `cors-reverse-proxy` | 部署目标项目名称 |
| `entry` | `./src/proxy.js` | 边缘函数入口 |
| `installCommand` | 空 | 跳过依赖安装 |
| `buildCommand` | `echo ...` | 无操作构建（兼容 ESA 构建流程） |
| `assets.directory` | `./public` | 静态资源目录 |

## 边缘函数运行时说明（ESA 适配要点）

- 入口格式为 `export default { async fetch(request) {} }`。
- 客户端真实 IP 取自 `request.info.remote_addr`（兜底 `Ali-Cdn-Real-Ip` / `X-Forwarded-For`）。
- 所有写入 HTTP 响应头的字符串都必须是 **Latin1（ByteString）**，非 ASCII 字符（如中文文件名、箭头符号 `→`）会触发运行时异常，故代码中对所有头值做了清洗。
- ESA 单次执行最多 4 个 fetch 子请求；本代理最多 2 次（Clean + 防盗链重试），安全。
- 网关对首字节有超时限制（约 10s），慢速视频源建议依赖流式传输（本代码已是流式转发）。

## 本地开发 / 回退

- 本地无特殊运行环境要求，核心是标准 Web API（`fetch` / `Request` / `Response` / `Headers`）。
- 如需回退到 EdgeOne 版本，参考 `edgeone.config.json.bak` 与 `functions.edgeone.bak/` 中的原实现。

## License

仅供个人学习与研究使用。请遵守目标站点及所在地区的相关法律法规，勿将本代理用于侵权或违规用途。
