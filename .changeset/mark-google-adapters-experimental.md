---
'@richardmcquiston01/storage-adapters': patch
---

Mark `/gcs`, `/google-drive` and `/google-sheets` as Experimental (tagged `@experimental`, listed in the README Stability section). Their tests in CI use an emulator or a fake, not the real service, so they may change in a minor release until a real run is recorded. No behavior changes. The README now also lists the ten server-backed entry points added since 0.15 as Stable.
