# Irish Rail Archive - Documentation Index

Irish Rail data archiver. Fetches real-time rail data to SQLite.

## Quick Start

```bash
python3 archive.py
```

Done. Data stored in `irish_rail.db`.

## Documentation Map

### For Users

| Document | Purpose | Audience |
|----------|---------|----------|
| [SETUP.md](SETUP.md) | Installation & requirements | First-time setup |
| [USAGE.md](USAGE.md) | How to query, automate, integrate | Daily users |
| [API_ENDPOINTS.txt](API_ENDPOINTS.txt) | API reference (quick) | API consumers |

### For Developers

| Document | Purpose | Audience |
|----------|---------|----------|
| [README.md](README.md) | Full API documentation (detailed) | API integration |
| [DATABASE.md](DATABASE.md) | Schema design & queries | Database work |
| [ARCHITECTURE.md](ARCHITECTURE.md) | System design & decisions | Code review |

### Code

| File | Purpose | Size |
|------|---------|------|
| [archive.py](archive.py) | Main script - fetch & store | 477 lines |
| [irish_rail.db](irish_rail.db) | SQLite database | 288KB |

## By Use Case

| Goal | See |
|------|-----|
| Fetch data once | [SETUP.md](SETUP.md) → Run `python3 archive.py` |
| Schedule hourly | [SETUP.md](SETUP.md) → Cron section |
| Query data | [USAGE.md](USAGE.md) → Database Queries |
| Use from C++ | [SETUP.md](SETUP.md) → C++ Integration |
| API endpoints | [README.md](README.md) or [API_ENDPOINTS.md](API_ENDPOINTS.md) |
| Database schema | [DATABASE.md](DATABASE.md) |
| System design | [ARCHITECTURE.md](ARCHITECTURE.md) |
| Analytics | [USAGE.md](USAGE.md) → Python Integration |
| Export data | [USAGE.md](USAGE.md) → Data Export |

## Project Stats

- **Language**: Python 3.7+
- **Dependencies**: None (stdlib only)
- **Lines of code**: 477 (single file)
- **Documentation**: 1,954 lines across 5 markdown files
- **Data coverage**: 171 stations, 80+ trains, 1000+ board entries
- **Update frequency**: ~2.7 seconds (measured)
- **Database**: SQLite (no external dependencies)

## File Structure

```
irish-rail-nabber/
├── archive.py              # Main executable script
├── irish_rail.db           # SQLite database (auto-created)
│
├── INDEX.md                # This file (documentation index)
├── README.md               # Complete API documentation
├── SETUP.md                # Installation & setup guide
├── USAGE.md                # Usage examples & queries
├── DATABASE.md             # Database schema details
├── ARCHITECTURE.md         # System design & components
│
└── API_ENDPOINTS.txt       # Quick API reference
```

## API Endpoints (Summary)

All documented in [README.md](README.md#irish-rail-api-documentation):

1. `getAllStationsXML` - All 171 stations
2. `getAllStationsXML_WithStationType` - Stations by type
3. `getCurrentTrainsXML` - Live train positions
4. `getCurrentTrainsXML_WithTrainType` - Live trains by type
5. `getStationDataByNameXML` - Station boards by name
6. `getStationDataByCodeXML` - Station boards by code
7. `getStationsFilterXML` - Search stations
8. `getTrainMovementsXML` - Train journey logs

## Database Tables

All detailed in [DATABASE.md](DATABASE.md):

- **stations** (171 records) - Static station data
- **current_trains** (~80 records) - Live positions
- **station_boards** (1000+ records) - Schedules
- **train_movements** (100-200 records) - Journey logs
- **fetch_log** (4+ records/run) - Metadata

## Common Commands

### Run archiver
```bash
python3 archive.py
```

### Query database
```bash
sqlite3 irish_rail.db "SELECT COUNT(*) FROM stations;"
```

### Schedule hourly
```bash
(crontab -l 2>/dev/null; echo "0 * * * * cd /path && python3 archive.py") | crontab -
```

### Export to CSV
```bash
sqlite3 irish_rail.db ".mode csv" ".output stations.csv" "SELECT * FROM stations;"
```

See [USAGE.md](USAGE.md) for more examples.

## Performance

- **Typical runtime**: 30-60 seconds per run
- **API calls**: ~183 per run
- **Database size growth**: ~5-10KB per run
- **Bottleneck**: Network I/O (waiting for API)

## Architecture

Simple 3-layer design:

```
Irish Rail API
       ↓
   archive.py
       ↓
  irish_rail.db
```

See [ARCHITECTURE.md](ARCHITECTURE.md) for full system design.

## Support

- No external support (API provided as-is)
- Irish Rail disclaimer: See [README.md](README.md)
- Weak coverage areas: See [README.md](README.md#coverage--limitations)

## License

Public domain (no restrictions).

## Getting Help

- **How do I install?** → [SETUP.md](SETUP.md)
- **How do I use it?** → [USAGE.md](USAGE.md)
- **What's in the database?** → [DATABASE.md](DATABASE.md)
- **How does it work?** → [ARCHITECTURE.md](ARCHITECTURE.md)
- **What API endpoints?** → [README.md](README.md) or [API_ENDPOINTS.txt](API_ENDPOINTS.txt)

---

**Start here**: Pick your use case above, follow the link, and start using the archiver!
