# Cornven Agent MVP — Demo

> **This is a demonstration prototype. It is NOT connected to the client's production POS database and is not production-ready.**
>
> **本项目是 Demo 演示版本，尚未接入客户 POS 生产数据库。** 结算与报告使用本地数据库、演示交易或手动导入的 CSV，不代表客户生产业务的实时状态。

## 功能

- CSV 校验、确认导入及重复导入处理。
- 按艺术家和月份进行结算试算，生成并保存 PDF 报告。
- 人工审批、已审批报告的手动与定时邮件投递。
- Chatbot 意图识别与只读业务工具：退款指标、结算试算、已保存报告查询。
- 简繁英检索归一化、词项／语义混合检索、流式 SOP 回答与最终引用校验。
- 经登记的 PDF 附件页内预览、翻页、缩放和下载。
- Chatbot 默认最多 **8 段证据**；不会降低相关性要求来填满数量。

## 公开版与本地完整版本的区别

这是 Plan B 的**公开代码快照**。应用实现保留，但客户内部 SOP、合同、图片、原始网页、内部链接、私有验收数据及旧 Git 历史没有上传。公开知识库只包含新编写的合成演示说明，**不是客户业务规则**，也不含真实客户合同。

因此，公开版可以演示本地业务流程和基本 RAG 链路，但不能复现私有版本针对四份客户 SOP 的回答或合同附件。要接入自己的文档，需先配置并审核相应来源及资源。完整差异见 [公开范围说明](docs/PUBLICATION.md)。

## 本地运行（仅限获授权的维护人员）

需要 Node.js 22.13 或更高版本、pnpm 11 和 Docker Desktop。

```sh
git clone https://github.com/William-Tyls/Cornven-Agent-MVP.git
cd Cornven-Agent-MVP

# 仅首次配置；不要覆盖已有 .env。
cp local.env.example .env
pnpm install --frozen-lockfile
pnpm local:prepare-demo
pnpm local:start
```

- Web：<http://127.0.0.1:5190>
- Chatbot：<http://127.0.0.1:5190/assistant>
- API health：<http://127.0.0.1:3119/api/v1/health>
- 演示 PostgreSQL：本机端口 `55449`。
- 本地邮件收件箱：<http://127.0.0.1:58025>

`local:prepare-demo` 会建立演示数据库并准备样例报告；`local:start` 会启动服务及配置的后台任务。内置交易样例集中在 2026 年 8、9 月，查看历史月份可复现相应数据；其他月份没有交易时，零销售是预期结果。

### 模型与邮件

- Chatbot 需要在 `.env` 配置 `OPENAI_API_KEY`，意图／回答模型为 `gpt-5.4-nano`。
- 默认 `RAG_EMBEDDING_PROVIDER=deterministic` 可离线检索合成文档，不是语义 embedding。使用 OpenAI embedding 时需配置 `openai` provider、`text-embedding-3-large`、1024 维，并显式运行 `pnpm rag:index:memory`；构建和查询会产生真实 API 调用。
- `RAG_TOP_K=8`，`RAG_CONTEXT_TOKEN_BUDGET=16000` 是保守文本 token 上界。
- 默认 `DELIVERY_MODE=local` 将邮件投递至本地 Mailpit。改为 SMTP 并配置真实邮箱后会真实发送邮件。
- 密钥和凭据只放在本地 `.env`，不要提交到 GitHub，也不要使用 `VITE_` 前缀暴露给前端。

## 验证

```sh
pnpm db:generate
pnpm quality
```

公开版检查覆盖格式、lint、接口契约、Prisma schema、类型、构建、保留的测试和合成 RAG 检索检查，不需要付费模型。客户原始网页／附件审计和客户题库评测不在公开版中，不能把它们当成已执行。接口定义见 [OpenAPI](docs/architecture/openapi.yaml)。

## 当前限制

- 尚未接入客户 POS 生产数据库，也没有生产数据库同步。
- 尚未实现正式登录与身份控制；本地 Demo 身份不适合生产部署。
- 合同 PDF 的显示能力不代表 PDF 正文已作为 RAG 回答依据。
- k=8 是用户选定的运行参数，不代表经过完整人工评分后证明的最优值。
- 私有 RAG 变更归档时完成 66/73 项任务，仍有 7 项人工质量／正式发布相关待办；这个公开快照不是生产发布或完整验收声明。

## 来源与许可

本 Demo 基于 COMP5703 团队项目及后续本地 Plan B 集成开发。原贡献者、客户及第三方依赖的权利仍由各自权利人保留，完整开发历史保存在私有本地副本中。

采用 [View-Only Source License](LICENSE)，**不是开源许可证**。除法律、平台条款或另行书面授权允许的情况外，不授予修改、再分发、部署或商业使用权限。

**公开 GitHub 仓库无法禁止站内 fork。** 本许可证不能覆盖 GitHub 授予的公开仓库查看／fork 权利；除该平台权限外，不另行授予衍生使用权。参见 [GitHub 条款](https://docs.github.com/en/site-policy/github-terms/github-terms-of-service#5-license-grant-to-other-users)。
