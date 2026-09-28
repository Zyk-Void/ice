# kiosk-ledger benchmark guidance

This is a tiny code-reading fixture. For cross-file behavior, start from the public surface in `src/index.ts`, then trace the owning implementation and its imported collaborators. For audit-flow questions, inspect the sale-recording method and the audit data structure before summarizing the path.

Treat README summaries as orientation only. Cite the implementation files that directly support the answer, and state uncertainty when the repository does not contain the requested capability.
