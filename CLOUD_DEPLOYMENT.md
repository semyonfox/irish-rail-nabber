# Cloud Deployment Guide

Move irish-rail-nabber from home server to cloud for 24/7 reliability.

## TL;DR

**Best option: Railway ($0-20/mo)**
- Daemon runs 24/7 (500 CPU min/mo free)
- PostgreSQL included (unlimited storage)
- Auto-restarts on crash
- Perfect for data collection

**If you want resilience to cloud outages: Railway + Fly.io ($30-40/mo)**
- Failover between two clouds
- Survives single cloud outage
- 99.9% uptime

## The Problem with AWS Free Tier

✅ Technically works for first 12 months (free)
❌ Only t2.micro = 1 GB RAM (tight for daemon + postgres)
❌ 20GB storage = full in 2-3 months
❌ Single AZ failure = complete downtime (no failover)
❌ After free tier: $20-30/mo anyway

## Option 1: Railway (Recommended for you)

### Cost
- Hobby tier: $0 (includes 500 CPU min/mo + PostgreSQL)
- Pay-as-you-go: $5-20/mo (if you exceed hobby limits)

### Setup
1. Create account at railway.app
2. Connect your GitHub repo
3. Add PostgreSQL addon
4. Set environment variables (JWT_SECRET, STRIPE keys)
5. Deploy

### Uptime
⭐⭐⭐⭐ - 98% (down 1-2 days/year due to cloud outages)

### Resilience to AWS Outages
⚠️  Still affected (Railway uses AWS/GCP)
✓ But automatic failover between regions

## Option 2: Fly.io (Alternative)

### Cost
- Hobby tier: $0-15/mo
- Similar to Railway but better global distribution

### Uptime
⭐⭐⭐⭐ - 98% (same as Railway)

### Better if
- You need global edge locations
- Slightly cheaper for high bandwidth

## Option 3: Multi-Cloud (Railway + Fly.io)

### Cost
$30-40/mo

### Setup
1. Deploy to Railway (primary)
2. Deploy to Fly.io (secondary)
3. Setup database replication
4. Frontend queries Railway first, falls back to Fly.io

### Uptime
⭐⭐⭐⭐⭐ - 99.9% (zero downtime unless both clouds fail)

### Resilience to AWS Outages
✅ Automatic failover to Fly.io
✅ You keep data throughout outage

## Option 4: AWS Multi-Region (Most Expensive)

### Cost
$60-100/mo

### Setup
1. EC2 + RDS in us-east-1 (primary)
2. EC2 + RDS in eu-west-1 Ireland (secondary)
3. Cross-region replication
4. Load balancer

### Uptime
⭐⭐⭐⭐⭐ - 99.9%

### Resilience to AWS Outages
⚠️  Still single-vendor risk
✓ But survives regional outages

## What About Home Server as Backup?

You can keep your home server as tertiary fallback:
- Railway as primary (always collecting)
- Home server standby (can take over if clouds down)
- Automatic database sync when available

### Cost
$0 (electricity only)

### Uptime with this hybrid approach
⭐⭐⭐⭐⭐⭐ - 99.95% (survives 2 simultaneous outages)

## AWS Outage Reality

**How often?**
- Regional outage: 1-2 times/year
- Duration: 1-4 hours typically
- Last major: Dec 2023 (8 hours)

**What happens?**
- Your service down during outage
- Automatic recovery (no action needed)
- Cannot avoid unless multi-vendor

**True bulletproof requires:**
- Multiple cloud providers
- Multiple regions
- Redundant data centers
- Cost: $50-200/mo

## My Recommendation

### Start here (today)
```
Railway $0/mo
├─ Daemon
├─ API
└─ PostgreSQL

+ Vercel $0/mo
  └─ Dashboard frontend
```

**Result: Never offline due to house power, but down 1-2 days/year for cloud outages**

### Add later (optional, $30/mo)
```
Add Fly.io $20/mo
├─ Daemon replica
├─ API mirror
└─ Auto-failover
```

**Result: 99.9% uptime, survives single cloud outage**

### Add eventually (optional, +$20/mo)
```
Keep home server as standby
├─ Auto-syncs from Railway
├─ Takes over if both clouds down
└─ Free (just electricity)
```

**Result: 99.95% uptime, survives 2 simultaneous outages**

## Migration Steps

### Step 1: Setup Railway (30 min)
```bash
1. Go to railway.app
2. Create account (use GitHub)
3. Create project
4. Connect your GitHub repo
5. Add PostgreSQL addon
6. Set environment variables:
   - JWT_SECRET
   - STRIPE_SECRET_KEY
   - STRIPE_WEBHOOK_SECRET
   - STRIPE_COFFEE_PRICE_ID
   - STRIPE_PRO_PRICE_ID
   - POSTGRES credentials (Railway provides)
7. Deploy
```

### Step 2: Deploy API & Daemon (10 min)
Railway auto-detects docker-compose and deploys

### Step 3: Deploy Dashboard to Vercel (10 min)
```bash
1. Go to vercel.com
2. Connect GitHub
3. Select dashboard folder
4. Set environment variables (Railway API URL)
5. Deploy
```

### Step 4: Setup Domain & SSL (10 min)
- Point domain to Railway + Vercel
- SSL automatic

## Monitoring

Once deployed:
```
Railway dashboard:
  → app status
  → logs
  → deployments
  
Vercel dashboard:
  → frontend deployments
  → analytics
  
Create alerts:
  → if daemon crashes
  → if API down
  → if storage full
```

## Cost Breakdown

| Component | Cost | Notes |
|-----------|------|-------|
| Railway daemon | $0 | Hobby tier (500 CPU min free) |
| Railway database | $0 | Included with hobby tier |
| Vercel dashboard | $0 | Free tier |
| **Total** | **$0** | **Until you exceed limits** |

After free tier:
- Railway: ~$20/mo (pay-as-you-go, only if over limits)
- Vercel: $0 (free tier very generous)

## Limitations of Free Tiers

**Railway hobby tier:**
- 500 CPU minutes/month ≈ 2-3 containers running
- 1GB RAM per service
- Enough for daemon (low CPU) + PostgreSQL

**Supabase free tier (if you use it):**
- 2GB storage = ~20-30 days of collection
- ❌ Not enough for unlimited archival
- Use Railway PostgreSQL instead (unlimited on paid)

## When to Upgrade

Upgrade from hobby to paid when:
- Storage > 1GB (Railway hobby limit)
- CPU > 500 min/mo consistently
- Need SLA guarantee

Cost to upgrade: ~$20-30/mo total

## FAQ

**Q: What if Railway goes down?**
A: Same as any cloud outage (1-2 days/year, 1-4 hours each)

**Q: Can I avoid cloud outages?**
A: Not completely. Options:
- Accept 1-2 days downtime/year ($0)
- Add Fly.io backup ($20/mo, → 99.9% uptime)
- Add home server fallback ($0 extra)
- Multi-region AWS ($60-100/mo)

**Q: How do I know if Railway is better than AWS?**
A:
- AWS: Mature, expensive, bureaucratic setup
- Railway: Simple, cheap, great free tier
- For side projects: Railway wins
- For enterprise: AWS wins

**Q: Should I use Supabase for database?**
A: No for this project:
- Supabase: 2GB limit on free tier (too small)
- Railway: Unlimited storage on paid tier
- Use Railway PostgreSQL instead

**Q: How do I migrate home server → Railway?**
A: Simple:
1. Export database from home server
2. Import into Railway PostgreSQL
3. Point daemon config to Railway database
4. Deploy daemon to Railway
5. Flip the switch (turn off home server daemon)

**Q: What data do I lose if Railway is down?**
A: None. Database stays. You just can't collect new data temporarily.

## Support

Railway support:
- Discord community (helpful)
- 24/7 status page
- Issue tracker on GitHub

Fly.io support:
- Forums (active community)
- Documentation (excellent)
- Managed by very responsive team
