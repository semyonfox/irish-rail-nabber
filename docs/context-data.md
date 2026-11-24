# Weather and road traffic

`context_collector.py` runs inside the rail daemon and gathers conditions to line delays up against. Met Éireann data and TII's bulk files are CC BY 4.0. TII's map backend publishes no licence of its own, so treat what comes from it as reference data for private analysis and ask TII before republishing it. Set `CONTEXT_COLLECTION=0` to turn it off.

## Sources

| Data | Source | Cadence | Table |
|------|--------|---------|-------|
| Hourly observations, 25 synoptic stations | `prodapi.metweb.ie/observations/<slug>/today` and `/yesterday` | 30 min | `weather_hourly` (`source = 'live'`) |
| Quality-controlled hourly archive | `clidata.met.ie/cli/climate_data/webdata/hly<station>.csv` | one station per 10 min, `If-Modified-Since` | `weather_hourly` (`source = 'archive'`) |
| Weather warnings | `www.met.ie/Open_Data/json/warning_IRELAND.json` | 10 min | `weather_warnings` |
| Traffic counter sites, 394 | `trafficdata.tii.ie/dataserver/sites` | daily | `traffic_sites` |
| Rolling seven-day count and speed per site | `.../dataserver/siteDashboard/latestSpeed/<site>` | once per site per day | `traffic_site_weekly` |
| Annual average daily traffic per site, 2013 on | `.../dataserver/summary/yearly/<site>` | weekly per site | `traffic_site_yearly` |
| Daily counts per site and vehicle class | `data.tii.ie/Datasets/TrafficCountData/...per-site-class-aggr-<date>.csv` | backfill, 20 days an hour | `traffic_daily_class` |

## Things to know

- The live observations are not quality controlled. The archive replaces them hour by hour when it lands, never the other way round. The archive runs to the end of the previous month, and the live feed only covers today and yesterday, so the rest of the current month fills in next month.
- Live `reportTime` is read as Irish local time. Archive dates are UTC. Both are stored as `timestamptz`.
- Wind is in knots in both feeds, going by Met Éireann's metadata. The live Dublin Airport feed is empty, so Casement and Phoenix Park cover Dublin live.
- The archive import starts at `WEATHER_ARCHIVE_FROM` (default 2013-06-01, the first TII counts). Each station is about 117k hours and takes about a minute.
- TII reports speeds in millimetres per second. They are stored in km/h.
- TII only exposes a rolling seven-day window per site, not hourly counts. One snapshot a day builds history, and `source_days` says which days a snapshot covered, since a site with gaps reaches further back. The per-site hourly dashboards are behind reCAPTCHA and are not used.
- `data.tii.ie` stopped publishing daily files in April 2021. The bulk backfill covers June 2013 to April 2021 and records missing days as zero rows. Counters are keyed by `cosit`, which joins to `traffic_sites.cosit`.
- TII's dataserver is the backend of their public map. Every call, whichever task makes it, goes through one limiter two seconds apart. A 429, server error or connection failure stops the pass and the next hourly run carries on. A site is tried once a day for its weekly snapshot whether or not it answers, and a site whose yearly summary fails waits 6 hours.
- The weather archive re-reads the last 45 days before its previous import whenever a station's file changes, so revised hours replace old ones. A file without the expected header doesn't advance anything, and the station goes to the back of the queue.
- A bulk TII day is only recorded once it returns a real file or a confirmed missing one (403 or 404). Anything else stops the run and the day is retried.
