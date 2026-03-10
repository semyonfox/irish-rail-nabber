# Irish Rail Archive - Product Roadmap

**Goal**: Build subscription service for historical Irish Rail data. Start with Irish Rail only, add other APIs later.

---

## Phase 1: Foundation (Week 1-2)

### Setup Infrastructure
- [ ] Dockerfile with PostgreSQL 16.3 (locked)
- [ ] docker-compose.yml (local dev)
- [ ] Schema creation (30 tables)
- [ ] Daemon with async/await fetching

**Deliverable**: Docker runs, PostgreSQL fills with data, 24/7 collection

**Effort**: 6-8 hours

---

## Phase 2: Data Collection (Week 3-12)

### Run daemon continuously
- [ ] Deploy daemon to VPS (DigitalOcean/Linode €5-10/mo)
- [ ] Irish Rail fetches: 30s trains + 30s station boards
- [ ] Monitor fetch success rate (target >99%)
- [ ] Handle edge cases (missing trains, timeouts, API changes)

**Deliverable**: 90 days of clean historical data (~1M station events)

**Effort**: Monitoring/debugging only (30 mins/week)

**Timeline**: 90 days (mid-June 2025)

---

## Phase 3: Web UI (Week 8-12, parallel to Phase 2)

### Backend API (FastAPI)
- [ ] GraphQL schema for queries
- [ ] REST endpoints for dashboard
- [ ] Authentication (JWT)
- [ ] Rate limiting

```python
# dashboard_api.py
from fastapi import FastAPI
from strawberry.asgi import GraphQLRouter
import strawberry

@strawberry.type
class Query:
    @strawberry.field
    async def train_history(self, code: str, days: int) -> list[TrainSnapshot]:
        # Query DB...
        pass
    
    @strawberry.field
    async def delay_stats(self, station: str, period: str) -> DelayStats:
        # Aggregate from station_events...
        pass

app = FastAPI()
app.include_router(GraphQLRouter(schema), prefix="/graphql")
```

### Frontend (React/Vue)
- [ ] Dashboard: Live trains map (Leaflet)
- [ ] History search: Train delays over time
- [ ] Stats: Most delayed routes, busiest stations
- [ ] Download CSV: Export historical queries

**Deliverable**: Working dashboard showing real data

**Effort**: 40-60 hours (can outsource frontend)

---

## Phase 4: Stripe Integration (Week 12+, only after 90 days data)

### Payments
- [ ] Stripe account + API keys
- [ ] Subscription plans:
  - **Free**: Last 7 days, 100 queries/month
  - **Pro**: Last 90 days, unlimited queries = €25/month
  - **Enterprise**: Full history, webhooks, SLA = €500/month

- [ ] Webhook handling (subscription events)
- [ ] Usage tracking (rate limiting by plan)

```python
# payments.py
@app.post("/webhook/stripe")
async def stripe_webhook(request: Request):
    event = await request.json()
    
    if event['type'] == 'customer.subscription.created':
        user_id = event['data']['object']['metadata']['user_id']
        plan = event['data']['object']['items']['data'][0]['price']['lookup_key']
        # Store in DB, grant access
    
    return {"status": "ok"}
```

### Access Control
- [ ] Database: Add `users` table
- [ ] Auth: Login with email/password or GitHub
- [ ] Rate limiter: Check subscription tier before query
- [ ] Analytics: Track API usage per customer

**Deliverable**: Customers can pay, get access

**Effort**: 20-30 hours

---

## Phase 5: Marketing (Week 12+)

### Launch
- [ ] Landing page (Vercel: free)
- [ ] Pricing page with demo
- [ ] GitHub README (point to dashboard)
- [ ] Reddit r/ireland + HackerNews
- [ ] Irish startup groups (online)

### Target Customers
- Urban planners (Dublin City Council)
- Journalists (RTÉ, Irish Times)
- Researchers (TCD, UCD transport programs)
- Transport analysts
- Real estate firms (commute data)

**Deliverable**: 10-20 paying customers

**Effort**: 1-2 hours/week

---

## Timeline Overview

```
Week 1-2:    ████ Phase 1: Infrastructure
Week 3-12:   ████████████ Phase 2: Data collection (parallel work)
Week 8-12:   ████████ Phase 3: Web UI (parallel)
Week 12+:    ████ Phase 4: Stripe (wait for 90 days)
Week 12+:    ████ Phase 5: Marketing

June 2025:   Have 90 days data, launch Stripe
```

---

## Milestones & Go/No-Go Gates

### June 1 (Data collection start)
- [ ] Daemon running 24/7
- [ ] >99% fetch success rate
- [ ] DB grows to ~100K events/week
- **Go**: Continue | **No-go**: Debug API changes

### July 1 (30 days data)
- [ ] Web UI functional (dashboard visible)
- [ ] Can query any train in last 30 days
- [ ] Stats show patterns (busiest times, most delayed routes)
- **Go**: Continue | **No-go**: Redesign queries

### August 1 (60 days data)
- [ ] Free tier ready (7-day history)
- [ ] Stripe sandbox working
- [ ] 5-10 beta testers using dashboard
- **Go**: Plan launch | **No-go**: Fix payment issues

### September 1 (90 days data, LAUNCH)
- [ ] All tiers live (free, pro, enterprise)
- [ ] First paying customers
- [ ] API stable, <1% errors
- [ ] Documentation complete
- **Go**: Scale | **No-go**: Delay 2 weeks

---

## Scope: Irish Rail Only

**In Scope (Phase 1-5)**:
- Irish Rail real-time API (10 endpoints)
- 90+ days history
- Train positions, delays, arrivals/departures
- Station lookups
- Basic analytics

**Out of Scope** (Future phases):
- NTA GTFS-RT (buses, Luas)
- Dublin Bikes
- Air quality
- Weather
- Floods
- Electricity prices

---

## Architecture Checklist

### Phase 1
```
[ ] Dockerfile + docker-compose.yml
[ ] PostgreSQL schema (schema.sql)
[ ] Daemon (daemon.py) with 5 fetch tasks
[ ] Local testing on laptop
```

### Phase 2
```
[ ] VPS (DigitalOcean, €5/mo)
[ ] SSH keys, firewall setup
[ ] Deploy daemon with systemd
[ ] Automated backups (pg_dump daily)
[ ] Monitoring (fetch success rate alerts)
```

### Phase 3
```
[ ] FastAPI server
[ ] GraphQL schema
[ ] React frontend (or Svelte)
[ ] Leaflet map for trains
[ ] Search by train code/station
[ ] CSV export
[ ] Hosting (Vercel for frontend, VPS for backend)
```

### Phase 4
```
[ ] Stripe developer account
[ ] Users table (email, subscription_tier, stripe_id)
[ ] JWT authentication
[ ] Rate limiting middleware
[ ] Plan selectors (free/pro/enterprise)
```

### Phase 5
```
[ ] Landing page (Vercel)
[ ] Email for signups (Mailchimp free tier)
[ ] Analytics (Plausible or Fathom)
[ ] Social media (Twitter/LinkedIn)
```

---

## Tech Stack Summary

| Layer | Tech | Cost |
|-------|------|------|
| Database | PostgreSQL 16.3 | €5-15/mo (VPS) |
| Daemon | Python 3.11 + asyncio | Included |
| Backend | FastAPI + Strawberry | Included |
| Frontend | React/Svelte + Leaflet | €0 (Vercel) |
| Auth | JWT + bcrypt | Included |
| Payments | Stripe | 2.9% + 30¢ per transaction |
| Hosting | DigitalOcean VPS | €5/mo |
| Email | Mailchimp | €0 (free tier) |
| Monitoring | Sentry (optional) | €0-29/mo |

**Total startup cost**: €5-20/month

---

## Revenue Assumptions

### Conservative (Year 1)
- 20 paying Pro customers @ €25/mo = €6,000
- 5 Enterprise customers @ €500/mo = €2,500
- **Total**: €8,500/year = €708/month

### Aggressive (Year 1)
- 100 Pro customers = €30,000
- 20 Enterprise customers = €120,000
- **Total**: €150,000/year

### Minimal Breakeven
Need 11 Pro customers to cover hosting. Achievable by September.

---

## Risk Mitigation

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|-----------|
| API changes | Medium | High | Monitor changelog, versioning in DB |
| Data gaps (downtime) | Low | Medium | Redundant fetching, retry logic |
| Low customer interest | Medium | Medium | Launch free tier first, get feedback |
| Stripe fraud | Low | Medium | Verify card, stripe radar |
| Database grows too fast | Low | Medium | Archive old data to S3, partition tables |

---

## Success Criteria

- [ ] 90 days of continuous data collection (June 30)
- [ ] Web UI launched and functional (August 1)
- [ ] 5+ paying customers by September 30
- [ ] <0.5% API fetch failure rate
- [ ] <100ms GraphQL query response time
- [ ] 99.9% uptime (allow 1 day/year)

---

## Next Steps (This Week)

1. **Today**: Build Dockerfile + docker-compose.yml
2. **Tomorrow**: Write daemon.py with Irish Rail tasks
3. **This week**: Deploy to VPS, start collecting data
4. **This weekend**: Verify DB fills correctly
5. **Next week**: Start frontend planning

**Go time. 90 days to launch.** 🚀
