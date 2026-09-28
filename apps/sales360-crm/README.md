# Sales 360 CRM

独立运行的客户管理系统，设计参考[飞书 aPaaS 客户线索 CRM 案例](https://ae.feishu.cn/hc/zh-CN/articles/225702000622)，与飞书官方产品没有隶属关系。核心流程使用本地账号，不需要办公平台授权。

按任务快速选文档请先看 [`AGENTS.md`](AGENTS.md)；下方是完整文档目录。

## 文档入口

1. [`docs/01-参考与范围.md`](docs/01-参考与范围.md)：官方案例证据、适用边界和待确认事项。
2. [`docs/02-产品需求.md`](docs/02-产品需求.md)：角色、流程、功能、规则及迭代范围。
3. [`docs/03-UI规范.md`](docs/03-UI规范.md)：参考图观察、页面结构、组件及交互规范。
4. [`docs/04-技术架构与数据.md`](docs/04-技术架构与数据.md)：前后端、数据模型、权限、集成与运行要求。
5. [`docs/05-接口契约.md`](docs/05-接口契约.md)：首期 REST API、错误和幂等约定。
6. [`docs/06-开发规范.md`](docs/06-开发规范.md)：目录、编码、迁移、测试与交付规则。
7. [`docs/07-验收标准.md`](docs/07-验收标准.md)：按真实用户路径验收，禁止用静态演示替代。
8. [`docs/08-开发任务清单.md`](docs/08-开发任务清单.md)：后续实施顺序与每阶段完成证据。

## 代码目录

```text
apps/sales360-crm/
  docs/
  frontend/               # React + TypeScript Web/H5
  backend/                # NestJS API、Prisma 模型和迁移、端到端测试
  infra/                  # 本地 PostgreSQL
```

## 推荐的本地部署

从仓库根目录运行 `node scripts/init-local.mjs` 和 `node scripts/start-local.mjs crm`。首次启动自动迁移、创建管理员并提供正式构建的 Web 与 API；管理员凭据在根目录 `.env`，登录只需邮箱和密码。详见[本地部署与运维](../../docs/08-开源本地部署.md)。

## 源码开发启动

依赖：Node.js 22、pnpm 11、Docker。先在仓库根目录执行 `pnpm install`。随后：

```bash
docker compose -f apps/sales360-crm/infra/compose.yaml up -d
cp apps/sales360-crm/backend/.env.example apps/sales360-crm/backend/.env
```

编辑 `.env`，设置唯一的 `CRM_BOOTSTRAP_PASSWORD`（至少 12 位）。在 `apps/sales360-crm/backend/` 执行 `pnpm db:deploy`、`pnpm admin:create`、`pnpm build`、`pnpm start`；在 `apps/sales360-crm/frontend/` 执行 `pnpm dev`。打开 http://127.0.0.1:4300，使用管理员邮箱和密码登录。

运行中的本地环境可在仓库根目录执行 `pnpm test:crm`。测试会创建角色、线索、客户、商机、服务计划、任务、风险和续约记录，并检查越权与幂等。前后端生产构建执行 `pnpm build:crm`。

开发测试可在仓库根目录运行 `pnpm local:seed`，在未提交的 `review-access.txt` 获取角色验收账号；正式部署不需要执行该命令。

已实现：线索分配与转化、客户和联系人、商机阶段、跟进与待办、工作台、销售池轮转、CSM 服务计划与任务审核、风险和续约商机。本地成员登录、修改密码和管理员建号可独立使用。外部提醒投递尚未接入；outbox 事件保持待投递，不代表消息已送达。复杂合同/开票由独立 ERP 承担。详情见 [`docs/09-实施与验收记录.md`](docs/09-实施与验收记录.md)。

AI 助手在登录后的右下角打开，工作台与线索、客户、商机详情会自动选择业务上下文。客户和商机详情还可生成结构化跟进草稿，再进入原表单人工编辑和保存。对话保存在当前用户的独立历史中，可自行删除。管理员在左下角设置页的“模型接入”配置并测试后启用；后端 `.env` 的 `OPENAI_API_KEY`、`OPENAI_MODEL` 可作为默认值；不配置时明确显示未启用。真实模型质量尚未验收。
