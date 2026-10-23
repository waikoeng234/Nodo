# 参与贡献

简体中文 | [English](CONTRIBUTING.en.md)

感谢你愿意改进 Nodo。问题反馈、文档修正、Bug 修复、新 Agent 接入都欢迎。

## 反馈问题

提交 Issue 前，请先搜索是否已有相同的问题。新 Issue 请写明：

- 复现步骤，以及预期结果和实际结果；
- 操作系统、dsh、Nodo 和相关 Agent 的版本；
- 必要的日志或截图。

日志和截图请先脱敏，不要附带 API 密钥、令牌、Cookie、认证配置或插件数据目录的内容。


## 提出功能建议

请在 Issue 中说明要解决的问题和使用场景，而不只是想要的实现方式。

Nodo 只使用各 Agent 公开的接口。需要修改 Agent 程序本身，或依赖其私有接口的功能，不会被接受。

## 提交代码

1. **先开 Issue 讨论。** 新增依赖、改公共接口或数据格式、较大的功能改动，请先开 Issue 确认方向。小的修复和文档修改可以直接提交 PR。
2. **Fork 并创建分支。** 从 `main` 创建分支，一个 PR 只做一件事，不要夹带无关的格式化或重构。
3. **开发与测试。** 环境、构建、测试和代码约定见[开发指南（英文）](docs/development.md)，代码结构见[架构说明（英文）](docs/architecture.md)。新增或扩展 Agent 请按 [Agent 接入流程（英文）](orchestrator/agent-drivers/ENGINE_INTAKE.md) 进行。
4. **修改客户端时重新构建。** 改了 `src/client/` 或 `src/shared/` 后运行 `npm run build`，把生成的 `client.js` 一起提交。
5. **提交 PR。** 在 PR 中说明：
   - 改动范围和原因，以及关联的 Issue；
   - 运行过的测试及结果；
   - 是否做过真实 Agent 或宿主界面验证，没做过请写明。

## 许可证

提交到本仓库的贡献按 [Apache-2.0](LICENSE) 许可证授权，与项目本身一致。
