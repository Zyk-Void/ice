# Subagent Delegation Context

Language for ICE's managed delegated work, its lifecycle, and the results returned to the parent agent.

## Lifecycle

**Background child**:
A delegated task that continues after its launch call returns, while the parent remains available. Background execution alone does not promise survival across process restart.
_Avoid_: durable worker, resumable child

**Durable job**:
An owner-associated record of delegated work whose state can remain inspectable beyond a live tool call. A durable record does not imply that an interrupted model run can safely resume or be replayed.
_Avoid_: resumable worker

**Progress**:
A bounded observation of a child while it is running, distinct from its final answer and from a claim that its work is verified.
_Avoid_: result, completion report

## Results

**Final answer**:
The child-authored response that summarizes its work for the parent; it is distinct from the child's tool transcript.
_Avoid_: transcript, full session

**Output artifact**:
A retained copy of a final answer that is too large to include inline, addressable separately from the parent-facing text projection.
_Avoid_: unbounded tool log

**Inline result**:
The bounded text and metadata included directly in the parent's context; it may point to an output artifact for additional content.
_Avoid_: full output, complete transcript
