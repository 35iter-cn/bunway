# bunway

> 跑在 Bun 上的自托管 LLM 网关：单容器、零运行时依赖、OpenAI 兼容 API、按
> priority 故障转移、SQLite 计费、内置控制台。

**bunway 与 Bun 项目 / Oven 无任何隶属、背书或关联关系。**

```bash
git clone https://github.com/35iter-cn/bunway && cd bunway
mkdir -p gateway-data
printf 'GATEWAY_ADMIN_TOKEN=%s\n' "$(openssl rand -hex 32)" > deploy/.env
docker compose -f deploy/docker-compose.service.yml --profile demo up -d --build
```

控制台 http://127.0.0.1:3001/console（token 在 `deploy/.env`）。没有真实上游时，用
`--profile demo` 自带的 mock 上游当 **demo provider**——完整 JSON 与验证脚本见
[llms.txt](llms.txt) 任务 2–4，零 key 即可把 provider → 路由 → 客户端整条链路跑通。

`mkdir -p gateway-data` 不能省：容器以 uid 1000 运行，目录若由 Docker 自动创建会属 root，
网关会以 `data dir /data not writable` 退出。

- 完整文档（英文）：[README.md](README.md) · [部署](docs/deploy.md) · [网关参考](docs/gateway.md) · [客户端配置](docs/agents.md)
- 给 agent 用的任务手册（部署 / provider / 路由 / 客户端 四件事）：[llms.txt](llms.txt)

MIT。
