# Changelog

## 0.3.0

- Fixed an off-by-one in the audit ring snapshot; `AuditRing.snapshot` now
  returns exactly one entry per recorded slot.

## 0.2.0

- Initial pricing: late fees apply the configured rate to the cents balance.
