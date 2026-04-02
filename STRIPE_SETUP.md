# Stripe + Auth Setup Guide

Everything is implemented. You just need Stripe keys and a JWT secret.

## Quick Start (15 minutes)

### 1. Generate JWT Secret
```bash
openssl rand -hex 32
```
Copy the output.

### 2. Get Stripe Keys

**Secret Key & Webhook Secret:**
- Go to https://dashboard.stripe.com/apikeys
- Copy `Secret Key` (sk_live_...)
- Go to https://dashboard.stripe.com/webhooks
- Create new endpoint: `https://your-domain.com/billing/webhook`
- Listen to: `checkout.session.completed`, `customer.subscription.updated`, `customer.subscription.deleted`
- Copy the signing secret (whsec_...)

**Product Prices:**
- Go to https://dashboard.stripe.com/products
- Create "Coffee Plan" (€5/month recurring) → copy price_id
- Create "Pro Plan" (€25/month recurring) → copy price_id

### 3. On Your Server

```bash
cd irish-rail-nabber

cat > .env << 'EOF'
JWT_SECRET=<your-64-char-hex-from-step-1>
JWT_ACCESS_EXPIRY=900
JWT_REFRESH_EXPIRY=604800
COOKIE_SECURE=true

APP_URL=https://your-domain.com
CORS_ORIGINS=https://your-domain.com
DATABASE_URL=postgresql://irish_data:secure_password@db:5432/ireland_public

STRIPE_SECRET_KEY=sk_live_...
STRIPE_WEBHOOK_SECRET=whsec_...
STRIPE_COFFEE_PRICE_ID=price_...
STRIPE_PRO_PRICE_ID=price_...
EOF

docker-compose down
docker-compose up -d
```

### 4. Test

```bash
# Register
curl -X POST https://your-domain.com/auth/register \
  -H "Content-Type: application/json" \
  -d '{"email":"you@example.com","password":"SecurePass123"}'

# Login
curl -X POST https://your-domain.com/auth/login \
  -H "Content-Type: application/json" \
  -b cookies.txt -c cookies.txt \
  -d '{"email":"you@example.com","password":"SecurePass123"}'

# Create checkout session
curl -X POST https://your-domain.com/billing/checkout \
  -H "Content-Type: application/json" \
  -b cookies.txt \
  -d '{"price_id":"price_YOUR_COFFEE_ID"}'
```

## What's Implemented

✅ User registration with validation  
✅ Login with JWT tokens  
✅ Token refresh with rotation  
✅ Session logout  
✅ Stripe checkout flow  
✅ Stripe portal  
✅ Webhook processing  
✅ Automatic role assignment (free → coffee → pro)  
✅ CSRF protection  
✅ Argon2 password hashing  

## Database

- `users` table with UUID, email, password_hash, role, stripe_customer_id
- `refresh_tokens` table with TTL
- Automatic migrations on startup
- Cascade deletes for data integrity

## Environment Variables

| Variable | Required | Example |
|----------|----------|---------|
| JWT_SECRET | Yes | 64-char hex string |
| STRIPE_SECRET_KEY | Yes | sk_live_... |
| STRIPE_WEBHOOK_SECRET | Yes | whsec_... |
| STRIPE_COFFEE_PRICE_ID | Yes | price_... |
| STRIPE_PRO_PRICE_ID | Yes | price_... |
| APP_URL | Yes | https://your-domain.com |
| COOKIE_SECURE | Yes | true (production), false (dev) |

## Endpoints

**Auth:**
- `POST /auth/register` - Register new user
- `POST /auth/login` - Login & get tokens
- `POST /auth/refresh` - Rotate tokens
- `POST /auth/logout` - Clear session
- `GET /auth/me` - Current user info

**Billing:**
- `POST /billing/checkout` - Create checkout session
- `POST /billing/portal` - Create portal session
- `POST /billing/webhook` - Stripe webhook (automatic)

## Roles

| Role | Price | Features |
|------|-------|----------|
| free | €0 | Live map, basic queries |
| coffee | €5/mo | Analytics, historical data |
| pro | €25/mo | Unlimited, export, priority |
| admin | N/A | Full access |
