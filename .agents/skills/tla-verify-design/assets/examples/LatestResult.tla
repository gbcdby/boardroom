---------------------------- MODULE LatestResult ----------------------------
EXTENDS Naturals, FiniteSets
CONSTANTS Requests, RejectStale
VARIABLES pending, delivered, committed
vars == <<pending, delivered, committed>>

\* Requests are positive revision numbers whose responses may arrive in
\* any order. Preserve the highest DELIVERED revision, not latest issued.
\* Scope: finitely many responses, no loss; weak fairness guarantees each
\* pending response is eventually processed. No wall-clock bound is claimed.
ASSUME /\ IsFiniteSet(Requests) /\ Requests # {}
       /\ Requests \subseteq (Nat \ {0})
       /\ RejectStale \in BOOLEAN

MaxOf(S) == CHOOSE m \in S : \A x \in S : x <= m
Init == /\ pending = Requests
        /\ delivered = {}
        /\ committed = 0

Respond(r) == /\ r \in pending
              /\ pending' = pending \ {r}
              /\ delivered' = delivered \cup {r}
              /\ committed' = IF ~RejectStale \/ r > committed
                                 THEN r ELSE committed

AllComplete == pending = {}
Done == AllComplete /\ UNCHANGED vars
Next == (\E r \in Requests : Respond(r)) \/ Done
Spec == Init /\ [][Next]_vars
        /\ (\A r \in Requests : WF_vars(Respond(r)))

TypeOK == /\ pending \subseteq Requests
          /\ delivered \subseteq Requests
          /\ pending \cap delivered = {}
          /\ pending \cup delivered = Requests
          /\ committed \in Requests \cup {0}
ResultMatchesLatestAccepted == committed = MaxOf({0} \cup delivered)
EventuallyDone == <>AllComplete
=============================================================================
