---- MODULE DeliveryLedger ----
EXTENDS FiniteSets, Naturals

\* S8 #314 统一消费账本的有限抽象。只检查协议层安全性质，不代表实现已评估。
\* 来源：#312/#314 票面及设计基线；状态边界为设计拟议，实现机制未评估。
\* Claim 携带当前 modeEpoch；已 assigned 的 WorkItem 仍可能收到重复领取尝试，
\* 互斥由 DuplicateAllowed=FALSE 一侧的 claims 守卫表达，是待落实的实现义务。
\* Observe 只接受当前 epoch 且属于当前 owner 的 claim，旧代际由 StaleArrival 表达。
\* ReplyGuardEnabled / UnknownGuardEnabled / StaleGuardEnabled 是配置级隔离开关：
\* fixed 与既有错误变体保持 TRUE；各自错误变体只关闭其中一个；性质名和死锁检查在所有配置中不变。
\* staleEffect 是 R4 诊断位：fixed 所有动作保持 FALSE；只有关闭 StaleGuardEnabled 的
\* bug-stale-arrival 变体在旧代际到达写状态/Reply 时置 TRUE，用于验证 NoStaleEffect 的敏感性。

CONSTANTS W, C, E, G, DuplicateAllowed, ReplyGuardEnabled, UnknownGuardEnabled, StaleGuardEnabled

VARIABLES status, outcome, owner, claims, replyCount, modeEpoch, fenced, staleEffect

vars == <<status, outcome, owner, claims, replyCount, modeEpoch, fenced, staleEffect>>

\* fixed 语义下该上界由 PublishReply 守卫保证不可到达；放宽为 2 只为隔离错误变体提供有限反例。
ReplyLimit == IF ReplyGuardEnabled THEN 1 ELSE 2

TypeOK ==
  /\ status \in [W -> {"none", "pending", "assigned", "handled", "needs_attention"}]
  /\ outcome \in [W -> {"none", "success", "failure", "unknown"}]
  /\ owner \in [W -> {"none"} \cup C]
  /\ claims \subseteq {r \in [wi: W, ch: C, ep: E, gen: G] : TRUE}
  /\ replyCount \in [W -> 0..2]
  /\ modeEpoch \in E
  /\ fenced \in [C -> BOOLEAN]
  /\ staleEffect \in BOOLEAN

Init ==
  /\ status = [w \in W |-> "none"]
  /\ outcome = [w \in W |-> "none"]
  /\ owner = [w \in W |-> "none"]
  /\ claims = {}
  /\ replyCount = [w \in W |-> 0]
  /\ modeEpoch = 0
  /\ fenced = [c \in C |-> FALSE]
  /\ staleEffect = FALSE

Receive(w) ==
  /\ status[w] = "none"
  /\ status' = [status EXCEPT ![w] = "pending"]
  /\ UNCHANGED <<outcome, owner, claims, replyCount, modeEpoch, fenced, staleEffect>>

Claim(w, c, e, g) ==
  /\ status[w] \in {"pending", "assigned"}
  /\ c \in C /\ e \in E /\ g \in G
  /\ e = modeEpoch
  /\ ~fenced[c]
  /\ (DuplicateAllowed \/ \A r \in claims: r.wi # w)
  /\ claims' = claims \cup {[wi |-> w, ch |-> c, ep |-> e, gen |-> g]}
  /\ status' = [status EXCEPT ![w] = "assigned"]
  /\ owner' = [owner EXCEPT ![w] = c]
  /\ UNCHANGED <<outcome, replyCount, modeEpoch, fenced, staleEffect>>

Observe(w, c, e, g, res) ==
  /\ status[w] = "assigned"
  /\ owner[w] = c
  /\ e = modeEpoch
  /\ \E r \in claims: r.wi = w /\ r.ch = c /\ r.ep = e /\ r.gen = g
  /\ res \in {"success", "failure", "unknown"}
  /\ CASE res = "success" ->
          /\ status' = [status EXCEPT ![w] = "handled"]
          /\ outcome' = [outcome EXCEPT ![w] = "success"]
       [] res = "failure" ->
          /\ status' = [status EXCEPT ![w] = "needs_attention"]
          /\ outcome' = [outcome EXCEPT ![w] = "failure"]
       [] res = "unknown" ->
          /\ status' = IF UnknownGuardEnabled THEN status ELSE [status EXCEPT ![w] = "needs_attention"]
          /\ outcome' = [outcome EXCEPT ![w] = "unknown"]
  /\ UNCHANGED <<owner, claims, replyCount, modeEpoch, fenced, staleEffect>>

PublishReply(w) ==
  /\ status[w] = "handled"
  /\ replyCount[w] < ReplyLimit
  /\ replyCount' = [replyCount EXCEPT ![w] = @ + 1]
  /\ UNCHANGED <<status, outcome, owner, claims, modeEpoch, fenced, staleEffect>>

StaleArrival(w, c, e, g, res) ==
  /\ \E r \in claims: r.wi = w /\ r.ch = c /\ r.ep = e /\ r.gen = g
  /\ e < modeEpoch
  /\ res \in {"success", "failure", "unknown"}
  /\ IF StaleGuardEnabled
     THEN UNCHANGED vars
     ELSE /\ (CASE res = "success" ->
                  /\ status' = [status EXCEPT ![w] = "handled"]
                  /\ outcome' = [outcome EXCEPT ![w] = "success"]
               [] res = "failure" ->
                  /\ status' = [status EXCEPT ![w] = "needs_attention"]
                  /\ outcome' = [outcome EXCEPT ![w] = "failure"]
               [] res = "unknown" ->
                  /\ status' = [status EXCEPT ![w] = "needs_attention"]
                  /\ outcome' = [outcome EXCEPT ![w] = "unknown"])
          /\ replyCount' = [replyCount EXCEPT ![w] = @ + 1]
          /\ staleEffect' = TRUE
          /\ UNCHANGED <<owner, claims, modeEpoch, fenced>>

SwitchMode(e2, cNew) ==
  /\ e2 \in E /\ cNew \in C
  /\ e2 > modeEpoch
  /\ modeEpoch' = e2
  /\ fenced' = [c \in C |-> c # cNew]
  /\ UNCHANGED <<status, outcome, owner, claims, replyCount, staleEffect>>

\* 合法终态：所有 WorkItem 已 handled/needs_attention，且 E 中无更高 epoch 可切换。
\* needs_attention 的人工介入与对账在模型外，这里只提供终态自环，不放宽任何性质。
Terminal ==
  /\ \A w \in W: status[w] \in {"handled", "needs_attention"}
  /\ \A e2 \in E: e2 <= modeEpoch
  /\ UNCHANGED vars

Next ==
  \/ \E w \in W: Receive(w)
  \/ \E w \in W, c \in C, e \in E, g \in G: Claim(w, c, e, g)
  \/ \E w \in W, c \in C, e \in E, g \in G, r \in {"success", "failure", "unknown"}: Observe(w, c, e, g, r)
  \/ \E w \in W: PublishReply(w)
  \/ \E w \in W, c \in C, e \in E, g \in G, r \in {"success", "failure", "unknown"}: StaleArrival(w, c, e, g, r)
  \/ \E e2 \in E, cNew \in C: SwitchMode(e2, cNew)
  \/ Terminal

Spec == Init /\ [][Next]_vars

NoDoubleClaim == \A w \in W: Cardinality({r \in claims: r.wi = w}) <= 1
AtMostOneReply == \A w \in W: replyCount[w] <= 1
ReplyMatchesDisposition == \A w \in W: replyCount[w] = 1 => status[w] = "handled"
UnknownStaysAssigned == \A w \in W: outcome[w] = "unknown" => status[w] = "assigned"
NoStaleHandled == \A w \in W: status[w] = "handled" => \E r \in claims: r.wi = w /\ r.ep <= modeEpoch
\* R4：旧代际/迟到响应不得产生状态或 Reply 效果；诊断位仅由隔离错误变体置位。
NoStaleEffect == staleEffect = FALSE
=============================================================================
