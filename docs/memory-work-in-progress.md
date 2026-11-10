# 阶段 4 未交付准备候选

2026-11-11（Asia/Shanghai）。此分支只保存已发生的准备工作，**不是完成的阶段 4，也不是共享 Spec/Ticket 的替代来源**。主 Spec 仍为 GitHub #1；正式阶段 4 Spec 与 Tickets 尚未创建。根据用户指定的 auto 0.5.1，新业务实现已暂停，等待共享记录缺口解除。

已保存：三层记忆 DTO、v12 和部分仓储/来源扫描、有效配置和 Unicode 预算、专属只读注入子进程及定向测试。原作者候选为 32f3d72、b76316e、9ab86aa、27a54c3；这里只集成这些既有内容，没有继续实现服务和页面。

明确缺口：MemoryService/领域 ACL/请求状态机/三种触发、HTTP/MCP 与安全点接线、真正 MCP 投递标记接线、记忆 UI、PG 镜像和 BUSINESS_TABLES/copy/purge 适配、完整恢复/隔离测试均未完成。现有 migrate-data 测试已发现 PG mirror schemaVersion 仍为 11、v12 未同步；不得把其他空 fixture 的通过当作记忆 copy 验收。

已有关联自查只证明候选片段：配置/Unicode、SQLite 仓储和只读 helper 可运行；helper 实际原生阻塞隔离不等于生产 MCP、ACK/status 全链验收。真实 PostgreSQL 锁测试和目标 Agent 自总结尚未执行，整体未通过独立双轴审查。原生 CLI 环境门槛继续保留。

恢复前：回读正式共享记录和实际主线，核对本分支及设计修订；先补齐生命周期/复制和领域接口，再按固定依赖推进。最终阶段 4 使用独立 PR，经规定验收和审查后按既有授权合并；本检查点不能部署或用于验收完成声明。
