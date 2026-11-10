# 工作取消模板

区分取消请求与停止确认。复制到已授权房间，保留稳定请求ID；不要把发送成功或消息 ACK 写成“已停止”。这两段均不是原生 interrupt API。

```text
kind: cancel_request
request_id: <稳定取消请求ID>
work_id: <权威工作记录ID>
to: <当前负责人稳定ID>
authority_ref: <取消此工作的已有权限依据>
stop_scope: <停止哪些后续动作>
reason: <目标变化或风险事实>
record: <权威工作记录位置>
```

```text
kind: cancel_ack
request_id: <本次确认ID>
in_reply_to: <取消请求ID>
work_id: <权威工作记录ID>
state: <STOPPED_AT_SAFE_POINT / STOP_PENDING / CANNOT_CONFIRM>
last_safe_point: <已确认停止的位置与时间>
inflight_effects: <仍在执行或结果未知的外部动作>
completed_effects: <取消前已完成的副作用与证据>
next_action: <核对结果/补偿/人工决策；不擅自回滚>
record: <权威工作记录位置>
```

无法在途打断时，在下一个安全点停止新动作并报告现状。副作用结果未知时先核对外部事实；没有持久幂等依据，不自动重试或回滚。
