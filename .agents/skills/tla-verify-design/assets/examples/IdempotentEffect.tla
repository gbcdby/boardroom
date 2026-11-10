------------------------ MODULE IdempotentEffect ------------------------
EXTENDS Naturals, FiniteSets
CONSTANTS Clients, AtomicCommit
VARIABLES phase, applied, effects
vars == <<phase, applied, effects>>

\* Each client makes one attempt for the SAME logical operation key.
\* AtomicCommit models a conditional durable record and its local effect
\* committed atomically. It does not assume remote side effects are atomic.
\* Scope: finite attempts, no crashes; weak fairness lets each client run.
ASSUME /\ IsFiniteSet(Clients) /\ Clients # {}
       /\ AtomicCommit \in BOOLEAN

Init == /\ phase = [c \in Clients |-> "check"]
        /\ applied = FALSE
        /\ effects = 0

Check(c) == /\ phase[c] = "check"
            /\ phase' = [phase EXCEPT ![c] = IF applied THEN "done" ELSE "apply"]
            /\ UNCHANGED <<applied, effects>>

Apply(c) == /\ phase[c] = "apply"
            /\ phase' = [phase EXCEPT ![c] = "done"]
            /\ IF AtomicCommit /\ applied
                  THEN UNCHANGED <<applied, effects>>
                  ELSE /\ applied' = TRUE
                       /\ effects' = effects + 1

Step(c) == Check(c) \/ Apply(c)
AllComplete == \A c \in Clients : phase[c] = "done"
Done == AllComplete /\ UNCHANGED vars
Next == (\E c \in Clients : Step(c)) \/ Done
Spec == Init /\ [][Next]_vars
        /\ (\A c \in Clients : WF_vars(Step(c)))

TypeOK == /\ phase \in [Clients -> {"check", "apply", "done"}]
          /\ applied \in BOOLEAN
          /\ effects \in 0..Cardinality(Clients)
AtMostOnce == effects <= 1
EventuallyDone == <>AllComplete
=============================================================================
