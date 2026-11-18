----------------------------- MODULE C3Protocol -----------------------------
EXTENDS Naturals, Sequences, FiniteSets, TLC

(***************************************************************************
 C3-AC50 design/check only. Native p/q are distinct, single-use OS incarnations.
 DB commit, caller response, source close, cleanup, exit and gateway delivery
 are separate actions. No fairness is imposed on an unknown transaction/exit.
 Fault selects an isolated model mutation; production profiles use "none".
 All references/typed/frozen values are abstract equality tokens, not codecs.
 The first failure value is distinguished; later payloads are one abstract
 value, with each separate occurrence retained in the sequence (no dedup).
***************************************************************************)
CONSTANTS InitialPhase, FirstOperation, SecondOperation, SecondMode,
          Qualified, TypedBinding, AllowFaults, SerialStarts,
          MaxCommits, MaxFaults, Fault

P == {"p", "q"}
NoOwner == "none"
WriteEvents == {"enter", "first", "takeover", "recapture", "ready", "intent", "terminal"}
SnapshotEvents == {"restore", "guard", "replay"}
Phases == {"planned", "quiesced", "ready", "open"}
Request(k, op, epoch, head) == [key |-> k, op |-> op, epoch |-> epoch, head |-> head, digest |-> op]
EmptyRequest == Request("none", "none", 0, 0)
EmptyRows == [p \in {} |-> [identity |-> p, epoch |-> 0, ended |-> FALSE]]
RawRows(d) == [p \in d.rows |-> [identity |-> p, epoch |-> d.rowEpoch[p], ended |-> p \in d.ended]]
Token(d) == [migration |-> d.migration, epoch |-> d.epoch, head |-> d.head, gen |-> d.gen,
             phase |-> d.phase, admission |-> d.admission, active |-> d.active, cancel |-> d.cancel,
             hasOrigin |-> d.hasOrigin, origin |-> d.origin, selected |-> d.selected,
             rows |-> RawRows(d), originRows |-> d.originRows,
             frozen |-> d.frozen, receipt |-> d.receipt, readyClosure |-> d.readyClosure]
EmptyToken == [migration |-> 0, epoch |-> 0, head |-> 0, gen |-> 0,
                phase |-> "planned", admission |-> "draining", active |-> FALSE, cancel |-> FALSE,
                hasOrigin |-> FALSE, origin |-> 0, selected |-> 0,
                rows |-> EmptyRows, originRows |-> EmptyRows,
                frozen |-> 0, receipt |-> 0, readyClosure |-> FALSE]

VARIABLES db, w, mutex, sources, history, commits, observations
vars == <<db, w, mutex, sources, history, commits, observations>>
FaultCount == Cardinality(observations \cap {"fault-1", "fault-2"})
FaultAllowed == AllowFaults /\ FaultCount < MaxFaults

InitControl == [migration |-> 1, epoch |-> 1, gen |-> 1, head |-> 0,
  phase |-> IF InitialPhase = "pending" THEN "quiesced" ELSE InitialPhase, admission |-> IF InitialPhase = "planned" THEN "draining" ELSE "sealed",
  active |-> TRUE, cancel |-> InitialPhase = "pending", hasOrigin |-> InitialPhase # "planned",
  origin |-> 0, receipt |-> 1, frozen |-> IF InitialPhase = "planned" THEN 0 ELSE 1,
  originRows |-> EmptyRows, rows |-> {}, ended |-> {}, rowEpoch |-> [p \in P |-> 0],
  selected |-> 0, readyClosure |-> InitialPhase = "ready"]
\* Initial sealed profiles assume a legal historical capture/ready/intent prefix.
\* Its immutable S/Md is quiesced; later ready/intent changes only the live H.
InitArchive == IF InitialPhase = "planned" THEN EmptyToken ELSE
  Token([InitControl EXCEPT !.phase = "quiesced", !.cancel = FALSE, !.readyClosure = FALSE])
InitDB == [field \in (DOMAIN InitControl) \cup {"selectedControl"} |->
  IF field = "selectedControl" THEN InitArchive ELSE InitControl[field]]

EmptyWorker == [life |-> "idle", pc |-> "idle", request |-> EmptyRequest,
  todo |-> "none", validated |-> FALSE, replay |-> FALSE, matched |-> FALSE,
  factory |-> "bootstrap", window |-> 0, proofWindow |-> 0, proof |-> EmptyToken,
  before |-> InitDB, proposed |-> InitDB, published |-> FALSE,
  tx |-> "none", ack |-> "none", committed |-> FALSE,
  registrationAck |-> FALSE, registrationClosed |-> FALSE,
  sourceClosed |-> TRUE, closeUnknown |-> FALSE, restored |-> EmptyToken, restoredLive |-> EmptyToken,
  restoreExpectedArchive |-> EmptyToken, restoreExpectedLive |-> EmptyToken,
  replayHead |-> 0, replayHistory |-> <<>>,
  restoreStep |-> 0, guard |-> FALSE, guardWindow |-> 0,
  failed |-> FALSE, firstError |-> "none", errors |-> <<>>, cleanupErrors |-> 0,
  cleanupDone |-> FALSE, frame |-> FALSE, reaped |-> FALSE, delivered |-> FALSE,
  result |-> "none", lateCommit |-> FALSE]

Init == /\ db = InitDB
        /\ w = [p \in P |-> EmptyWorker]
        /\ mutex = NoOwner /\ sources = {} /\ history = <<>>
        /\ commits = <<>> /\ observations = {}

Error(x, value) == [x EXCEPT !.failed = TRUE,
  !.firstError = IF ~x.failed THEN value ELSE x.firstError,
  !.errors = Append(@, IF x.failed THEN "later-error" ELSE value), !.factory = "invalid", !.guard = FALSE]

BeginRequest(p) ==
  LET op == IF p = "p" THEN FirstOperation ELSE SecondOperation
      mode == IF p = "p" THEN "new" ELSE SecondMode
      req == IF mode = "same" THEN w["p"].request
             ELSE IF mode = "conflict" THEN [w["p"].request EXCEPT !.digest = "conflicting-input"]
             ELSE IF mode = "stale" THEN Request(p, op, w["p"].request.epoch, w["p"].request.head)
             ELSE Request(p, op, db.epoch, db.head)
  IN /\ w[p].life = "idle"
     /\ (p = "p" \/ w["p"].life # "idle")
     /\ (~SerialStarts \/ p = "p" \/ w["p"].reaped)
     /\ w' = [w EXCEPT ![p] = [@ EXCEPT !.life = "live", !.pc = "mutex", !.request = req]]
     /\ UNCHANGED <<db, mutex, sources, history, commits, observations>>

AcquireMutex(p) ==
  /\ w[p].life = "live" /\ ~w[p].failed /\ w[p].pc = "mutex" /\ mutex = NoOwner
  /\ mutex' = p /\ w' = [w EXCEPT ![p].pc = "source"]
  /\ UNCHANGED <<db, sources, history, commits, observations>>

AcquireSource(p) ==
  /\ w[p].life = "live" /\ ~w[p].failed /\ w[p].pc = "source" /\ mutex = p
  /\ (sources = {} \/ Fault = "overlap-source")
  /\ w[p].window < MaxCommits + 3
  /\ sources' = sources \cup {p}
  /\ w' = [w EXCEPT ![p] = [@ EXCEPT !.pc = "facts", !.tx = "open",
      !.sourceClosed = FALSE, !.window = @ + 1, !.ack = "none", !.committed = FALSE,
      !.published = FALSE, !.restoreStep = 0, !.before = db, !.proposed = db]]
  /\ UNCHANGED <<db, mutex, history, commits, observations>>

Existing(key) == {i \in 1..Len(history) : history[i].key = key}
LastRequestMatches(p) == Existing(w[p].request.key) # {}
  /\ history[Len(history)].key = w[p].request.key
  /\ (Fault = "replay-digest" \/
        (\A i \in Existing(w[p].request.key) : history[i].digest = w[p].request.digest))
  /\ \A i \in (CHOOSE j \in Existing(w[p].request.key) :
        \A k \in Existing(w[p].request.key) : j <= k)..Len(history) :
        history[i].key = w[p].request.key
NativeRowsSafe(p) == \A q \in db.rows \ {p} : w[q].life = "exited"
ConsumerRowsSafe(p) == NativeRowsSafe(p) /\ (db.rows \ {p}) \subseteq db.ended
  /\ (p \in db.rows => w[p].factory = "registered")
InitialEvent(p) ==
  IF w[p].request.op = "cancel" THEN "takeover"
  ELSE IF db.phase = "open" THEN "enter"
  ELSE IF db.phase = "planned" THEN "first"
  ELSE "takeover"

Promote(p) ==
  /\ w[p].life = "live" /\ ~w[p].failed /\ w[p].factory = "staged"
  /\ ((w[p].pc = "facts" /\ p \in sources /\ mutex = p
       /\ p \in db.rows /\ w[p].registrationAck /\ w[p].registrationClosed)
      \/ (Fault = "early-promotion" /\ w[p].tx = "submitted"))
  /\ w' = [w EXCEPT ![p].factory = "registered"]
  /\ UNCHANGED <<db, mutex, sources, history, commits, observations>>

ReadFacts(p) ==
  LET already == Existing(w[p].request.key) # {}
      expected == w[p].request.epoch = db.epoch /\ w[p].request.head = db.head
      valid == Qualified /\ TypedBinding /\ NativeRowsSafe(p)
        /\ (w[p].validated \/
             IF already THEN LastRequestMatches(p) /\ ConsumerRowsSafe(p)
             ELSE ((expected \/ Fault = "stale-request")
               /\ (w[p].request.op # "cancel" \/ db.phase \in {"quiesced", "ready"})
               /\ (w[p].request.op # "guard" \/ db.phase = "ready")))
      replaying == ~w[p].validated /\ already
      ev == IF replaying THEN "replay" ELSE IF w[p].validated THEN w[p].todo ELSE InitialEvent(p)
      next == [w[p] EXCEPT !.validated = TRUE, !.replay = replaying \/ @,
          !.matched = IF w[p].validated THEN @ ELSE expected \/ replaying,
          !.todo = ev, !.proof = Token(db), !.proofWindow = w[p].window,
          !.before = db, !.pc = IF ev \in SnapshotEvents THEN "effect" ELSE "prepare"]
  IN /\ w[p].life = "live" /\ ~w[p].failed /\ w[p].pc = "facts"
     /\ p \in sources /\ mutex = p
     /\ (w[p].factory # "staged" \/ ~w[p].registrationAck)
     /\ w' = [w EXCEPT ![p] = IF valid THEN next
          ELSE [Error(@, "rejected-facts") EXCEPT !.pc = "abort"]]
     /\ UNCHANGED <<db, mutex, sources, history, commits, observations>>

Candidate(p, ev) ==
  LET d == db
      common == [d EXCEPT !.head = Len(history) + 1]
  IN CASE ev = "enter" -> [common EXCEPT !.migration = @ + 1, !.epoch = @ + 1,
         !.gen = @ + 1, !.phase = "planned", !.admission = "draining", !.active = TRUE,
         !.cancel = FALSE, !.hasOrigin = FALSE, !.frozen = 0, !.readyClosure = FALSE,
         !.selectedControl = EmptyToken]
     [] ev = "first" -> LET captured == [common EXCEPT !.phase = "quiesced", !.admission = "sealed",
         !.hasOrigin = TRUE, !.origin = Len(history) + 1, !.receipt = d.gen,
         !.frozen = d.migration, !.originRows = RawRows(d), !.selected = Len(history) + 1]
        IN [captured EXCEPT !.selectedControl = Token(captured)]
     [] ev = "takeover" -> [common EXCEPT !.gen = @ + 1, !.rows = @ \cup {IF Fault = "foreign-registration" THEN (IF p = "p" THEN "q" ELSE "p") ELSE p},
         !.ended = @ \cup (d.rows \ {p}), !.rowEpoch[p] = d.epoch]
     [] ev = "recapture" -> LET captured == [common EXCEPT !.selected = Len(history) + 1,
         !.frozen = IF Fault = "refreeze" THEN @ + 1 ELSE @]
        IN [captured EXCEPT !.selectedControl = Token(captured)]
     [] ev = "ready" -> [common EXCEPT !.phase = "ready", !.readyClosure = TRUE]
     [] ev = "intent" -> [common EXCEPT !.cancel = TRUE]
     [] ev = "terminal" -> [common EXCEPT !.phase = "open", !.admission = "open",
         !.epoch = IF Fault = "split-terminal" THEN @ ELSE @ + 1,
         !.active = IF Fault = "split-terminal" THEN TRUE ELSE FALSE]
     [] OTHER -> common

EventAllowed(p) ==
  LET ev == w[p].todo
  IN /\ (db.cancel => ev \in {"takeover", "terminal", "enter"})
     /\ CASE ev = "enter" -> db.phase = "open" /\ ~db.active /\ db.migration = 1
          [] ev = "first" -> db.phase = "planned" /\ ~db.hasOrigin
               /\ \A q \in db.rows : w[q].life = "exited" /\ db.rowEpoch[q] < db.epoch
          [] ev = "takeover" -> db.hasOrigin /\ db.phase \in {"quiesced", "ready"}
               /\ p \notin db.rows /\ NativeRowsSafe(p)
          [] ev = "recapture" -> db.phase = "quiesced" /\ db.hasOrigin /\ w[p].factory = "registered"
          [] ev = "ready" -> db.phase = "quiesced" /\ db.hasOrigin
               /\ w[p].restored = db.selectedControl /\ w[p].restoredLive = Token(db)
          [] ev = "intent" -> db.hasOrigin /\ db.phase \in {"quiesced", "ready"} /\ ~db.cancel
          [] ev = "terminal" -> db.cancel /\ db.hasOrigin /\ db.phase \in {"quiesced", "ready"}
          [] OTHER -> FALSE

Prepare(p) ==
  /\ w[p].life = "live" /\ ~w[p].failed /\ w[p].pc = "prepare"
  /\ mutex = p /\ p \in sources /\ Token(db) = w[p].proof
  /\ Len(history) < MaxCommits
  /\ (EventAllowed(p) \/ (Fault = "advance-after-cancel" /\ db.cancel /\ w[p].todo = "recapture"))
  /\ w' = [w EXCEPT ![p] = [@ EXCEPT !.proposed = Candidate(p, w[p].todo), !.pc = "publish",
         !.factory = IF w[p].todo = "takeover" THEN "staged" ELSE @,
         !.proofWindow = IF Fault = "reuse-proof" /\ w[p].window > 1 THEN w[p].window - 1 ELSE @]]
  /\ UNCHANGED <<db, mutex, sources, history, commits, observations>>

Publish(p) ==
  /\ w[p].life = "live" /\ ~w[p].failed /\ w[p].pc = "publish"
  /\ mutex = p /\ p \in sources /\ Token(db) = w[p].proof
  /\ w' = [w EXCEPT ![p] = [@ EXCEPT !.published = TRUE, !.pc = "submit"]]
  /\ UNCHANGED <<db, mutex, sources, history, commits, observations>>

RestorePart(p) ==
  /\ w[p].life = "live" /\ ~w[p].failed /\ w[p].pc = "effect"
  /\ w[p].todo = "restore" /\ mutex = p /\ p \in sources
  /\ w[p].factory = "registered" /\ Qualified /\ TypedBinding
  /\ Token(db) = w[p].proof /\ ~db.cancel /\ ConsumerRowsSafe(p)
  /\ w[p].restoreStep < 3
  /\ w' = [w EXCEPT ![p].restoreStep = @ + 1]
  /\ UNCHANGED <<db, mutex, sources, history, commits, observations>>

FinishRead(p) ==
  /\ w[p].life = "live" /\ ~w[p].failed /\ w[p].pc = "effect"
  /\ mutex = p /\ p \in sources /\ Token(db) = w[p].proof
  /\ (w[p].todo = "replay" \/ (w[p].todo = "restore" /\ w[p].restoreStep = 3)
      \/ (w[p].todo = "guard" /\ db.phase = "ready" /\ db.readyClosure
          /\ w[p].factory = "registered" /\ ConsumerRowsSafe(p)
          /\ w[p].restored = db.selectedControl /\ w[p].restoredLive = Token(db)))
  /\ w' = [w EXCEPT ![p] = [@ EXCEPT !.pc = "submit", !.published = TRUE,
      !.restored = IF w[p].todo = "restore" THEN
        IF Fault = "restore-current-as-archive" THEN Token(db) ELSE db.selectedControl ELSE @,
      !.restoredLive = IF w[p].todo = "restore" THEN Token(db) ELSE @,
      !.restoreExpectedArchive = IF w[p].todo = "restore" THEN db.selectedControl ELSE @,
      !.restoreExpectedLive = IF w[p].todo = "restore" THEN Token(db) ELSE @,
      !.replayHead = IF w[p].todo = "replay" THEN db.head ELSE @,
      !.replayHistory = IF w[p].todo = "replay" THEN history ELSE @,
      !.guard = w[p].todo = "guard", !.guardWindow = w[p].window,
      !.proposed = db]]
  /\ observations' = IF w[p].todo = "guard" THEN observations \cup {"guard-used"} ELSE observations
  /\ UNCHANGED <<db, mutex, sources, history, commits>>

Submit(p) ==
  /\ w[p].life = "live" /\ ~w[p].failed /\ mutex = p /\ p \in sources
  /\ (w[p].pc = "submit" \/ (Fault = "undurable" /\ w[p].pc = "publish"))
  /\ w' = [w EXCEPT ![p] = [@ EXCEPT !.pc = "commit", !.tx = "submitted"]]
  /\ UNCHANGED <<db, mutex, sources, history, commits, observations>>

CommitRecord(p) == [event |-> w[p].todo, actor |-> p, key |-> w[p].request.key,
  digest |-> w[p].request.digest, before |-> w[p].before, after |-> w[p].proposed,
  window |-> w[p].window, proofWindow |-> w[p].proofWindow,
  durable |-> w[p].published, matched |-> w[p].matched, replay |-> w[p].replay,
  restored |-> w[p].restored, restoredLive |-> w[p].restoredLive,
  actualExited |-> {q \in P : w[q].life = "exited"}]

ActualCommit(p) ==
  /\ w[p].tx = "submitted" /\ p \in sources /\ db = w[p].before
  /\ db' = IF w[p].todo \in WriteEvents THEN w[p].proposed ELSE db
  /\ history' = IF w[p].todo \in WriteEvents THEN Append(history, CommitRecord(p)) ELSE history
  /\ commits' = Append(commits, [actor |-> p, window |-> w[p].window,
                                 priorSourceClosed |-> w[p].window = 1 \/ w[p].ack = "none"])
  /\ w' = [w EXCEPT ![p] = [@ EXCEPT !.tx = "committed", !.committed = TRUE,
      !.lateCommit = @ \/ mutex # p \/ w[p].life = "exited"]]
  /\ UNCHANGED <<mutex, sources, observations>>

Response(p, reply) ==
  /\ w[p].tx = "committed" /\ w[p].ack = "none"
  /\ reply \in {"ok", "lost"} /\ (reply = "ok" => w[p].life = "live")
  /\ (reply = "lost" => FaultAllowed)
  /\ w' = [w EXCEPT ![p] = IF reply = "ok" THEN
       [@ EXCEPT !.ack = reply, !.registrationAck = @ \/ w[p].todo = "takeover"]
       ELSE [Error(@, "undefined") EXCEPT !.ack = reply]]
  /\ UNCHANGED <<db, mutex, sources, history, commits>>
  /\ observations' = IF reply = "lost" THEN observations \cup {IF FaultCount = 0 THEN "fault-1" ELSE "fault-2"} ELSE observations

Abort(p) ==
  /\ p \in sources /\ w[p].tx \in {"open", "submitted"}
  /\ (w[p].failed \/ w[p].life = "exited" \/ (FaultAllowed /\ w[p].tx = "submitted"))
  /\ w' = [w EXCEPT ![p] = [Error(@, "abort-unknown") EXCEPT !.tx = "rolledback", !.ack = "lost"]]
  /\ UNCHANGED <<db, mutex, sources, history, commits>>
  /\ observations' = IF ~w[p].failed /\ w[p].life = "live" THEN observations \cup {IF FaultCount = 0 THEN "fault-1" ELSE "fault-2"} ELSE observations

AfterEvent(p) ==
  CASE w[p].todo = "enter" -> "first"
    [] w[p].todo = "first" -> "takeover"
    [] w[p].todo = "takeover" ->
         IF db.cancel THEN IF Fault = "advance-after-cancel" THEN "recapture" ELSE "terminal"
         ELSE IF w[p].request.op = "cancel" THEN "intent"
         ELSE IF db.phase = "ready" THEN "restore" ELSE "recapture"
    [] w[p].todo = "recapture" -> "restore"
    [] w[p].todo = "restore" -> IF db.phase = "ready" THEN
         IF w[p].request.op = "guard" THEN "guard" ELSE "finish" ELSE "ready"
    [] w[p].todo = "intent" -> IF Fault = "advance-after-cancel" THEN "recapture" ELSE "terminal"
    [] OTHER -> "finish"

CloseSource(p, outcome) ==
  /\ p \in sources /\ w[p].tx \in {"committed", "rolledback"}
  /\ (w[p].ack # "none" \/ w[p].life = "exited")
  /\ outcome \in {"closed", "failed-closed", "unknown"}
  /\ (outcome # "closed" => FaultAllowed)
  /\ sources' = IF outcome = "unknown" THEN sources ELSE sources \ {p}
  /\ w' = [w EXCEPT ![p] =
       LET x == IF outcome = "closed" THEN @ ELSE Error(@, "close-error")
           finished == x.failed \/ x.life = "exited" \/ AfterEvent(p) = "finish"
       IN [x EXCEPT !.tx = IF outcome = "unknown" THEN "close-unknown" ELSE "none",
          !.sourceClosed = outcome # "unknown", !.closeUnknown = outcome = "unknown",
          !.registrationClosed = @ \/ (w[p].todo = "takeover" /\ outcome = "closed"),
          !.guard = IF Fault = "leaked-guard" THEN @ ELSE FALSE,
          !.pc = IF finished THEN "closing" ELSE "source", !.todo = AfterEvent(p),
          !.result = IF ~finished THEN "none" ELSE IF x.failed THEN "blocked"
                     ELSE IF w[p].replay THEN "progress" ELSE IF db.phase = "open" THEN "cancelled" ELSE "ready"]]
  /\ UNCHANGED <<db, mutex, history, commits>>
  /\ observations' = IF outcome # "closed" THEN observations \cup {IF FaultCount = 0 THEN "fault-1" ELSE "fault-2"} ELSE observations

ConfirmOriginalClose(p) ==
  /\ w[p].tx = "close-unknown" /\ p \in sources
  /\ sources' = sources \ {p}
  /\ w' = [w EXCEPT ![p] = [@ EXCEPT !.tx = "none", !.sourceClosed = TRUE, !.closeUnknown = FALSE]]
  /\ UNCHANGED <<db, mutex, history, commits, observations>>

LoseMutex(p) ==
  /\ FaultAllowed /\ mutex = p /\ w[p].life = "live"
  /\ mutex' = NoOwner
  /\ w' = [w EXCEPT ![p] = [Error(@, "mutex-lost") EXCEPT !.pc = "closing"]]
  /\ UNCHANGED <<db, sources, history, commits>>
  /\ observations' = observations \cup {IF FaultCount = 0 THEN "fault-1" ELSE "fault-2"}

Crash(p) ==
  /\ FaultAllowed /\ w[p].life = "live"
  /\ w' = [w EXCEPT ![p] = [Error(@, "process-exit") EXCEPT !.life = "exited", !.pc = "closing"]]
  /\ mutex' = IF mutex = p THEN NoOwner ELSE mutex
  /\ UNCHANGED <<db, sources, history, commits>>
  /\ observations' = observations \cup {IF FaultCount = 0 THEN "fault-1" ELSE "fault-2"}

CleanupError(p) ==
  /\ FaultAllowed /\ w[p].pc = "closing" /\ ~w[p].cleanupDone /\ w[p].cleanupErrors < 2
  /\ w' = [w EXCEPT ![p] =
       [Error(@, "undefined") EXCEPT !.cleanupErrors = @ + 1,
        !.firstError = IF Fault = "forgotten-first" /\ w[p].failed THEN "cleanup-replaced" ELSE @]]
  /\ UNCHANGED <<db, mutex, sources, history, commits>>
  /\ observations' = observations \cup {IF FaultCount = 0 THEN "fault-1" ELSE "fault-2"}

FinishCleanup(p) ==
  /\ w[p].pc = "closing" /\ w[p].tx = "none" /\ p \notin sources
  /\ w[p].sourceClosed /\ ~w[p].closeUnknown /\ ~w[p].cleanupDone
  /\ w' = [w EXCEPT ![p] = [@ EXCEPT !.cleanupDone = TRUE,
      !.factory = "invalid", !.guard = FALSE]]
  /\ mutex' = IF mutex = p THEN NoOwner ELSE mutex
  /\ UNCHANGED <<db, sources, history, commits, observations>>

EmitFrame(p) ==
  /\ w[p].life = "live" /\ w[p].cleanupDone /\ ~w[p].failed /\ ~w[p].frame
  /\ w' = [w EXCEPT ![p].frame = TRUE]
  /\ UNCHANGED <<db, mutex, sources, history, commits, observations>>

NormalExit(p) ==
  /\ w[p].life = "live" /\ w[p].cleanupDone /\ (w[p].frame \/ w[p].failed)
  /\ w' = [w EXCEPT ![p].life = "exited"]
  /\ UNCHANGED <<db, mutex, sources, history, commits, observations>>

Reap(p) ==
  /\ w[p].life = "exited" /\ ~w[p].reaped
  /\ w' = [w EXCEPT ![p].reaped = TRUE]
  /\ UNCHANGED <<db, mutex, sources, history, commits, observations>>

Deliver(p) ==
  /\ w[p].frame /\ ~w[p].delivered
  /\ (Fault = "early-delivery" \/
      (w[p].life = "exited" /\ w[p].reaped /\ w[p].cleanupDone /\ ~w[p].failed))
  /\ w' = [w EXCEPT ![p].delivered = TRUE]
  /\ UNCHANGED <<db, mutex, sources, history, commits, observations>>

Next == \E p \in P : BeginRequest(p) \/ AcquireMutex(p) \/ AcquireSource(p)
  \/ Promote(p) \/ ReadFacts(p) \/ Prepare(p) \/ Publish(p) \/ RestorePart(p)
  \/ FinishRead(p) \/ Submit(p) \/ ActualCommit(p) \/ Abort(p)
  \/ (\E r \in {"ok", "lost"} : Response(p, r))
  \/ (\E c \in {"closed", "failed-closed", "unknown"} : CloseSource(p, c))
  \/ ConfirmOriginalClose(p) \/ LoseMutex(p) \/ Crash(p) \/ CleanupError(p)
  \/ FinishCleanup(p) \/ EmitFrame(p) \/ NormalExit(p) \/ Reap(p) \/ Deliver(p)

Spec == Init /\ [][Next]_vars
StableSpec == Spec /\ WF_vars(Next)

TypeOK == /\ db.phase \in Phases /\ db.admission \in {"draining", "sealed", "open"}
          /\ db.epoch \in 1..3 /\ db.migration \in 1..2 /\ db.gen \in 1..(MaxCommits + 2)
          /\ db.rows \subseteq P /\ db.ended \subseteq db.rows
          /\ mutex \in P \cup {NoOwner} /\ sources \subseteq P
          /\ DOMAIN w = P /\ Len(history) <= MaxCommits
          /\ \A p \in P : w[p].life \in {"idle", "live", "exited"}
             /\ w[p].window \in 0..(MaxCommits + 3) /\ w[p].cleanupErrors \in 0..2
SourceExclusive == Cardinality(sources) <= 1
DurableAnchors == \A i \in 1..Len(history) : history[i].durable
  /\ (history[i].event = "ready" => history[i].restored.epoch = history[i].before.epoch
      /\ history[i].restored.selected = history[i].before.selected
      /\ history[i].restored.origin = history[i].before.origin)
FreshCommit == \A i \in 1..Len(history) : history[i].window = history[i].proofWindow
  /\ \A j \in 1..(i-1) : history[j].actor = history[i].actor => history[j].window < history[i].window
ExactRequest == \A i \in 1..Len(history) : history[i].matched /\ ~history[i].replay
FrozenOrigin == \A i \in 1..Len(history) :
  LET h == history[i] IN
  /\ (h.event = "first" => h.after.receipt = h.before.gen /\ h.after.frozen = h.before.migration
      /\ h.after.originRows = RawRows(h.before))
  /\ (h.event \in {"takeover", "recapture", "ready", "intent", "terminal"} =>
      h.after.origin = h.before.origin /\ h.after.frozen = h.before.frozen
      /\ h.after.receipt = h.before.receipt /\ h.after.originRows = h.before.originRows)
  /\ (h.event = "recapture" => h.before.hasOrigin)
OwnRegistration == \A i \in 1..Len(history) :
  LET h == history[i] IN
  /\ (h.event = "takeover" => h.after.rows = h.before.rows \cup {h.actor}
      /\ h.actor \notin h.before.rows /\ h.before.hasOrigin
      /\ h.after.ended \ h.before.ended \subseteq h.actualExited
      /\ h.actor \notin h.after.ended)
  /\ (h.event # "takeover" => h.after.rows = h.before.rows)
RegisteredAfterCommit == \A p \in P : w[p].factory = "registered" =>
  p \in db.rows /\ w[p].registrationAck /\ w[p].registrationClosed
CancelBarrier == \A i \in 1..Len(history) : history[i].before.cancel =>
  history[i].event \in {"takeover", "terminal", "enter"}
TerminalAtomic == \A i \in 1..Len(history) : history[i].event = "terminal" =>
  LET h == history[i] IN h.before.hasOrigin /\ h.before.cancel
    /\ h.after.epoch = h.before.epoch + 1 /\ h.after.admission = "open"
    /\ ~h.after.active /\ h.after.gen = h.before.gen /\ h.after.rows = h.before.rows
EpochFence == \A i \in 1..Len(history) : history[i].event = "enter" =>
  LET h == history[i] IN ~h.before.active /\ h.before.admission = "open"
    /\ h.after.epoch = h.before.epoch + 1 /\ h.after.migration = h.before.migration + 1
    /\ h.after.active /\ h.after.admission = "draining" /\ ~h.after.hasOrigin
GuardScoped == \A p \in P : w[p].guard => w[p].life = "live" /\ p \in sources
  /\ mutex = p /\ w[p].guardWindow = w[p].window /\ w[p].factory = "registered"
  /\ db.phase = "ready" /\ db.readyClosure
  /\ w[p].restored = db.selectedControl /\ w[p].restoredLive = Token(db)
FailureSticky == \A p \in P : (w[p].failed <=> Len(w[p].errors) > 0)
  /\ (w[p].failed => w[p].firstError = w[p].errors[1] /\ ~w[p].delivered)
GatewayCompletion == \A p \in P : w[p].delivered => w[p].frame /\ w[p].life = "exited"
  /\ w[p].reaped /\ w[p].cleanupDone /\ w[p].sourceClosed /\ ~w[p].closeUnknown /\ ~w[p].failed
FailuresRetained == Len(w["p"].errors) + Len(w["q"].errors) >= FaultCount
QualificationGate == (~Qualified \/ ~TypedBinding) => history = <<>>

HistoricalR0 == \A i \in 1..Len(history) : history[i].event = "first" =>
  LET h == history[i] IN h.before.rows \subseteq h.actualExited
     /\ (\A q \in h.before.rows : h.before.rowEpoch[q] < h.before.epoch)
IndependentTransactions == \A i \in 1..Len(commits) :
  \A j \in 1..(i-1) : commits[i].actor = commits[j].actor => commits[j].window < commits[i].window
CompleteRestoreBinding == \A i \in 1..Len(history) : history[i].event = "ready" =>
  LET h == history[i] IN h.restored = h.before.selectedControl /\ h.restoredLive = Token(h.before)
    /\ h.restored.frozen = h.before.frozen /\ h.restored.receipt = h.before.receipt

SelectedSnapshotImmutable == \A i \in 1..Len(history) :
  LET h == history[i] IN
  /\ (h.event \in {"first", "recapture"} => h.after.selectedControl = Token(h.after))
  /\ (h.event = "enter" => h.after.selectedControl = EmptyToken)
  /\ (h.event \notin {"enter", "first", "recapture"} =>
       h.after.selectedControl = h.before.selectedControl)
HistoricalRestoreBinding == \A p \in P : w[p].restored # EmptyToken =>
  w[p].restored = w[p].restoreExpectedArchive /\ w[p].restoredLive = w[p].restoreExpectedLive

RequestIndices(h, key) == {i \in 1..Len(h) : h[i].key = key}
FirstRequestIndex(h, key) == CHOOSE i \in RequestIndices(h, key) :
  \A j \in RequestIndices(h, key) : i <= j
Prefixes(events) == {SubSeq(events, 1, n) : n \in 1..Len(events)}
AllowedRequestPrefixes(op) ==
  IF op = "cancel" THEN Prefixes(<<"takeover", "intent", "terminal">>) \cup Prefixes(<<"takeover", "terminal">>)
  ELSE IF op = "guard" THEN {<<"takeover">>}
  ELSE Prefixes(<<"enter", "first", "takeover", "recapture", "ready">>)
    \cup Prefixes(<<"first", "takeover", "recapture", "ready">>)
    \cup Prefixes(<<"takeover", "recapture", "ready">>) \cup Prefixes(<<"takeover", "terminal">>)
ReplayExactDigest == \A p \in P : (w[p].delivered /\ w[p].result = "progress") =>
  \A i \in RequestIndices(w[p].replayHistory, w[p].request.key) :
    w[p].replayHistory[i].digest = w[p].request.digest
ReplayExactPrefix == \A p \in P : (w[p].delivered /\ w[p].result = "progress") =>
  LET h == w[p].replayHistory
      indices == RequestIndices(h, w[p].request.key)
  IN IF indices = {} THEN FALSE ELSE
    LET first == FirstRequestIndex(h, w[p].request.key)
        events == [i \in 1..(Len(h)-first+1) |-> h[first+i-1].event]
    IN /\ w[p].replayHead = Len(h) /\ h[Len(h)].after.head = w[p].replayHead
       /\ (\A i \in first..Len(h) : h[i].key = w[p].request.key)
       /\ events \in AllowedRequestPrefixes(w[p].request.op)
       /\ h[first].before.epoch = w[p].request.epoch /\ h[first].before.head = w[p].request.head

NeverReady == ~\E p \in P : w[p].delivered /\ w[p].result = "ready"
NeverCancelled == ~\E p \in P : w[p].delivered /\ w[p].result = "cancelled"
NeverNextEpoch == db.migration = 1
NeverLateCommit == ~\E p \in P : w[p].lateCommit
NeverSameKeyProgress == ~\E p \in P : w[p].delivered /\ w[p].result = "progress"
NeverGuard == "guard-used" \notin observations
EventuallyBothDelivered == <> (\A p \in P : w[p].delivered)
=============================================================================
