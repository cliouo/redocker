**简体中文** | [English](./README.en.md)

# redocker

一个跑在 **Vercel 免费版(Hobby)** 上、绑定你自己域名的**多 registry 拉取加速代理**(Docker Hub、ghcr.io、quay.io、gcr.io、registry.k8s.io 等)。它实现了 Docker Registry v2 HTTP API,透明处理 token 鉴权、多架构 manifest、`library/` 命名空间以及镜像层(blob)的分发。

## 🚀 一键部署

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https://github.com/cliouo/redocker&env=DOCKER_USERNAME,DOCKER_PASSWORD&envDescription=Docker%20Hub%20username%20%2B%20a%20Personal%20Access%20Token%20(use%20a%20throwaway%20account)%20for%20authenticated%20pulls&envLink=https://github.com/cliouo/redocker/blob/main/README.en.md%23environment-variables&project-name=redocker&repository-name=redocker)

点击后会把本仓库克隆进你的 Vercel 账号,并提示填写 `DOCKER_USERNAME` / `DOCKER_PASSWORD`。部署完成后还有两步需要手动做(Vercel 无法自动完成),详见 [部署到 Vercel](#部署到-vercel):**关闭部署保护**、**绑定域名**。然后让 Docker 指向它 —— 见 [让 Docker 走代理](#让-docker-走代理)。

> **可行性结论:GO(有注意事项)。** 完整拉取流程已对真实 Docker Hub 内容端到端验证(10/10)。注意事项都是免费额度的*经济性*问题(带宽、限流),而非正确性问题 —— 见 [限制与注意事项](#限制与注意事项)。

---

## 工作原理

`docker pull` 本质是一连串 HTTP 请求。代理挡在 `registry-1.docker.io` 前面,只改写恰好足够的内容,让客户端始终经过它:

```
docker 客户端                redocker (Vercel)              Docker Hub
     │  GET /v2/                    │                            │
     │ ───────────────────────────►│  GET /v2/                  │
     │                             │ ──────────────────────────►│
     │                             │ ◄── 401 WWW-Authenticate ──│  realm=auth.docker.io
     │ ◄── 401, realm 已改写 ───────│      (realm → /v2/auth)     │
     │  GET /v2/auth?scope&service  │                            │
     │ ───────────────────────────►│  GET auth.docker.io/token  │
     │                             │ ──(+ 你的 PAT, 可选)───────►│
     │ ◄────────── token ──────────│ ◄────────── token ─────────│
     │  GET .../manifests/<ref>     │                            │
     │ ───────────────────────────►│ ─────────────────────────►│  (Accept 协商, 多架构)
     │ ◄────────── manifest ───────│ ◄───────── manifest ───────│
     │  GET .../blobs/<digest>      │                            │
     │ ───────────────────────────►│ ─────────────────────────►│  307 → CDN
     │ ◄─── 镜像层字节 (流式) ───────│ ◄═══════ stream ═══════════╛
```

- **Token realm 改写** —— 每个 `401` 的 `WWW-Authenticate` 里的 `realm` 都被改写成 `/v2/auth`,使鉴权始终经过代理(这也是代理能注入*你的* Docker Hub 凭据的前提)。
- **`library/` 补全** —— `docker pull 你的域名/nginx`(单段名)会被 `301` 重定向到 `library/nginx`。
- **多 registry** —— 第一段路径含点(如 `/v2/ghcr.io/...`)即被路由到对应 registry,见 [让 Docker 走代理](#让-docker-走代理)。
- **Blob 分发** —— 两种策略,见 [`BLOB_MODE`](#环境变量)。
- **无状态** —— 没有服务端缓存层;但 Docker *本地*的层缓存意味着已拉过的层不会被重复拉取。

代码结构:
- `src/proxy.js` —— 运行时无关的核心(只用 Web 标准 `fetch`/`Request`/`Response`)。
- `src/node-adapter.js` —— 桥接 Node `(req,res)` ⇄ 核心,流式传输响应体。
- `api/proxy.js` —— Vercel serverless 函数(Node 运行时);所有路径经 `vercel.json` 路由到这里。
- `local-server.js` —— 本地用**同一个** adapter 跑起来做测试。
- `test/` —— 完整 v2 流程的 curl 测试 + 确定性的路由/重定向单测。

---

## 本地测试

确定性单测(mock 掉网络,无需 docker):

```bash
npm run test:unit     # 路由 + blob 模式逻辑,共 20 项断言
```

用 `curl` 走完整 v2 流程,对接真实上游。由于某些网络(如墙内)直连 Docker Hub 被阻断,把测试指向一个可达的 Docker Hub 镜像作上游:

```bash
# 终端 1 —— 把代理指向一个可达的 Docker Hub 镜像
UPSTREAM_REGISTRY=https://docker.m.daocloud.io \
UPSTREAM_AUTH=https://m.daocloud.io/auth \
UPSTREAM_SERVICE=docker.m.daocloud.io \
LIBRARY_REDIRECT=1 \
node local-server.js

# 终端 2 —— 走一遍完整流程
BASE=http://localhost:8787 bash test/v2-flow.sh
# => 10 passed, 0 failed
```

流程测试验证了:`401` + realm 改写、`library/` 重定向、token 转发、多架构 index 的 Accept 协商、`HEAD` + `Docker-Content-Digest`,以及**逐字节正确的 blob 下载(sha256 与摘要一致)**。

---

## 部署到 Vercel

**最简单**:点本文档顶部的 **[一键部署按钮](#-一键部署)**。或用 CLI:

```bash
npm i -g vercel        # 或直接用 `npx vercel`
cd redocker
vercel                 # 关联/新建项目(首次为 preview)
vercel --prod          # 部署到生产
```

无论哪种方式,都要完成下面几步:

### 1. 关闭部署保护(关键)
新建的 Vercel 项目常默认开启 **Vercel Authentication**,会在每个请求前面套一层 SSO 登录页。docker 客户端没法登录,拉取会拿到一堆 HTML 而失败。

> Dashboard → 你的项目 → **Settings → Deployment Protection → Vercel Authentication → 设为 Disabled**(对 Production 生效)。

### 2. 配置环境变量(强烈建议)
> Dashboard → **Settings → Environment Variables**,或 `vercel env add NAME`。

设置 `DOCKER_USERNAME` + `DOCKER_PASSWORD`,让拉取认证到*你自己*的账号(按账号限流),而不是落到 Vercel 出口共享 IP 的匿名(按 IP)额度里。为什么重要、以及"小号"的建议,见 [限制与注意事项](#限制与注意事项)。

### 3. 绑定域名
> Dashboard → **Settings → Domains → Add**,然后按 Vercel 给出的提示加 DNS 记录:
> - **子域**(如 `docker.example.com`):`CNAME` → `cname.vercel-dns.com`
> - **裸域/顶级域**(如 `example.com`):`A` → `76.76.21.21`

Vercel 会自动签发 TLS 证书。(请用自定义域名 —— 默认的 `*.vercel.app` 在某些网络下可能不可达。)

### 4. 验证部署
```bash
curl -i https://你的域名/v2/
# 期望:HTTP/2 401  +  www-authenticate: Bearer realm="https://你的域名/v2/auth",service="registry.docker.io"
```

---

## 让 Docker 走代理

**方式 A —— 配置为镜像源(仅 Docker Hub,透明):**
```json
// Linux: /etc/docker/daemon.json   |   macOS/Win: Docker Desktop → Settings → Docker Engine
{ "registry-mirrors": ["https://你的域名"] }
```
重启 Docker,然后照常拉取:
```bash
docker pull nginx          # 自动走你的镜像源
docker pull hello-world
```

**方式 B —— 显式前缀(任意 tag,无需改 daemon):**
```bash
docker pull 你的域名/library/nginx:latest
docker pull 你的域名/nginx                       # 自动补全为 library/nginx
```

**方式 C —— 其他 registry(用 registry 主机名作前缀):**
```bash
docker pull 你的域名/ghcr.io/astral-sh/uv:latest
docker pull 你的域名/quay.io/podman/hello:latest
docker pull 你的域名/gcr.io/distroless/static:latest
docker pull 你的域名/registry.k8s.io/pause:3.9
```
第一段路径含点(如 `ghcr.io`)就会被当作上游 registry 主机;Docker Hub 的命名空间永远不含点,所以不会有歧义。`registry-mirrors` 只能镜像 Docker Hub,其它 registry 一律用这种前缀方式。

**支持的 registry:** `docker.io`、`ghcr.io`、`quay.io`、`gcr.io`、`registry.k8s.io`、`k8s.gcr.io`、`mcr.microsoft.com`、`public.ecr.aws`、`registry.gitlab.com`、`nvcr.io`,以及 `*.pkg.dev`(Google Artifact Registry)。要加别的用 `EXTRA_REGISTRIES` 环境变量。不在允许名单里的会返回 `404`(避免代理被滥用为开放中继)。需要你自己凭据的 registry(如 AWS ECR、私有库)在这里仅适用于匿名/公开镜像。

---

## 环境变量

| 变量 | 默认值 | 作用 |
|---|---|---|
| `DOCKER_USERNAME` | — | Docker Hub 用户名,用于认证拉取(限流归属到你的账号)。 |
| `DOCKER_PASSWORD` | — | Docker Hub 的 **Personal Access Token(PAT)**,不是登录密码。 |
| `BLOB_MODE` | `stream` | `stream`:代理抓取并**流式中转**层字节(真正加速,消耗 Vercel 带宽)。`redirect`:把 CDN 的 `307` 直接还给客户端(省带宽,但要求客户端能直连该 CDN)。 |
| `LIBRARY_REDIRECT` | auto | 强制开/关 `library/` 命名空间补全(Docker Hub 默认开)。 |
| `EXTRA_REGISTRIES` | — | 逗号分隔的额外 registry 主机,加入前缀允许名单(在内置名单之外)。 |
| `UPSTREAM_REGISTRY` | `https://registry-1.docker.io` | 默认上游(当没有指定 registry 主机前缀时使用)。 |
| `UPSTREAM_AUTH` | `https://auth.docker.io` | 上游 token 服务(代理会追加 `/token`)。 |
| `UPSTREAM_SERVICE` | `registry.docker.io` | token 的 `service` 值。 |

---

## 限制与注意事项

已验证在**个人、低用量**场景下可行。依赖它之前请了解这些:

- **可达性** —— Vercel 边缘在多数网络下可达且快(包括墙内,实测一个 Vercel 托管站点约 0.45s)。请始终通过你的**自定义域名**访问;默认的 `*.vercel.app` 可能被墙。
- **带宽(免费版最主要的限制)** —— Hobby 含**每月 100 GB 出站流量、无超额**;超了会**暂停项目**到下个计费周期。`stream` 模式下每个层字节都算。缓解:Docker 本地层缓存可避免重复拉取;或切到 `BLOB_MODE=redirect` 让字节绕过 Vercel(前提是客户端能直连 CDN)。
- **限流** —— Docker Hub 对匿名拉取有限制(未认证约 10 次/小时,认证后更高),而 Vercel 从**共享 IP** 出站,匿名额度可能已被别人占满。**请设置 `DOCKER_USERNAME`/`DOCKER_PASSWORD`。** 免费版 PAT 带有写/删权限,所以请用一个**不拥有任何仓库的专用小号**。
- **300 秒函数上限** —— `stream` 模式下,单个数 GB 的大层在慢网络上可能超时。常规镜像无碍。
- **`BLOB_MODE=redirect` + containerd 客户端** —— containerd 类客户端(Docker Engine 29+ 默认)可能无法跟随跨主机的 `307`。若 redirect 模式下拉取失败,改用 `stream`。
- **条款** —— Hobby 仅限**个人/非商业**用途。高流量公开镜像可能触犯 Vercel 的合理使用政策;商用/CI 请升级 Pro。
- **无服务端缓存** —— 这是无状态代理,不是缓存型镜像源。每次冷拉取都是一次实时回源。

---

为个人 Docker 镜像加速而做。欢迎 PR / issue。
