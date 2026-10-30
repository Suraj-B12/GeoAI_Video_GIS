# Verification — 30 October 2026

This log covers the separate **drive-video-only dashboard**, including default Potholes, Video/Survey navigation, persistent filter-aware metrics, no citizen/walking layer, and the latest anchored-card and sliding-navigation interactions. The supplied sample remains unchanged.

## Automated checks

- JavaScript data, UI, map and basemap suites: **66/66 passed**.
- The suite includes **1,440 filter combinations** compared with the supplied Python API's filtering implementation.
- Live HTTP API checks against the supplied mock: **19/19 passed**.
- Sample consistency checks: **58/58 passed**, including SHA-256 checks for all **1,664 manifest-listed files**.
- Latest regression checks cover the absence of citizen requests/controls, metadata-selected Potholes on entry/reset, Video/Survey navigation, current-filter summary metrics, route inspection versus session filtering, exports, replay, request races and recovery.
- Motion-controller regressions cover anchored-card lifecycle, mutual exclusion, keyboard dismissal and focus restoration, delayed closing, reduced-motion immediate closing, and evidence entrance/exit boundaries.
- Additional cases cover final expert fields, null images/positions, pending/skipped/not-covered semantics, metadata styling, paging/caps, image concurrency, keyboard synchronization and mutually exclusive per-km coverage totals.

Saved outputs accompany the package in `verification/`. These results establish the tested local behavior, not production latency or the absence of every possible defect.

## Handoff acceptance and scope

| Item | Status | Evidence and limits |
|---|---|---|
| Static `/gis/app/`, same-origin API | Passed against mock | Empty `apiBase`; bundled static assets. Real FastAPI host remains a deployment check. |
| Drive list and route context | Passed | Three drives with API road/date/state/length/distress. Inspecting or replaying one retains all route tracks. |
| Default Potholes selection | Passed | 131 video segments, 652.3 m matching length, 111 awaiting review. Distress is 100% of this filtered selection. Total route context remains 4.06 km. |
| Full survey reference totals | Passed | With label restriction removed: 813 segments, 4,060.31 m surveyed, 20.08% distressed, 389 awaiting review. |
| Reference filters | Passed | Potholes 131; Medium+High distress 75; high-confidence distress 47; needs-review 389. Non-pothole reference cases remove the default label restriction. |
| Citizen/walking layer | Intentionally excluded | No runtime citizen request, layer toggle, pending-review control, citizen metric or citizen export. This follows the latest requested scope. |
| Anchored controls and navigation | Passed | Survey, About and Filters open below their triggers; Settings, Export, Drive and Legend use the same card lifecycle. The detailed report remains modal. Sliding active navigation, keyboard dismissal/focus return, mutual exclusion and reduced-motion closing are covered. |
| Evidence card | Passed functional checks | Resized image, final labels, original correction, confidence/review state, local time and GNSS uncertainty. Sub-second LAN timing is not measured here. |
| Missing/unknown/corrected states | Passed fixtures | Isolated synthetic data; original sample unchanged. Missing frames never imply Normal. |
| Virtualized strip | Passed | Bounded visible nodes, chronological segment order, thumbnail/map synchronization and keyboard stepping. Replay follows matching frames when filters are active. |
| Playback and images | Passed | 1–5 segments/s, synchronized vehicle/selection, resized media only, maximum six concurrent image requests. |
| Per-km report | Passed | Longest drive has bins of 1,000 + 1,000 + 637.5 m. Coverage counts metres once; overlapping labels remain separate. Complete-drive scope is stated. |
| Video CSV | Passed | Current filters, UTF-8 BOM and § characters preserved. Export disabled while loading/stale. |
| Ward overlay | Passed functional checks | Historical 198-ward file, names and loaded-video counts/distressed length. Historical status and centre-based assignment documented. |
| API failure/recovery | Passed fixtures | Clear notice, disabled stale actions, 30-second retry and stale-response guards. |
| Credentials/local paths | Passed authored-assets scan | No browser secrets or absolute workstation paths. Original media only via explicit link. |
| Responsive visual confirmation | Passed at reviewed sizes | Desktop 855×853 and 1440×900; phones 375×812 and 375×667. Default dashboard, two-row metrics, player, expanded evidence, filters and Survey analysis reviewed. Short-phone width remains 375 px; the player leaves 173 px of clear map above the card and an 11 px card-to-strip gap. Metrics restore on player close. |

## Design review

The corrected dashboard has only **Video** and **Survey** in the primary navigation. Filters and Export are separate actions. Persistent metrics state that they describe the current drive-video filters; total route distance remains a separate map context control. Main GEOAI branding, typography and pale OpenFreeMap styling are retained in a restrained dashboard layout.

Desktop default and player screenshots were reviewed for clipping and information hierarchy. Review identified an expanded evidence card squeezed above the frame strip; expanded inspection now temporarily hides the player and uses the available map height. Phone metrics were changed from four tiny columns to a readable two-by-two rail. Expanded phone evidence may cover the metrics while open and restores them when closed.

The final drive-only screenshots were reviewed independently at desktop and 375×812 phone sizes. The expanded evidence sheet shows its image, labels, confidence, review state and metadata without dashboard overlays. The previous broader dashboard's results are not used as proof of this corrected layout. A further short-phone replay check identified limited map space; replay now temporarily hides the metric rail below 720 px viewport height and restores it on close. The final 375×667 browser check passed: document width 375 px, clear route space above the compact card, an 11 px card-to-player gap, and metrics restored after closing replay.

The latest motion update was reviewed separately in twelve fresh screenshots: desktop dashboard, Survey, Settings, drive inspection and expanded evidence; phone Survey, Settings, Filters, Export, report, player and expanded evidence. Cards align with their triggers, stay within the viewport, and retain accessible close/footer controls while their content scrolls. The primary navigation remains visible above the phone Survey card. No visual clipping or overflow was found in these reviewed states. Static screenshots establish final geometry; lifecycle tests and browser interaction checks establish opening, closing and focus behavior. Native-browser validation also caught and fixed deferred keyboard focus return after the modal report closes.

Motion durations match the reference interface: navigation 400 ms with `cubic-bezier(.22,1,.36,1)`, Survey/Filters/About 300 ms with an 8 px vertical offset, utility cards 250 ms, and evidence entrance/desktop width 550 ms. Reduced motion removes transitions and close delays. Playback frame updates do not repeat the evidence entrance. Floating cards retain opaque surfaces to avoid the WebGL backdrop artifacts found during the earlier review.

## Re-run

Place the original `gis_sample/` beside `webgis/`, then start the mock as described in README. Optional test dependencies are separate from the application:

```sh
npm install
npm test
python3 verification/api-integration.py http://127.0.0.1:8765
python3 verification/sample-truth.py
```

Copy only `webgis/` to the production server. Test code, package metadata and verification logs are optional handoff evidence.

## Repository integration review

The repository handoff and original sample ZIP match the sources used for development. A fresh install from the pinned dependency lock and `npm test` passed all 66 tests, including 36 UI tests. The added cases cover portable Python selection and all advanced detector scores, preserving zero values while showing missing values as unavailable. An explicit Python override also passed the five sample-contract tests. Windows launcher selection is tested with controlled fixtures; native Windows execution is not claimed. All 19 HTTP checks and 58 sample checks were rerun from the repository copy.

## Receiving-environment checks

Run the receiving team's API suite and smoke tests against its real FastAPI/VLM host. Confirm data, internet access, large-volume rendering and LAN preview latency. Deployment and acceptance on the real VLM server remain separate receiving-environment checks.
