# Changelog

> This fork resets its changelog at the ICE rename. Pre-fork release history lives upstream at https://github.com/earendil-works/pi.

## [Unreleased]

### Breaking Changes

- Renamed the package to `@zykairotis/ice-tui` and removed the previous package specifier.
- Changed the TUI cursor marker escape sequence to the ICE-specific form.
- Stopped reading `PI_TUI_*` environment fallbacks. Use `ICE_TUI_DEBUG`, `ICE_TUI_WRITE_LOG`, `ICE_HARDWARE_CURSOR`, and `ICE_CLEAR_ON_SHRINK`.
- Removed historical `pi-tui` layout/viewport symbols and `\x1b_pi:c` cursor recognition.

### Fixed

- Fixed the npm package omitting the source and build script needed to rebuild the Darwin native addon.
- Fixed Windows console truecolor detection when Windows Terminal does not provide `WT_SESSION` to child shells.
- Fixed terminal width accounting for Indic conjunct grapheme clusters ([#6124](https://github.com/earendil-works/pi/issues/6124) by [@petrroll](https://github.com/petrroll)).
- Fixed phantom alternate-screen text selection from unmatched mouse events when changing terminal pane focus.
- Fixed spaces in searchable settings queries changing the selected value instead of filtering multi-word labels.
- Fixed alternate-screen Kitty images crossing vertical layout clip boundaries and overlapping sticky regions while scrolling.
- Fixed alternate-screen redraws retransmitting Kitty image data when placements move or recently offscreen images return, dropping adjacent row content when reusing placements, rendering fixed-basis scroll content twice per frame, and scanning clipped transcript rows while painting.
- Fixed fullscreen transcript navigation leaving no editor-accessible `Home`, `End`, `PageUp`, or `PageDown` variants by adding Ctrl-modified editor bindings ([#7574](https://github.com/earendil-works/pi/issues/7574)).
- Fixed alternate-screen scrolling recompositing every visible row and scrollbar cell each frame; unchanged full-width rows are now reused from a bounded cache.

### Added

- Added the `Editor` `prompt` option and `setPrompt()`: a gutter before the first line, drawn in the border color, with continuation lines indented to match.
- Added `TUI.isRunning`, true between `start()` and `stop()`.
- Added the `TuiAltScreen` `isActionUrl` option: matching OSC 8 links stay out of terminal output and are highlighted in reverse video while the pointer is over them.
- Added the shared `TuiMode` type and `mode` discriminants to the main-screen and alternate-screen TUI renderers.
- Added TUI lifecycle and render-state handoff APIs for replacing renderers without replaying main-screen content.
- Exported the bundled `Marked` parser and token types.
- Added width-aware source transforms to the `Markdown` component.
- Added interface-compatible main-screen and alternate-screen TUI renderers with application-owned scrolling ([#7304](https://github.com/earendil-works/pi/issues/7304)).
- Added alternate-screen `VStack`, `HStack`, and nested `ScrollView` layouts with constrained sizing, sticky regions, and pointer-targeted scrolling.
- Added edge auto-scrolling for alternate-screen drag selection across off-screen scroll-view content.
- Added proportional scrollbars with mouse dragging, Home/End document navigation, transient `auto` mode, and an `always` mode that reserves the rightmost column; scrollbar modes can be changed at runtime.
- Added page scrolling and OSC 133 semantic prompt navigation to the alternate-screen viewport.

> Release notes for versions published under the previous product identity are not reproduced here. They are preserved in the archived source repository and in prior Git history.
