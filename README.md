# spaceCanvas

SpacetimeDB-powered political canvassing demo. The runnable project is in [`space-canvas`](./space-canvas/).

## Current Status

The project now includes a Vite/React dashboard, SpacetimeDB TypeScript module, generated TypeScript bindings, Capacitor iOS/Android shells, and simulator scripts. The dashboard is centered on Travis County, TX, uses the provided Mapbox token through local env config, and shows live turf stats, selected-turf household status updates, volunteer GPS markers, and reducer activity.

The production SpacetimeDB module was published to `spacecanvas-5rvak` while preserving the existing `registered_voter` table, which currently contains 929,802 Travis County voter rows. The app derives live knock targets into the `voter` table as household-level rows with contact `status`, `last_contacted_at`, volunteer attribution, and registered-voter counts.

The main unfinished item is Travis turf materialization at full scale. A single reducer pass over all `registered_voter` rows overloaded the hosted instance, so the remaining work is to implement chunked household/turf generation or an external batch import before the full production demo can be considered complete.

See [`space-canvas/README.md`](./space-canvas/README.md) for setup, verification commands, APK testing, and the detailed completed/remaining work list.
