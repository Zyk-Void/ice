# Architecture

Call chain for a recorded sale:

1. `src/index.ts` re-exports the public surface.
2. `src/ledger.ts` (`Ledger.recordSale`) appends the sale and writes an audit
   label through `src/ring.ts` (`AuditRing.record`).
3. Fee handling calls `src/pricing.ts` (`withLateFee`) with the outstanding
   balance computed by `src/sum.ts` (`sum`).
4. Limits and rates come from `src/config.ts`.

Known surfaces: there is no network, storage, or HTTP client in this fixture.
