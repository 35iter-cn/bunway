# bunway

> 跑在 Bun 上的自托管 LLM 网关：单容器、零运行时依赖、OpenAI 兼容 API、按
> priority 故障转移、SQLite 计费、内置控制台。

**bunway 与 Bun 项目 / Oven 无任何隶属、背书或关联关系。**

```bash
git clone https://github.com/35iter-cn/bunway && cd bunway
docker compose -f demo/docker-compose.yml up -d
bash demo/smoke.sh http://127.0.0.1:3101 demo-admin-token sk-demo
```

控制台 http://127.0.0.1:3101/console（token `demo-admin-token`）。demo 自带 mock
上游与预置数据，不需要任何真实 API key。

- 完整文档（英文）：[README.md](README.md) · [部署](docs/deploy.md) · [网关参考](docs/gateway.md) · [客户端配置](docs/agents.md)
- 给 agent 用的任务手册（部署 / provider / 路由 / 客户端 四件事）：[llms.txt](llms.txt)

MIT。
