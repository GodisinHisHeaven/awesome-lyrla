# Near-arrival navigation map

[简体中文](navigation-map.zh-CN.md)

The existing navigation card automatically expands when ETA is at most three minutes or remaining distance is at most one kilometre, provided vehicle and destination coordinates are fresh. The toggle keeps a manual collapse for the current destination. Changing destination or leaving and re-entering the arrival zone restores automatic expansion.

The map uses a north-up tile background, supplied Tesla route geometry, and a red position marker. The arrow estimates route direction, not vehicle heading. Missing, stale or off-route geometry displays a dot without inventing a road. Wide layouts reserve space for lyrics; compact portrait and short landscape layouts reduce map height. The target keeps its existing control scale.

## Telemetry and fallback

- `Location`: 5-second interval, 10-metre minimum change, 15-second stationary resend; location expires after 30 seconds.
- `DestinationLocation` and `RouteLine`: 15-second interval, 60-second resend. Text navigation and destination expire after 90 seconds. A matching route can stay visible beyond its own 90-second age only while fresh destination, ETA and location evidence confirms the same trip.
- Routes support base64 precision-6 polylines and a Protobuf envelope containing the polyline in field 1. Input size and point counts are bounded. Only the final roughly four kilometres, at most 256 points, reach the browser. The route endpoint must be within 250 metres of the destination; a vehicle more than 500 metres from its nearest segment displays no route.
- Motion interpolates observed positions over 0.4–1.5 seconds. Nearby route corners guide the transition. Gaps over ten seconds, jumps over 300 metres, implausible speeds, destination changes, stale data, resize, visibility changes and reduced-motion preferences stop transitions. Positions are never forecast.
- Cancellation and vehicle changes clear map state. A destination-name change waits for a subsequent destination-coordinate update. A client timer collapses stale maps even when the event stream stops. Malformed optional map data does not reject usable lyrics or text navigation.

Coordinates and routes stay in process/page memory and are not added to application persistence, database tables or logs. These fields use the existing Tesla location authorization and telemetry configuration flow. The map does not request browser location or send vehicle commands. Existing vehicle configurations need the normal configuration synchronization to add these fields; this sync task does not contact vehicles.

## Base map configuration

Only the expanded map requests visible tiles. Browser caching is retained and no surrounding area is prefetched. The default background is OpenStreetMap, with visible attribution and a configurable provider. These build-time values are public:

```dotenv
VITE_NAVIGATION_MAP_TILE_URL=https://tile.openstreetmap.org/{z}/{x}/{y}.png
VITE_NAVIGATION_MAP_ATTRIBUTION=© OpenStreetMap contributors
VITE_NAVIGATION_MAP_ATTRIBUTION_URL=https://www.openstreetmap.org/copyright
```

Use only public browser credentials if your chosen provider requires a token. Review that provider's licensing and capacity before deployment. Tile requests reveal the client's IP, referrer and approximate displayed area through tile numbers. VIN, destination name and the full route are not sent as tile parameters. Failed tiles retain valid overlays and display a fallback message. The background is not Tesla's proprietary map.

## Verification

Unit regressions cover bounded decoding, trip continuity, expiry, vehicle changes, geometry, animation and malformed optional maps. Browser tests use synthetic player snapshots and stubbed tile images to exercise expansion, manual collapse, stale-data fallback and lyric space at desktop, portrait and short landscape sizes. Physical vehicle display and telemetry-latency acceptance remain unverified in this target.
