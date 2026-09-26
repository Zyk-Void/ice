# kiosk-ledger (quality fixture)

Tiny sample project used by the ICE subagent quality benchmark. All facts in
this file are deliberately findable.

- Assistant sync retries: `RETRY_LIMIT` in `src/config.ts` (value: 3).
- Audit log capacity: `AUDIT_RING_CAPACITY` in `src/config.ts` (value: 4).
- Late fee rate: `LATE_FEE_RATE` in `src/config.ts` (value: 0.02).
- `src/sum.ts` holds dependency-free numeric helpers.
- `src/ledger.ts` records sales, keeps the balance in cents, and asks
  `src/pricing.ts` to add late fees.
- Every public symbol is re-exported by `src/index.ts`.
- This fixture has no network, storage, or HTTP client code.
