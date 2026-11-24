# Irish bus GPS sources and public API discovery

Research date: 14 September 2026. This is a read-only investigation; no discovered feed was added to production.

## What the evidence establishes

**Transit’s sampled route 409 data shares the same underlying GPS observations as NTA.** A fresh Transit response contained two vehicles; both matched observations already stored from NTA on vehicle ID, source timestamp and coordinates. This rules out a wholly different GPS reading for those samples. It does not reveal Transit’s contractual access, which endpoint it uses, or the origin of every Irish route in Transit.

**Other operators do have separate public trackers.** The strongest measured alternative was Swords Express: four samples over 36 seconds showed GPS timestamps advancing by 8–16 seconds, with readings approximately 4–10 seconds old. Aircoach exposes route geometry, stops, timetables and vehicle positions through its website. Several independent operators share tracker suppliers, offering a more practical discovery path than writing an adapter for every company.

**No verified alternative live feed for City Direct 411 was found.** This is a coverage gap, not proof that the buses lack GPS. An NTA parliamentary response specifically addresses City Direct and the proposed AVL Light system.[^citydirect]

## Scope and evidence standards

The website audit covered all **103 agency records** in the application's active national bus GTFS feed, across **84 distinct website hostnames**. The feed contains 783 bus routes. Shared websites were deduplicated for HTTP checks, although www/non-www names remain separate hostnames. The audit checked each published homepage, DNS and root responses for `api.<domain>`, and `/api/`, then followed relevant public tracker links and inspected selected JavaScript bundles.

This is not a census of every bus business on the island. Charter-only companies, event services, aliases and Northern Ireland operators are not exhaustively represented by that GTFS feed. To cover the wider licensed market, `licences.csv` extracts **329 licensed services and 126 distinct operator-name strings** from NTA's register dated **8 September 2026**. It includes Regular and Specific Targeted services; the register excludes event and venue licences. Legal names and trading names do not map one-to-one to GTFS agencies. The 126 names have not all received a separate endpoint audit.[^licences]

Files:

- `operators.csv`: all 103 GTFS agency records, website checks and tracker links.
- `operator-web-audit.json`: the underlying website audit, with URL query strings removed.
- `licences.csv`: current public licence-register extraction; operator-name strings are not entity-resolved.
- `endpoints.csv`: selected useful endpoints and their verification level.

A working public web endpoint is not automatically a supported, licensed bulk API. The investigation distinguishes successful JSON reads, endpoints visible in published frontend code, and unresolved leads. It did not bypass authentication, probe private customer records, or investigate ticket/passenger lookup functions. Failed DNS, 403s, timeouts and HTML responses do not prove that an operator has no API.

## Transit versus NTA: why the same data can look faster

There are three different clocks:

1. The vehicle produces a new GPS observation.
2. An aggregator receives or refreshes it.
3. Our collector fetches and displays it.

Our current collector alternates vehicle positions and trip updates at approximately 60.001-second intervals. Consequently, **each individual feed is fetched roughly every 120 seconds**. This is a collector schedule, not the GPS hardware's update interval.

NTA's published policy specifies one request per 60 seconds **per token**, and says user limits may be changed at NTA's discretion. The published default therefore does not establish the access arrangement available to Transit or another commercial partner.[^quota] A higher quota or a direct connection to the same upstream AVL system could explain fresher access; neither has been confirmed for Transit.

### Direct comparison

At **2026-09-14 21:17:28 UTC**, one Transit route 409 vehicle response was compared with existing NTA observations in the database. Both returned vehicles matched:

- vehicle ID;
- exact source timestamp;
- latitude and longitude within 0.000001 degrees.

Result: **2 of 2 matched**. The comparison used existing NTA records and did not add extra NTA requests. It demonstrates common underlying readings for this sample, not that the two providers use identical URLs or infrastructure.

An earlier three-minute Transit test made 13 requests, 15 seconds apart. Three actively updating vehicles produced 21 timestamp changes: median **31 seconds**, range **21–37 seconds**. Active observation age ranged from 15.6 to 54.6 seconds. Two older vehicles eventually disappeared. HTTP response times were 339–463 ms, with no rate-limit responses.

Transit’s supplied free allocation is 5 calls/minute and 1,500/month. Fifteen-second polling exhausts that monthly allocation in 6.25 hours. The tested vehicle endpoint is route-scoped, making a national collector expensive in calls. Its public documentation describes the endpoint, but does not establish the upstream supplier for each route.[^transit]

**Recommendation:** request a higher NTA quota and clarification of feed-specific access first. The evidence does not justify paying Transit solely to obtain supposedly different Bus Éireann GPS data. Transit could still add coverage or other product features; those require separate validation.

## Verified and discoverable operator trackers

| Operator / family | Public interface | Verification | Refresh evidence |
|---|---|---|---|
| Swords Express | WordPress-theme GPS JSON endpoint | Successful repeated JSON reads | GPS timestamps advanced 8–16 s in a 36 s sample |
| Aircoach | `/api/track-my-coach-*` | Routes and timetable/position JSON returned | Website polls selected service every 10 s; GPS cadence not measured |
| Dublin Coach, Wexford Bus, Burkes, Flightlink, Kearns, West Cork Connect | TM Panel | Official tracker links and frontend request code | Frontend selected-journey refresh: 30 s |
| Collins, Slieve Bloom, St Kevin’s, Nolan Coaches | FutureFleet | Official links and published request code | Not measured |
| Citylink | BusHub | Official tracker scripts expose API origin | Not measured; live API payload not verified |
| Dublin Express | uTrack | Official tracker configuration exposes API origin | Not measured; live API payload not verified |
| JJ Kavanagh | Official ticket-site tracker | Redirect to current tracker verified | Not measured |
| Express Bus | Dedicated bus-tracker website | Public tracker located | Not measured |
| City Direct 411 | No working alternative identified | Homepage/API checks and Transit route check | Transit vehicle response was empty |

### Swords Express: the best measured new source

The official site publishes a GPS script which fetches:

`GET https://www.swordsexpress.com/app/themes/swordsexpress/resources/assets//scripts/latlong.php`

The double slash appears in the site's script and worked during the test. The response contained 33 fleet records, of which four were visible vehicles. Visible records include a fleet label, coordinates, local timestamp, speed and direction. Other records carry a `hidden` marker; those must not be treated as active map positions.[^swords]

Four reads spaced 12 seconds apart produced 12 timestamp advances:

`10, 11, 12, 10, 8, 12, 16, 15, 15, 11, 11, 10 seconds`

All four visible timestamps changed between each pair of reads. Three, two and three vehicles respectively changed position. Timestamp ages were 3.6–10.0 seconds, interpreting the source's unqualified local clock as Europe/Dublin. This is a small observed sample, not a service guarantee. The website's countdown refreshes in approximately 12 seconds; its one-second countdown tick is not a one-second data refresh.

This endpoint batches the visible fleet in one request, making it attractive for call efficiency. However, the sampled schema did not supply obvious GTFS trip or route IDs. Mapping vehicles reliably to scheduled journeys needs further work. No developer rate contract or redistribution licence was established.

### Aircoach: richer data, with a timestamp problem

The official tracker exposes these read endpoints:[^aircoach]

- `GET https://www.aircoach.ie/api/track-my-coach-services?_format=json`
- `GET https://www.aircoach.ie/api/track-my-coach-service-timetables?operator=ACAH&service=700&direction=inbound`

The services response includes routes, directions, geometry and stops. The selected-service response includes journeys, scheduled stop times, vehicle coordinates, progress and occupancy-related fields. Successful JSON responses were observed without an API key. The frontend polls the chosen service/direction every ten seconds; that does not prove every response contains a new GPS fix.

A sampled response had `request_time` of **22:18:53+01:00** but vehicle `recorded_at_time` of **23:18:05+01:00** on the same date. That apparent one-hour timestamp inconsistency needs investigation before using this feed for delay history or freshness comparisons. Do not silently subtract an hour from all records without confirming the source convention.

Unlike the Swords fleet endpoint, this live call is scoped to a service and direction. Scaling it across the network therefore takes more calls. Cache the static route response separately.

### TM Panel: one tracker family across several operators

Official operator websites link to these trackers:

- Dublin Coach: <https://coachtracker.tmpanel.co.uk/DublinCoach>
- Wexford Bus: <https://tracking.wexfordbus.com/Standard>
- Burkes: <https://bustracker.tmpanel.co.uk/BurkesBus>
- Flightlink: <https://coachtracker.tmpanel.co.uk/Flightlink>
- Kearns: <https://coachtracker.tmpanel.co.uk/kearns>
- West Cork Connect: <https://coachtracker.tmpanel.co.uk/WestCork>

Published `Standard.js` identifies read-oriented POST actions: `/Standard/GetStageByRoute`, `/Standard/GetJourney`, `/Standard/GetJourneyTraking` and `/Standard/NewGetJourneyTraking` (spellings as published). Requests use normal browser session/anti-forgery state and selected route or journey parameters. These actions were identified in code; no successful live-position POST is claimed here.[^tmpanel]

The actual refresh interval is **30,000 ms**, despite a misleading nearby comment referring to ten seconds. The tracker stops automatic refreshing after 30 minutes. This is evidence about the web client, not vehicle reporting cadence. The platform's legal supplier identity and bulk licensing were not established; it should not be confused with unrelated similarly named businesses.

### FutureFleet / METRIC: another shared platform

Collins Coaches, Slieve Bloom and St Kevin's/Glendalough link to FutureFleet's passenger tracker. Nolan Coaches has a branded journey-selection page on the same domain. Published passenger code identifies read-oriented POST paths:[^futurefleet]

- `/daverest/v1/realtime/liveJourney/options`
- `/daverest/v1/realtime/liveJourney/map`
- `/daverest/v1/realtime/livePassJourneys/`
- `/daverest/v1/realtime/liveJourney/latest/map`

These use operator and journey selection parameters. No arbitrary journey identifiers were enumerated, and no live backend response or refresh cadence was established. METRIC's own product pages describe public-transport tracking and schedule-adherence products, providing a supplier contact path.[^metric]

An operator code in frontend configuration alone is not proof of an active customer or complete feed. Ashbourne Connect's published link to `yougo.ie/live/map` failed during the investigation and remains an unresolved legacy lead.

### Citylink / BusHub and Dublin Express / uTrack

Citylink's official tracker loads BusHub's Irish Citylink script and portal bundle. The latter exposes **`https://api-v3.nextstopapp.co.uk`** as an API origin. BusHub advertises a Mobility API and real-time information integration. This is a promising shared supplier route, but no authenticated contract, full endpoint schema or live response was validated.[^citylink][^bushub]

Dublin Express's tracker configuration identifies **`https://nx.origin.utrack.com/api`**. Again, a published base URL is discovery evidence, not a working anonymous bulk API. uTrack's customer page includes Irish operators; customer logos alone do not prove that all their live data is available through this particular endpoint.[^dublinexpress][^utrack]

JJ Kavanagh's older realtime URL redirects to its current ticket-site `trackTrip` page. Express Bus has a dedicated public tracker. Neither was sampled for GPS cadence. They remain useful follow-up targets, not completed integrations.[^jj][^expressbus]

## What guessing API hostnames actually found

The sweep checked the names requested, including `api.<operator-domain>` and `/api/`. Several API hostnames resolved, but few provided useful API discovery:

- `api.collinscoaches.ie` returned an ordinary WordPress homepage.
- `api.aranislandferries.com` returned HTML, not a verified API.
- `api.buseireann.ie` returned 403; access was not bypassed.
- `api.transportforireland.ie` returned 404 at its root.
- Other hosts timed out or failed requests; these remain inconclusive.

Some `/api/` paths returned the site's normal HTML fallback. DNS can also resolve through wildcard configurations. **Neither a resolved hostname nor HTTP 200 establishes an API.** Published frontend code and official tracker links were much more productive than hostname guesses. The CSV preserves failures as well as successes so unresolved operators are not silently dropped.

## Public records explain the fragmented supply

NTA awarded the replacement bus AVL contract to **Trapeze ITS UK in December 2023**. The procurement describes national AVL provision and a lighter option for smaller/commercial operators.[^award][^tender]

The final business case, dated **October 2023** although hosted in a 2026 upload directory, describes the legacy mix: Dublin Bus and part of Go-Ahead using INIT, alongside Trapeze deployments at Bus Éireann and other Go-Ahead services. This supports a multi-system origin for Irish tracking; it does not identify Transit's private supply arrangements.[^businesscase]

A reply to **PQ 22390/24, dated 21 May 2024**, specifically addresses City Direct. It describes a planned lower-cost **AVL Light** option for licensed private operators, subject to State Aid approval, with voluntary participation and charges then undefined. It supplied no installation date. It therefore explains a route towards filling the gap, not evidence that 411 is tracked today.[^citydirect]

A later reply to **PQ 19655/25** describes consolidation of five systems, installations on roughly 1,800 buses, a planned late-2025 pilot and migration targeted for late 2026/early 2027, subject to testing. This is a historical delivery plan; this investigation did not establish the current completion status.[^rollout]

### Historical data and backfill

- A public **2013 Dublin Bus GPS sample** is catalogued with timestamp, location and journey/delay-related fields. It is a historical research dataset, not a current live feed. Its old download has previously failed in this project; no successful new download or import is claimed here.[^archive]
- The government catalogue lists Dublin Bus AVL data, but a catalogue entry is not necessarily an open downloadable dataset or public API. The entry's classification requires care; no personal records were accessed.[^catalogue]
- NTA annual bulletins and published performance tables can support aggregate historical analysis. They cannot reconstruct missing vehicle-by-vehicle GPS history.[^bulletins]

Useful questions for NTA/operator enquiries or a focused records request: current operator-by-operator GTFS-RT coverage; eligibility for increased API quotas; City Direct/AVL Light deployment status; and availability, licence and retention of non-personal historical vehicle observations. No enquiry was sent.

## Northern Ireland

Translink NI must be treated separately from the similarly named Canadian and Australian agencies. Its official open-data page and OpenDataNI publish schedule/route datasets. A rail-arrivals dataset describes two-minute caching, but that is not evidence of a bus-position API.[^ni]

An independent open-source documentation lead references **`vpos.translinkniplanner.co.uk`** and a vehicle-monitoring interface. It was not validated in this investigation and should be treated as an unresolved lead, not a confirmed alternative feed.[^nilead] The published Northern Ireland licensed-operator register provides a wider scope list for a dedicated NI audit.[^niregister]

## Recommended next steps

1. **Keep NTA as the national primary source.** Seek a higher quota and clarify feed access. This has the best prospect of improving nationwide freshness with few requests.
2. **Prioritise Swords Express for a permitted supplemental integration.** It has measured fresher GPS and fleet batching. Resolve GTFS mapping and access terms first.
3. **Investigate Aircoach's timestamp convention**, then assess service/direction call cost and permission for historical storage.
4. **Approach the shared tracker suppliers**—TM Panel, METRIC/FutureFleet, BusHub and uTrack—for a documented fleet feed. A supported batch interface is preferable to polling hundreds of individual journey pages.
5. **Keep City Direct 411 explicitly marked as lacking verified live positions.** Continue showing its scheduled route and stops; do not infer vehicles from timetables or animate fabricated live positions.
6. **Do not promise subsecond data.** None of the tested sources established it. Smooth map animation and immediate local-cache rendering can improve presentation without misrepresenting observation freshness.

No production settings, collection frequencies, deployments or database contents were changed for this research.

## Sources

[^quota]: NTA API usage policy: https://developer.nationaltransport.ie/usagepolicy
[^transit]: Transit public API v4 documentation: https://api-doc.transitapp.com/v4.html . Quota figures also come from the access email supplied by the user.
[^licences]: NTA current licence page: https://www.nationaltransport.ie/commercial-bus-services/view-list-of-current-licences/ ; register dated 8 September 2026: https://www.nationaltransport.ie/wp-content/uploads/2026/09/260908_CurrentLicences.pdf
[^swords]: Official site https://www.swordsexpress.com/ ; published GPS client https://www.swordsexpress.com/app/themes/swordsexpress/resources/assets/scripts/gps-script.js?v=2.0 ; direct endpoint and measurements described above.
[^aircoach]: Official tracker https://www.aircoach.ie/track-my-coach ; frontend https://www.aircoach.ie/modules/custom/track_my_coach/js/track-my-coach.min.js?v=1 ; successful endpoint reads described above.
[^tmpanel]: Operator tracker links listed above; shared frontend https://coachtracker.tmpanel.co.uk/contents/js/Standard.js . Evidence is published client code, not completed backend sampling.
[^futurefleet]: https://leap.futurefleet.com/track-journey/ ; https://leap.futurefleet.com/track-journey/js/passenger.js ; https://leap.futurefleet.com/nolan-coaches/#/journey/select
[^metric]: Supplier product pages https://www.metrictristarinc.ie/realtime.html and https://www.metricgroup.co.uk/metric-public-transport/
[^citylink]: Official tracker https://www.citylink.ie/track-my-bus/ ; assets https://cdn.bushub.co.uk/irishcitylink/js/script.js and https://wa-portal.bushub.co.uk/production/portal-package.js
[^bushub]: BusHub's description of its web platform and Mobility API: https://www.bushub.co.uk/web-platform/
[^dublinexpress]: Official tracker https://coachtracker.dublinexpress.ie/ ; public configuration https://coachtracker.dublinexpress.ie/configs/global.js?v=2
[^utrack]: Supplier site https://www.utrack.com/
[^jj]: https://realtime.jjkavanagh.ie/ redirects to https://tickets.jjkavanagh.ie/trackTrip ; official terms link to tracker: https://jjkavanagh.ie/terms/
[^expressbus]: Public tracker https://bustracker.expressbus.ie/
[^award]: NTA contract announcement, 20 December 2023: https://www.nationaltransport.ie/news/nta-awards-bus-avl-contract-to-trapeze-its-uk-ltd/
[^tender]: Published procurement notice: https://irl.eu-supply.com/ctm/Supplier/PublicTenders/ViewNotice/246639
[^businesscase]: October 2023 final business case, legacy-system discussion around PDF page 28: https://www.nationaltransport.ie/wp-content/uploads/2026/05/NG-AVL-Final-Business-Case.pdf#page=28
[^citydirect]: NTA replies, PQ 22390/24, around PDF page 550: https://www.nationaltransport.ie/wp-content/uploads/2024/08/NTA-Responses-to-Parliamentary-Questions-Bulletin-1-Q1-Q2-of-2024.pdf#page=550
[^rollout]: NTA replies, PQ 19655/25: https://www.nationaltransport.ie/wp-content/uploads/2025/11/NTA-Responses-to-Parliamentary-Questions-Bulletin-5-Q2-of-2025-Final.pdf
[^archive]: Official historical sample catalogue: https://data.gov.ie/dataset/dublin-bus-gps-sample-data-from-dublin-city-council-insight-project/resource/ca0f34b8-c369-43e2-9c52-1ba46f8c5936
[^catalogue]: Government AVL dataset catalogue entry: https://datacatalogue.gov.ie/dataset/automatic-vehicle-location-avl
[^bulletins]: NTA annual bulletins: https://www.nationaltransport.ie/public-transport-services/annual-bulletins/
[^ni]: Translink NI open-data page https://www.translink.co.uk/legal-information/freedom-of-information-and-open-data ; OpenDataNI transport catalogue https://admin.opendatani.gov.uk/dataset/?groups=transport&tags=Public+Transport ; rail-specific dataset https://admin.opendatani.gov.uk/dataset/real-time-rail-stations-arrivals-and-departures
[^nilead]: Independent source-code documentation, unresolved lead: https://bolster.help/autoapi/bolster/data_sources/translink/index.html
[^niregister]: Northern Ireland licensed bus operators: https://www.data.gov.uk/dataset/74a36cbd-3a12-496a-bac1-ee0e53a6d303/licensed-bus-operators-in-northern-ireland
