---
status: accepted
---

# Separate Managed Subagent Execution from Output Size

Managed child work will not be rejected or stopped because a caller-supplied aggregate byte allowance is exhausted or because a final answer exceeds an inline-output limit. Managed launches return handles; the parent receives bounded `output.text` and an owner-scoped reference for retrieving a large final answer in bounded chunks. Fixed host-owned storage, retrieval, and retention limits remain to protect disk and parent context. Ordinary in-process children do not survive restart; durable jobs interrupted by restart are inspectable but are not automatically replayed. This favors useful, observable background work without allowing unbounded context or storage growth.
