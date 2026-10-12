# Day 2: port the non-UI speedups

Day 2 ports Pi-Bolt changes that do not touch rendering. Each task is measured with the frozen
`bench/pi-bolt/` harness. The controller runs it interleaved against the previous passing commit; the
task passes only if its target metric improves by the stated margin and no guard metric regresses more
than 10%.

- `bench/pi-bolt/` is frozen. Read it to understand the workloads; never change it.
- If a technique does not move its metric on ICE, do not tune it against the benchmark. Say so in your
  final report; the controller will mark the task unresolved for a human to judge.
- Pi-Bolt's measured claims (theirs, not ICE's):
  - streamed tool-call JSON for a 400 KB write: 765 ms to about 50 ms;
  - 230 KB edit preview: 23 ms to 1 ms;
  - conversation clone: about 24 ms over a 5-prompt session;
  - startup model refresh: 23 ms to 12 ms.
