# Day 3: rendering reuse and the Bun build

Day 3 ports Pi-Bolt's TUI render reuse and adds bytecode to the Bun binary build.

Rendering tasks carry extra risk. Output can pass unit tests and still look wrong. Each UI task is
therefore also validated by `bench/pi-bolt/screen-check.mjs --compare` against frames recorded on the
day-1 baseline. The frames must match byte for byte. You may not re-record them.

- ICE's interactive components carry ICE-only behavior: appearance settings, OSC133 marks, the
  new-messages pill, the session header, subagent footers. Keep all of it.
- Memoization must invalidate on everything that changes output: text, width, theme or appearance
  generation, expanded/collapsed state, terminal capabilities. When unsure, invalidate.
- Pi-Bolt claims up to 17x less render work per frame late in a long session. That aggregate covers
  three changes: Container/Box memo, main-screen line reuse, and `renderShared`. A single task will show
  less.
