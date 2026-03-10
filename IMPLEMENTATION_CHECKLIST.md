# Implementation Checklist

Track progress Week by Week for Phases 1-5.

---

## Phase 1: Foundation (Week 1-2)

### Week 1 - Setup

- [ ] **Day 1**: Create Dockerfile (PostgreSQL 16.3 + Python 3.11)
- [ ] **Day 1**: Create docker-compose.yml (postgres + daemon services)
- [ ] **Day 2**: Write schema.sql (30 tables)
- [ ] **Day 2**: Create requirements.txt (psycopg, aiohttp, asyncpg)
- [ ] **Day 3**: Write daemon.py skeleton (IrishRailDaemon class)
- [ ] **Day 4**: Implement fetch_api() and XML parsing
- [ ] **Day 4**: Implement fetch_irish_rail_trains() (30s loop)
- [ ] **Day 5**: Implement fetch_irish_rail_station_boards() (iterate all stations)
- [ ] **Day 5**: Implement record_fetch() for logging

**Verify**: `docker-compose up` runs, daemon connects to DB

### Week 2 - Testing & Edge Cases

- [ ] Test fetch with missing/malformed XML
- [ ] Test database UNIQUE constraints (deduplication)
- [ ] Test station_events table fills on each run
- [ ] Verify fetched_at timestamps are correct
- [ ] Handle timeouts (requests hanging)
- [ ] Handle API errors (500s, no response)
- [ ] Verify no data loss on daemon restart
- [ ] Performance: <2s per station board fetch

**Verify**: 24 hours of continuous collection, zero crashes

---

## Phase 2: Data Collection (Week 3-12, parallel)

### Deployment (Week 3)

- [ ] Choose VPS (DigitalOcean $5/mo recommended)
- [ ] Create droplet (Ubuntu 22.04, 1GB RAM)
- [ ] Setup SSH keys (no passwords)
- [ ] Install Docker + Docker Compose
- [ ] Clone git repo
- [ ] Configure `.env` with DB password
- [ ] Run `docker-compose up -d`

**Verify**: Daemon running 24/7, check logs: `docker-compose logs -f daemon`

### Monitoring (Week 3-12, ongoing)

- [ ] Setup monitoring script:
  ```bash
  # monitor.sh - Run daily
  docker-compose logs --tail=100 daemon | grep -c "status.*success"
  ```

- [ ] Track metrics:
  - [ ] Fetch success rate (target >99%)
  - [ ] Average response time
  - [ ] Database growth rate (~100K rows/week)
  - [ ] Downtime incidents

- [ ] Set up basic alerts:
  - [ ] Email if daemon crashes
  - [ ] Alert if fetch success <95%

- [ ] Weekly maintenance:
  - [ ] Review error logs
  - [ ] Verify database backup exists
  - [ ] Check disk space (should be <10GB for 90 days)

**Deliverable**: Dashboard showing success rate + data volume

### Edge Case Handling (Week 3-12, as issues arise)

- [ ] Handle API rate limiting (add backoff)
- [ ] Handle duplicate data (UNIQUE constraint handling)
- [ ] Handle schema changes (Irish Rail API updates)
- [ ] Handle timezone issues (Irish time vs UTC)
- [ ] Handle missing stations (new lines added)

---

## Phase 3: Web UI (Week 8-12, parallel)

### Backend (Week 8-9)

- [ ] FastAPI server scaffold
- [ ] Connect to PostgreSQL
- [ ] GraphQL schema definition:
  - [ ] Query: `train_history(code, days)`
  - [ ] Query: `station_events(station, days)`
  - [ ] Query: `delay_stats(station, period)`
  - [ ] Query: `live_trains()`

- [ ] REST endpoints:
  - [ ] GET `/api/trains` (live)
  - [ ] GET `/api/trains/{code}/history`
  - [ ] GET `/api/stations/{code}/events`
  - [ ] GET `/api/stats/delays`

**Verify**: GraphQL playground works, can query test data

### Frontend (Week 9-10)

- [ ] Setup React/Svelte project
- [ ] Install Leaflet (mapping library)
- [ ] Pages:
  - [ ] Dashboard (live trains map)
  - [ ] Train Search (history by code)
  - [ ] Station Board (arrivals/departures)
  - [ ] Analytics (delay stats, busiest times)

- [ ] Features:
  - [ ] Map showing all current trains (lat/lon)
  - [ ] Click train → show history
  - [ ] Search by station code → show events
  - [ ] Chart: delays over time
  - [ ] Download CSV button

**Verify**: Dashboard loads, shows >100 trains on map

### Hosting (Week 11)

- [ ] Frontend to Vercel (drag & drop)
- [ ] Backend to VPS (Docker container)
- [ ] Configure CORS (allow dashboard to query API)
- [ ] Setup domain (optional, can use IP)

**Verify**: Frontend loads, can query backend from browser

---

## Phase 4: Stripe (Week 12+, only after 90 days)

### Stripe Setup (Week 12)

- [ ] Create Stripe account
- [ ] Define products:
  - [ ] Free (€0, 7-day history, 100 queries/mo)
  - [ ] Pro (€25/mo, 90-day history, unlimited)
  - [ ] Enterprise (€500/mo, full history, support)

- [ ] Setup webhook endpoint
- [ ] Test in Stripe sandbox mode

**Verify**: Can create test subscription in dashboard

### Database Changes (Week 12)

- [ ] Add `users` table (email, stripe_id, plan)
- [ ] Add `api_keys` table (user_id, key, created_at)
- [ ] Add `usage_log` table (user_id, endpoint, timestamp)
- [ ] Add `subscriptions` table (user_id, plan, started_at, ended_at)

**Verify**: Can insert test user and subscription

### Auth (Week 12-13)

- [ ] Implement JWT token generation
- [ ] Implement password hashing (bcrypt)
- [ ] Add `/auth/signup` endpoint
- [ ] Add `/auth/login` endpoint
- [ ] Add `/auth/verify` (check token)

**Verify**: Can signup, login, get token

### Access Control (Week 13)

- [ ] Rate limiting middleware:
  ```python
  FREE: 100 queries/month
  PRO: unlimited
  ENTERPRISE: custom
  ```

- [ ] Query filtering:
  ```python
  FREE: WHERE fetched_at > NOW() - 7 days
  PRO: WHERE fetched_at > NOW() - 90 days
  ENTERPRISE: WHERE fetched_at > NOW() - 1 year
  ```

- [ ] Implement rate limit headers

**Verify**: Free user can query, Pro user gets more history

### Payments (Week 13)

- [ ] Add Stripe checkout button
- [ ] Handle subscription.created webhook
- [ ] Handle subscription.deleted webhook
- [ ] Sync user plan to DB

**Verify**: Can subscribe, get charged, plan updates in DB

---

## Phase 5: Marketing (Week 12+)

### Landing Page (Week 12)

- [ ] Create Vercel project (or Webflow)
- [ ] Sections:
  - [ ] Hero (problem: no Irish Rail history)
  - [ ] Features (90-day archive, real-time updates)
  - [ ] Pricing table (free/pro/enterprise)
  - [ ] Demo (embedded dashboard)
  - [ ] FAQ
  - [ ] Sign up

**Verify**: Page loads, pricing visible, sign up works

### Email Setup (Week 12)

- [ ] Create Mailchimp account (free tier)
- [ ] Setup welcome email sequence
- [ ] Create monthly newsletter template
- [ ] Add subscribe form to landing page

**Verify**: Can signup, receive welcome email

### Content (Week 13)

- [ ] Write 3 blog posts:
  - [ ] "Why Irish Rail History Matters"
  - [ ] "Analyzing 90 Days of Train Delays"
  - [ ] "API for Transport Data"

- [ ] Create social media accounts (Twitter, LinkedIn)

**Verify**: Blog posts published, social posts visible

### Launch (Week 13-14)

- [ ] Post to r/ireland
- [ ] Post to r/irishdev
- [ ] Post to HackerNews (if confident)
- [ ] Email contacts (if any)
- [ ] Message transport companies
- [ ] Contact Dublin City Council

**Goal**: 10 beta users by end of week

---

## Tracking & Metrics

### Weekly Check-in

Every Sunday:

```
Week X Summary:
- [ ] Data collected: X million rows
- [ ] Fetch success rate: X%
- [ ] Bugs found: X (list)
- [ ] Code LOC: X
- [ ] Customers: X
- [ ] Status: On/Off track
- [ ] Next week focus: [priority]
```

### Success Metrics

| Milestone | Target | Date |
|-----------|--------|------|
| Daemon stable (>99% uptime) | Week 2 | Jan 17 |
| 1 week data | Week 3 | Jan 24 |
| Deployed to VPS | Week 3 | Jan 24 |
| Dashboard live | Week 11 | ~March 20 |
| 90 days data | Week 12 | ~March 27 |
| Stripe live | Week 13 | ~April 3 |
| First paying customer | Week 14 | ~April 10 |

---

## Decision Points (Go/No-Go)

### Before Phase 3 (Week 8)

**Question**: Is daemon stable and growing data correctly?

- **Go**: >98% fetch success, 500K+ events, no crashes
- **No-go**: <95% success, data gaps, need to debug

### Before Phase 4 (Week 12)

**Question**: Is dashboard ready for users?

- **Go**: All queries fast, frontend polished, 0 bugs
- **No-go**: Needs more work, delay Stripe 2 weeks

### Before Launch (Week 13)

**Question**: Do we have 90 days of clean data?

- **Go**: 90+ days, >99% success rate, ready to monetize
- **No-go**: Only 60 days, extend collection, launch in May

---

## Red Flags (Stop & Debug)

- ❌ Daemon crashes unexpectedly (>1x/week)
- ❌ Data gaps (>1 hour of missing fetch)
- ❌ Duplicate data not deduplicating
- ❌ Database grows >100GB
- ❌ API fetch time >30s per station
- ❌ Dashboard loads >5s
- ❌ GraphQL query >1s response

**Action**: Stop features, debug immediately

---

## Done Criteria

Each phase is "done" when:

**Phase 1**: Daemon runs locally, collects data, zero crashes
**Phase 2**: Data grows continuously 24/7, <1% failure rate
**Phase 3**: Dashboard shows all data, <200ms queries
**Phase 4**: Customers can pay, subscriptions sync
**Phase 5**: 10+ customers signed up, €100+/month revenue

---

**Print this. Check off weekly. Report progress Sunday night. 🚀**
