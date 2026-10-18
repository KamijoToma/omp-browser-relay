# Changelog

## [Unreleased]

### Breaking Changes

- Extracted the extension and CDP server into the independent `omp-browser-relay` project; use its standalone serve/install commands with a matching extension.
- Agent targets are restricted to a dedicated workspace window; legacy user-tab adoption and title-based tab grouping are removed.

### Added

- Added a standalone CLI for serving the relay and installing its unpacked Chrome extension.
- Added a reserved workspace view for real background keyboard/mouse input, canvas drawing, screenshots, and user-priority pause/resume without native window activation.
- Added ownership revocation for moved tabs, safe workspace replacement, scoped multi-client CDP sessions, and headed X11/native-input smoke verification.
- Added compatibility with unmodified omp 18.12.2 and existing-work-page workflows in 18.4.2.
- Added a settings-page control to create background work pages for older clients without switching windows.

### Fixed

- Preserved existing client sessions across paused workspace updates and allowed first-use workspace provisioning to complete.
- Released focus emulation across detach, disconnect, migration, and service-worker restoration without applying it to the active native view.
- Closing workspace tabs no longer fails when Chrome announces page removal before acknowledging the close request.
- Background canvas dragging stays responsive with emulated viewports without raising the agent window.
- Waiting for page JavaScript or a missing element no longer blocks cancellation and other work pages.
- Pausing during Puppeteer initialization no longer leaves the connection waiting indefinitely.
- Discarded pages no longer block auto-attach, and stale target ids cannot address reused tabs after a browser restart.
- Delayed recording cleanup from a disconnected client no longer interrupts a new recording.
- Opening a work page after closing its workspace no longer fails with stale tab or focus-cleanup errors.

## [18.3.1] - 2026-09-25

### Fixed

- Fixed browser relay support when multiple browser instances, such as Chrome and Edge, are connected simultaneously, ensuring tabs and relay requests remain associated with the correct browser while preserving single-browser compatibility for extensions without an instance identifier.

## [18.0.7] - 2026-08-26

### Changed

- Clarified the scope of the two browser relay opt-in paths: per-call `app.relay: true` enables relay access for an individual call, while the `browser.relay` setting enables it by default across projects in a profile.

## [17.2.5] - 2026-08-03

### Added

- Initial release of the Chrome MV3 extension, enabling the omp browser tool to attach to and drive existing browser tabs via chrome.debugger.
- Added automatic, robust tab management that groups active agent-driven tabs into a dedicated per-window "omp" tab group and ensures clean dissolution upon disconnect.
