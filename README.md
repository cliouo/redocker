**简体中文** | [English](./README.en.md)

# redocker

> 一键部署到 Vercel 免费版的多 registry Docker 拉取加速代理。

[![部署到 Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https://github.com/cliouo/redocker&env=DOCKER_USERNAME,DOCKER_PASSWORD&envDescription=Docker%20Hub%20username%20%2B%20a%20Personal%20Access%20Token%20(use%20a%20throwaway%20account)%20for%20authenticated%20pulls&envLink=https://github.com/cliouo/redocker/blob/main/README.en.md%23configuration&project-name=redocker&repository-name=redocker)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)

redocker 通过一个绑定到你自己域名的 Vercel Function,代理 Docker Hub 及其它 registry(ghcr.io、quay.io、gcr.io、registry.k8s.io 等)。把 Docker 指向它,即可加速 / 解锁镜像拉取 —— 无需自己维护服务器。

## 功能特性

- **一键部署**到 Vercel 免费 Hobby 计划,用你自己的域名。
- **Docker Hub 镜像源** —— 直接填进 `registry-mirrors` 即可。
- **任意 registry** —— `docker pull 你的域名/ghcr.io/owner/image`。
- **私有镜像** —— 登录 registry 子域名;凭据被转发给上游,代理**不保存**。
- **流式**分发镜像层(绕过 Vercel 4.5 MB 响应体限制),另有省带宽的重定向模式。
- **认证拉取 Docker Hub** —— 用你自己的 token,限流算在你账号上,而非 Vercel 共享 IP。
- **白名单**上游 —— 不是开放中继。

## 快速开始

1. **部署** —— 点上方按钮(或运行 `npx vercel`)。一键部署会要求填 `DOCKER_USERNAME` 和 `DOCKER_PASSWORD`(你的 Docker Hub 用户名 + 访问令牌),原因见下方提示。
2. **绑定域名** —— *Settings → Domains* 添加你的(子)域名,加一条 `CNAME → cname.vercel-dns.com`,TLS 自动签发。
3. **验证**:
   ```bash
   curl -i https://你的域名/v2/
   # → HTTP/2 401,并带:
   #   www-authenticate: Bearer realm="https://你的域名/v2/auth",service="registry.docker.io"
   ```

> [!IMPORTANT]
> **redocker 用的是你自己的 Docker Hub 账户。** Vercel 从共享 IP 出站,而 Docker Hub 的匿名拉取限额按 IP 计,常被同一出口 IP 上的其他人占满而 `429`。配置 `DOCKER_USERNAME` + `DOCKER_PASSWORD`(访问令牌)后,拉取会认证为你的账号(认证额度约 200 次 / 6 小时、按账号计),才稳定可用 —— 所以一键部署把这两项设为必填。不配也能跑(匿名),但共享 IP 上很容易被限流。
>
> 也正因为它携带你的 Docker Hub 凭据:**这是给你个人用的,不要公开分享代理地址**,否则别人会消耗你账号的额度。建议用一个**不含任何私有仓库的小号**令牌(免费令牌带写/删权限)。

> [!NOTE]
> 若拉取时返回的是 HTML 登录页而不是 JSON,说明项目开了 **Deployment Protection**(生产环境默认不开);到 *Settings → Deployment Protection* 关掉即可。

## 使用

### 作为 Docker Hub 镜像源

```jsonc
// Linux: /etc/docker/daemon.json —— macOS/Windows: Docker Desktop → Settings → Docker Engine
{ "registry-mirrors": ["https://你的域名"] }
```

重启 Docker,照常 `docker pull nginx`。

### 拉取任意公开镜像(前缀方式)

```bash
docker pull 你的域名/library/nginx:latest         # Docker Hub
docker pull 你的域名/nginx                         # 简写 → library/nginx
docker pull 你的域名/ghcr.io/astral-sh/uv:latest   # GitHub Container Registry
docker pull 你的域名/quay.io/podman/hello:latest   # Quay
docker pull 你的域名/registry.k8s.io/pause:3.9     # Kubernetes
```

第一段路径含点(`ghcr.io`)即被当作上游 registry;Docker Hub 命名空间永远不含点,因此无歧义。`registry-mirrors` 只能镜像 Docker Hub,其它一律用这种方式。

内置 registry:`docker.io`、`ghcr.io`、`quay.io`、`gcr.io`、`registry.k8s.io`、`k8s.gcr.io`、`mcr.microsoft.com`、`public.ecr.aws`、`registry.gitlab.com`、`nvcr.io`、`*.pkg.dev`。用 `EXTRA_REGISTRIES` 添加更多。

### 私有镜像

私有镜像需要按 registry 登录,所以用 **registry 子域名**并在那里登录。代理会把你的凭据转发给上游,且**不保存**。

```bash
# 一次性:把 ghcr.你的域名 加到同一个 Vercel 项目(Settings → Domains)+ 一条 CNAME 记录
echo <令牌> | docker login ghcr.你的域名 -u <用户名> --password-stdin
docker pull ghcr.你的域名/owner/private-image:tag
```

子域名 → registry:`ghcr`、`quay`、`gcr`、`k8s`、`mcr`、`ecr`、`gitlab`、`nvcr`、`docker`。用 `EXTRA_SUBDOMAINS="标签=主机"` 添加更多。(ghcr 令牌需要 `read:packages` 权限。)

> [!WARNING]
> 不要把私仓令牌放进公共部署的环境变量里"统一注入" —— 那等于把这些私有镜像暴露给所有能访问代理的人。子域名登录的方式让凭据始终留在客户端。

## 配置

`DOCKER_USERNAME` / `DOCKER_PASSWORD` 在一键部署时填写(见上方说明);其余均为可选。在 Vercel 控制台(*Settings → Environment Variables*)或用 `vercel env add` 调整。

| 变量 | 默认 | 说明 |
|---|---|---|
| `DOCKER_USERNAME` / `DOCKER_PASSWORD` | **必填** | Docker Hub 用户名 + 访问令牌。认证拉取把限流算在你账号上,而非 Vercel 共享 IP 的匿名额度(否则极易 `429`)。请用**小号** —— 免费令牌带写/删权限。 |
| `BLOB_MODE` | `stream` | `stream` 中转层字节(真加速,耗 Vercel 带宽);`redirect` 把 CDN 的 `307` 还给客户端(省带宽,需客户端能直连 CDN)。 |
| `EXTRA_REGISTRIES` | — | 前缀路由的额外 registry 主机,逗号分隔。 |
| `EXTRA_SUBDOMAINS` | — | 额外的 `标签=主机` 子域名映射,逗号分隔。 |
| `LIBRARY_REDIRECT` | auto | 强制开/关 `library/` 补全(Docker Hub 默认开)。 |
| `UPSTREAM_REGISTRY` / `UPSTREAM_AUTH` / `UPSTREAM_SERVICE` | Docker Hub | 覆盖默认上游(如改用另一个 Docker Hub 镜像)。 |

## 工作原理

`docker pull` 本质是一连串 Registry v2 HTTP 请求。redocker 代理它们,只改写恰好足够的内容,让客户端始终回到代理 —— 主要是 `WWW-Authenticate` 里的 realm,使鉴权(及可选的凭据注入)始终经过代理。

<details><summary>拉取时序</summary>

```
docker 客户端                redocker (Vercel)              registry
     │  GET /v2/                    │                            │
     │ ───────────────────────────►│ ──────────────────────────►│
     │                             │ ◄── 401 WWW-Authenticate ──│
     │ ◄── 401, realm 已改写 ───────│      (realm → /v2/auth)     │
     │  GET /v2/auth?scope&service  │                            │
     │ ───────────────────────────►│  GET <realm>/token         │
     │                             │ ──(+ 凭据)────────────────►│
     │ ◄────────── token ──────────│ ◄────────── token ─────────│
     │  GET .../manifests/<ref>     │                            │
     │ ───────────────────────────►│ ─────────────────────────►│
     │ ◄────────── manifest ───────│ ◄───────── manifest ───────│
     │  GET .../blobs/<digest>      │                            │
     │ ───────────────────────────►│ ─────────────────────────►│  307 → CDN
     │ ◄─── 镜像层字节 (流式) ───────│ ◄═══════ stream ═══════════╛
```

</details>

- **Token realm 改写** —— 每个 `401` 的 realm 都指回 `/v2/auth`。
- **`library/` 补全** —— Docker Hub 单段名镜像 `301` 到 `library/<name>`。
- **路由** —— 主域:Docker Hub 加 `/v2/<host>/…` 前缀;registry 子域则把整台主机锁定到一个上游(这正是按 registry 登录能成立的原因)。
- **镜像层** —— 流式中转(或 `307` 重定向);`fetch` 在跨域 CDN 跳转时会丢弃 `Authorization`,令牌不外泄。
- **无状态** —— 无服务端缓存;Docker 本地层缓存避免重复拉取。

## 开发

```bash
npm run test:unit     # 确定性路由/鉴权测试(mock 网络)

# 对接真实上游的端到端流程(curl 与 docker 用同一套 API)。
# 若 docker.io 被墙,用一个可达的 Docker Hub 镜像作上游:
UPSTREAM_REGISTRY=https://docker.m.daocloud.io \
UPSTREAM_AUTH=https://m.daocloud.io/auth \
UPSTREAM_SERVICE=docker.m.daocloud.io \
LIBRARY_REDIRECT=1 node local-server.js &
BASE=http://localhost:8787 bash test/v2-flow.sh
```

目录:`src/proxy.js`(运行时无关核心)· `src/node-adapter.js`(Node ⇄ Web 桥接)· `api/proxy.js`(Vercel 函数)· `local-server.js`(本地开发服务器)· `test/`。

## 限制

为 Vercel 免费版的**个人、低用量**场景设计。

- **带宽** —— Hobby 含每月 100 GB 出站、无超额;超了会暂停项目到下个周期。`stream` 模式每个层字节都算;Docker 本地缓存与 `BLOB_MODE=redirect` 可缓解。
- **限流** —— 设置 `DOCKER_USERNAME`/`DOCKER_PASSWORD`,免得在 Vercel 共享 IP 上被 Docker Hub 限流。
- **函数时长** —— 300 秒;`stream` 模式下单个数 GB 的大层在慢网络上可能超时。
- **条款** —— Hobby 计划仅限个人、非商业用途。
- **无服务端缓存** —— 每次冷拉取都是一次实时回源。

## 许可证

[MIT](./LICENSE)
