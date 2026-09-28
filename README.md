# Sales 360 CRM

面向 B2B 销售团队的开源客户管理系统。线索从录入、分配、处理到转为客户和商机，后续跟进与客户服务都保存在独立的业务数据库中。项目使用本地账号与角色权限运行，无需飞书账号；它参考了公开的 Sales 360 案例，但不是飞书官方产品。

[在线入口](https://apaas-sales360-crm.492746023.workers.dev) · [线上发布记录](docs/09-线上发布记录.md) · [完整功能与验收记录](apps/sales360-crm/docs/09-实施与验收记录.md)

## 业务能力

| 板块 | 当前能力 |
| --- | --- |
| 线索 | 创建与重复候选、人工或销售池轮转分配、接受/退回/无效、有效判定、转化申请与主管审核；转化时关联或创建客户、联系人和商机，保留时间线与幂等结果。 |
| 客户与商机 | 客户、联系人、商机阶段、负责人和参与人、赢单/输单、跟进记录与待办；列表支持服务端搜索和筛选。 |
| 工作台与报表 | 待处理线索、跟进、商机和销售指标，从已保存的业务记录计算。 |
| 客户服务 | CSM 服务计划、任务提交与审核、风险登记与关闭、续约商机及服务统计。 |
| 成员与权限 | 管理员创建成员；按工作区、角色、组织及记录归属限制服务端访问；成员可修改密码。 |
| AI 助手 | 对话关联当前业务上下文，可生成供人工编辑的跟进草稿；对话历史按用户隔离。仅在部署者配置模型后启用。 |

典型流程：**录入线索 → 分配并跟进 → 申请/审核转化 → 维护客户与商机 → 创建服务计划和续约任务**。业务规则、状态和角色范围见[产品需求](apps/sales360-crm/docs/02-产品需求.md)。

## 本地部署

需要 **Node.js 22、Docker Engine/Desktop 与 Docker Compose**。从空数据库启动时，脚本会生成随机管理员和数据库密码，执行迁移并启动 Web、API、PostgreSQL。

```bash
git clone https://github.com/geyaovip/apaas-sales360-crm.git
cd apaas-sales360-crm
node scripts/init-local.mjs
node scripts/start-local.mjs
```

打开 [http://localhost:4300](http://localhost:4300)，使用该应用的管理员凭据登录。管理员账号与密码保存在根目录仅当前用户可读的 `.env`；首次登录后建议修改密码。`.env` 不会提交到 Git，重新运行初始化脚本也不会覆盖已有凭据。

```bash
docker compose --env-file .env -f deploy/compose.yaml ps
curl -fsS http://localhost:4300/api/v1/health
node scripts/backup-local.mjs
```

数据保存在独立 Docker 卷中。停机、备份恢复、密码恢复和生产部署步骤见[部署与运维](docs/08-开源本地部署.md)。不要对保存业务数据的环境执行 `docker compose down -v`。

## 技术结构

| 层 | 实现 | 目录 |
| --- | --- | --- |
| Web | React、TypeScript、Vite，适配桌面与手机浏览器 | [`apps/sales360-crm/frontend/`](apps/sales360-crm/frontend/) |
| API | NestJS、服务端权限与业务规则 | [`apps/sales360-crm/backend/`](apps/sales360-crm/backend/) |
| 数据 | PostgreSQL 17、Prisma 模型与迁移 | [`apps/sales360-crm/backend/prisma/`](apps/sales360-crm/backend/prisma/) |
| 本地运行 | Docker Compose 构建 Web/API 并启动独立数据库 | [`deploy/`](deploy/) |
| 公网部署 | Cloudflare Worker 托管前端并转发同源 `/api/*`；云服务器运行 API 与数据库 | [`cloudflare/`](cloudflare/)、[`wrangler.jsonc`](wrangler.jsonc) |

线上入口使用本仓库的独立 Worker 和独立数据库。公开仓库不包含线上管理员凭据或客户数据。自行部署时请按[生产运维记录](docs/09-线上发布记录.md)配置镜像、HTTPS 网关和 Worker Secret。

## AI 配置与边界

管理员在左下角账号菜单进入“模型接入”，填写兼容 OpenAI Responses API 的 API 根地址、模型名称和 API Key，可先测试再保存。密钥在服务端加密保存，页面不回显；本地初始化脚本会生成随机密钥；其他部署方式需生成并长期保管 `AI_CONFIG_ENCRYPTION_KEY`（可运行 `openssl rand -hex 32`）。也可在 API 服务端配置 `OPENAI_API_KEY`、`OPENAI_MODEL` 和可选的 `OPENAI_BASE_URL` 作为默认值。未配置时核心 CRM 功能照常运行，AI 入口会提示未启用。跟进草稿只供人工检查和保存，不会自动改写客户、商机或跟进记录；发送给模型的上下文受当前用户权限约束。配置说明见[AI 能力与数据边界](docs/06-AI能力实施规划.md)。

## 开发与验证

先按上文启动本地环境，再安装开发依赖并运行构建和集成测试：

```bash
corepack pnpm install --frozen-lockfile
corepack pnpm build:crm
corepack pnpm test:crm
```

集成测试通过真实 HTTP 与数据库验证线索转化、幂等、角色隔离和客户服务流程，**会写入所连接的数据库**；请只在独立测试环境运行。GitHub 的 [Build 工作流](.github/workflows/build.yml)负责构建检查，API 镜像工作流见[配置](.github/workflows/api-image.yml)。贡献方式见[CONTRIBUTING.md](CONTRIBUTING.md)。

## 当前边界与文档

- 飞书、钉钉、企业微信的登录、组织同步与消息投递尚未接通；外部提醒记录不代表消息已送达。
- 报价、合同、开票不属于本 CRM；模型建议的实际质量仍需使用者验证。
- [文档路由](apps/sales360-crm/AGENTS.md) · [接口契约](apps/sales360-crm/docs/05-接口契约.md) · [验收标准](apps/sales360-crm/docs/07-验收标准.md)
- 源码采用 [Apache-2.0](LICENSE)；安全问题请按 [SECURITY.md](SECURITY.md) 私密报告。
