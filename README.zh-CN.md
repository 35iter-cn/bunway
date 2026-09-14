# bunway

> 跑在 Bun 上的自托管 LLM 网关：单容器、零运行时依赖、OpenAI 兼容 API、按优先级故障转移、SQLite 计费、内置控制台。

**bunway 与 Bun 项目 / Oven 无任何隶属、背书或关联关系。**

![dashboard](docs/assets/dashboard.png)

## 快速开始

不需要任何真实 API key —— demo 自带 mock 上游与预置数据：

```bash
git clone https://github.com/35iter-cn/bunway
cd bunway
docker compose -f demo/docker-compose.yml up -d
```

打开 http://127.0.0.1:3101/console（token：`demo-admin-token`），再发一条真实请求走一遍网关：

```bash
curl -sN http://127.0.0.1:3101/v1/chat/completions \
  -H "Authorization: Bearer sk-demo" \
  -H "Content-Type: application/json" \
  -d '{"model":"fast-model","messages":[{"role":"user","content":"hi"}]}'
```

## 为什么选 bunway

- **按优先级故障转移** —— 路由按 priority 顺序尝试上游；4xx/5xx 分类标记 provider 不可用或进入冷却，流量自动溢转到下一个。
- **零运行时依赖** —— 网关是 Bun 上的纯 TypeScript（`bun:sqlite`、`Bun.serve`）；没有 npm 依赖要审计，也没有依赖会坏。
- **SQLite 计费 + 内置控制台** —— 每条请求按 token 计价（输入/输出/缓存读/缓存写）存入 SQLite；单容器 dashboard 展示 KPI、趋势、逐 provider 路由状态与错误事件。

## 文档

- 部署与验证（逐步，含预期输出）：[docs/deploy.md](docs/deploy.md)
- 网关参考（接口清单、provider 配置、故障转移、计价）：[docs/gateway.md](docs/gateway.md)
- 英文主文档: [README.md](README.md)

## 许可

MIT。打包进镜像的前端依赖（uplot、svelte、vite）同样为 MIT。