# 工作请求模板

把下列短文本复制进已授权的房间消息，替换尖括号。它是参与者约定，不是房间服务原生 Task、租约或调度 API；不要把文字中的 owner 当成硬锁。

```text
kind: work_request
request_id: <本次请求的稳定ID；重发沿用>
work_id: <权威工作记录ID>
run_id: <本次执行ID>
spec_ref: <共享Spec位置与有效修订；小任务可写等价约束位置>
ticket_ref: <本次Ticket身份；无票时写工作单元身份>
acceptance_ids: <对应验收条目>
depends_on: <前置任务或产物、版本及已满足的释放条件>
from: <稳定参与者ID>
to: <稳定参与者ID>
role: <本次职责与选用worker或等价方法>
objective: <要得到的可验收结果>
scope: <允许修改/读取的对象及边界>
subject: <仓库/设计/模型/问题ID与固定版本>
workspace: <实际工作目录；并行写入使用独立目录，无写入则写只读>
branch: <Git 分支；基线见 subject，非 Git 可省略>
shared_resources: <实际使用的共享接口或环境及协调约定；无则省略>
owner: <权威工作记录里已分配的负责人>
authority_ref: <用户已有授权或委托记录；不附加权限>
constraints: <预算、截止、依赖、禁止越过的边界>
deliverables: <应交回的候选或产物>
completion_condition: <本次职责的完成条件和所需证据>
reply_to: <结果位置或稳定参与者ID>
record: <可恢复的权威工作记录位置>
```

只要求接收者确认接收、拒绝或给出阻塞原因；用工作交接模板报告结果。先把请求及去重状态写入可恢复工作记录，再确认消息。消息 ACK 不等于同意接单，更不等于工作完成。
