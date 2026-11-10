# 工作交接模板

把下列短文本作为房间消息使用；它是技能层约定，不是服务原生状态迁移。详细结果采用 `work-result/v1`，用引用减少重复文本。

```text
kind: work_handoff
request_id: <本次交接的稳定ID>
in_reply_to: <原请求ID>
work_id: <权威工作记录ID>
from: <交出者稳定ID>
to: <接收者稳定ID>
subject: <对象ID与被检查/修改的确切版本>
state: <已完成/待验证/阻塞/取消待确认；以权威记录为准>
result: <work-result/v1 文件或记录位置>
evidence: <最少但足够的证据ID与位置>
unresolved: <剩余问题、已知副作用、未验证能力>
next_action: <下一步及建议负责人>
record: <权威工作记录及当前修订>
```

由接收者核对记录、对象版本、已有副作用和职责后确认交接；由协调者或具备原子能力的权威系统更新归属。收到普通交接消息不自动转移所有权，不批准合并、发布或对外发送。
