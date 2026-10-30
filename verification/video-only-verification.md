# Current scope verification — video GIS

The user's latest correction supersedes the initial dual-layer brief: this is a drive/video-only application with Potholes selected by default, and a two-item Video / Survey navbar. No citizen or walking layer is exposed or requested.

## Current results

- **69/69 automated tests pass**, recorded in `automated-tests.txt`. The final run follows the completed navigation, evidence-card expansion/positioning, and native-modal focus-restoration changes.
- **37 application UI tests** each assert that no request reaches a citizen endpoint. Coverage includes default/reset filters, navigation, exports, image failures, metadata, missing-frame states, 528-frame virtualization, 5 fps replay, stale-response protection, 30-second recovery, multi-drive focus, report scope and 6,000-segment guarded loading.
- Survey opens as a nonmodal surface. Escape and outside dismissal, navigation state, focus return, mutual exclusion across Survey/Settings/Export/Filters/Drives/legend, reopening during a pending close, and reduced-motion dismissal pass. Closing an evidence card clears map selection immediately; a rapid new selection survives both the previous close timer and image-error callback. Closing Survey preserves the underlying inspected observation. Expanding evidence pauses playback and keeps the current loaded image; collapsing preserves selection.
- The report remains modal. The harness enforces native blocking of background focus while it is open; close-button and native Escape dismissal restore focus to the visible Survey control only after native close. Reopening during dismissal cancels the old focus return, and reduced-motion report closure restores focus without waiting for a timer.
- **19/19 live API and app-mount checks pass** against the current local preview, recorded in `api-integration-results.json`. This run makes no citizen API requests.
- Application booted with the actual sample files inside the UI harness shows **131 Potholes**, **652.3 m** of matching surveyed segments and **111 awaiting review**, while all three drive routes and **4.06 km total route length** remain available.
- Default and Reset use the exact canonical Potholes label supplied by metadata. An explicit all-label shared link remains explicit; a legacy include-review flag cannot revive a citizen layer.
- The current served index has exactly the Video / Survey navigation and no citizen interface; authored app code contains no citizen endpoint.
- Map tests explicitly reject accidental citizen features and verify selection/follow positioning between floating controls on the full-screen map, including compatibility with inset containers.

## Other evidence and limits

The independent original-sample verification remains **58/58 data checks** and **1,664 manifest-file hash validations**. These are separate from the 69 application tests and should not be combined as end-user acceptance cases.

The generic shared API helper still has 1,440 scenario checks covering both contract vocabularies; this does not expose a citizen UI or network path in the application.

The previous inset-dashboard screenshots precede the latest full-map correction. Use the fresh fullmap screenshots for current design acceptance. Browser checks confirm the map spans the viewport, cards float above it, and navigation/Fit/zoom/legend remain usable during replay. The DOM harness verifies interaction lifecycle, not pixel layout or the appearance of animations; real-browser review supplies that evidence. Production FastAPI and real 20,000-feature timing remain unverified.
