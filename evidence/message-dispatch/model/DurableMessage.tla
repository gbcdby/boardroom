---------------- MODULE DurableMessage ----------------
EXTENDS Naturals, FiniteSets
CONSTANTS Workers, SameSender, AtomicBundle, RecheckKey, DurableKey, FilterWake
VARIABLES phase, observed, epoch, messages, dedup, deliveries, acked,
          pendingHint, hintCount, replies, selected, crashed, lostHint,
          duplicateSeen, recoveredPoll, suppressedAck
vars == <<phase, observed, epoch, messages, dedup, deliveries, acked,
          pendingHint, hintCount, replies, selected, crashed, lostHint,
          duplicateSeen, recoveredPoll, suppressedAck>>
Keys == IF SameSender THEN {"shared"} ELSE Workers
Key(w) == IF SameSender THEN "shared" ELSE w
Ids == Workers \X (0..1)
Recipients == {"allowed", "suppressed", "visible"}
NoId == <<"none", 0>>
MsgKey(m) == Key(m[1])
Query == {d \in deliveries : (IF FilterWake THEN d[2] = "allowed" ELSE TRUE) /\ d \notin acked}
Init == /\ phase = [w \in Workers |-> "read"]
        /\ observed = [w \in Workers |-> NoId]
        /\ epoch = 0
        /\ messages = {}
        /\ dedup = [k \in Keys |-> NoId]
        /\ deliveries = {}
        /\ acked = {}
        /\ pendingHint = [w \in Workers |-> NoId]
        /\ hintCount = [m \in Ids |-> 0]
        /\ replies = {}
        /\ selected = {}
        /\ crashed = FALSE
        /\ lostHint = FALSE
        /\ duplicateSeen = FALSE
        /\ recoveredPoll = FALSE
        /\ suppressedAck = FALSE
Read(w) == /\ phase[w] = "read"
           /\ phase' = [phase EXCEPT ![w] = "commit"]
           /\ observed' = [observed EXCEPT ![w] = dedup[Key(w)]]
           /\ UNCHANGED <<epoch, messages, dedup, deliveries, acked,
                pendingHint, hintCount, replies, selected, crashed, lostHint,
                duplicateSeen, recoveredPoll, suppressedAck>>
Commit(w) ==
  /\ phase[w] = "commit"
  /\ LET old == IF RecheckKey THEN dedup[Key(w)] ELSE observed[w]
         fresh == <<w, epoch>>
     IN IF old # NoId
        THEN /\ phase' = [phase EXCEPT ![w] = "done"]
             /\ replies' = replies \cup {<<Key(w), old>>}
             /\ duplicateSeen' = TRUE
             /\ UNCHANGED <<messages, dedup, deliveries, pendingHint>>
        ELSE /\ phase' = [phase EXCEPT ![w] = IF AtomicBundle THEN "notify" ELSE "half"]
             /\ messages' = messages \cup {fresh}
             /\ dedup' = [dedup EXCEPT ![Key(w)] = fresh]
             /\ deliveries' = IF AtomicBundle
                    THEN deliveries \cup ({fresh} \X Recipients) ELSE deliveries
             /\ pendingHint' = [pendingHint EXCEPT ![w] = fresh]
             /\ UNCHANGED <<replies, duplicateSeen>>
  /\ UNCHANGED <<observed, epoch, acked, hintCount, selected, crashed,
                 lostHint, recoveredPoll, suppressedAck>>
FinishHalf(w) == /\ phase[w] = "half"
                /\ phase' = [phase EXCEPT ![w] = "notify"]
                /\ deliveries' = deliveries \cup ({pendingHint[w]} \X Recipients)
                /\ UNCHANGED <<observed, epoch, messages, dedup, acked,
                     pendingHint, hintCount, replies, selected, crashed,
                     lostHint, duplicateSeen, recoveredPoll, suppressedAck>>
Notify(w) == /\ phase[w] = "notify"
             /\ phase' = [phase EXCEPT ![w] = "reply"]
             /\ hintCount' = [hintCount EXCEPT ![pendingHint[w]] = @ + 1]
             /\ UNCHANGED <<observed, epoch, messages, dedup, deliveries, acked,
                  pendingHint, replies, selected, crashed, lostHint,
                  duplicateSeen, recoveredPoll, suppressedAck>>
Reply(w) == /\ phase[w] = "reply"
            /\ phase' = [phase EXCEPT ![w] = "done"]
            /\ replies' = replies \cup {<<Key(w), pendingHint[w]>>}
            /\ pendingHint' = [pendingHint EXCEPT ![w] = NoId]
            /\ UNCHANGED <<observed, epoch, messages, dedup, deliveries, acked,
                 hintCount, selected, crashed, lostHint, duplicateSeen,
                 recoveredPoll, suppressedAck>>
Crash == /\ ~crashed
         /\ phase' = [w \in Workers |-> "offline"]
         /\ observed' = [w \in Workers |-> NoId]
         /\ dedup' = IF DurableKey THEN dedup ELSE [k \in Keys |-> NoId]
         /\ pendingHint' = [w \in Workers |-> NoId]
         /\ selected' = {}
         /\ crashed' = TRUE
         /\ lostHint' = \E w \in Workers : phase[w] = "notify"
         /\ UNCHANGED <<epoch, messages, deliveries, acked, hintCount,
              replies, duplicateSeen, recoveredPoll, suppressedAck>>
Recover == /\ \A w \in Workers : phase[w] = "offline"
           /\ epoch' = 1
           /\ phase' = [w \in Workers |-> "read"]
           /\ UNCHANGED <<observed, messages, dedup, deliveries, acked,
                pendingHint, hintCount, replies, selected, crashed, lostHint,
                duplicateSeen, recoveredPoll, suppressedAck>>
Poll(d) == /\ ~(\A w \in Workers : phase[w] = "offline")
           /\ d \in Query \ selected
           /\ selected' = selected \cup {d}
           /\ recoveredPoll' = (recoveredPoll \/ (epoch = 1 /\ lostHint))
           /\ UNCHANGED <<phase, observed, epoch, messages, dedup,
                deliveries, acked, pendingHint, hintCount, replies, crashed,
                lostHint, duplicateSeen, suppressedAck>>
Ack(d) == /\ d \in deliveries \ acked
          /\ acked' = acked \cup {d}
          /\ selected' = selected \ {d}
          /\ suppressedAck' = (suppressedAck \/ d[2] = "suppressed")
          /\ UNCHANGED <<phase, observed, epoch, messages, dedup, deliveries,
               pendingHint, hintCount, replies, crashed, lostHint,
               duplicateSeen, recoveredPoll>>
Terminal == /\ crashed
            /\ \A w \in Workers : phase[w] = "done"
            /\ acked = deliveries
Done == Terminal /\ UNCHANGED vars
Next == (\E w \in Workers : Read(w) \/ Commit(w) \/ FinishHalf(w) \/ Notify(w) \/ Reply(w))
        \/ Crash \/ Recover
        \/ (\E d \in deliveries : Poll(d) \/ Ack(d))
        \/ Done
Spec == Init /\ [][Next]_vars
TypeOK == /\ phase \in [Workers -> {"read", "commit", "half", "notify", "reply", "done", "offline"}]
          /\ observed \in [Workers -> Ids \cup {NoId}]
          /\ epoch \in 0..1
          /\ messages \subseteq Ids
          /\ dedup \in [Keys -> Ids \cup {NoId}]
          /\ deliveries \subseteq Ids \X Recipients
          /\ acked \subseteq deliveries
          /\ pendingHint \in [Workers -> Ids \cup {NoId}]
          /\ hintCount \in [Ids -> 0..2]
          /\ replies \subseteq Keys \X Ids
          /\ selected \subseteq deliveries
          /\ crashed \in BOOLEAN /\ lostHint \in BOOLEAN
          /\ duplicateSeen \in BOOLEAN /\ recoveredPoll \in BOOLEAN
          /\ suppressedAck \in BOOLEAN
AtMostOneMessage == \A k \in Keys : Cardinality({m \in messages : MsgKey(m) = k}) <= 1
CompleteEnvelope == deliveries = messages \X Recipients
StableReply == \A r \in replies : r[2] \in messages /\ MsgKey(r[2]) = r[1]
DurableKeyMatches == \A k \in Keys : dedup[k] # NoId => dedup[k] \in messages /\ MsgKey(dedup[k]) = k
OnlyAllowedWake == \A d \in selected : d[2] = "allowed" /\ d \notin acked
AtMostOneHint == \A m \in Ids : hintCount[m] <= 1
HintAfterCommit == \A m \in Ids : hintCount[m] > 0 => m \in messages /\ ({m} \X Recipients) \subseteq deliveries
NoConcurrentAbsentReads == ~(\A w \in Workers : phase[w] = "commit" /\ observed[w] = NoId)
NoRecoveryWitness == ~(lostHint /\ recoveredPoll /\ duplicateSeen /\ suppressedAck)
=========================================================
