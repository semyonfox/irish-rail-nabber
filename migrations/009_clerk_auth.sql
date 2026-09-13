-- clerk replaces the built-in password auth
-- existing rows are linked to their clerk user by verified email on first sign-in

ALTER TABLE users ADD COLUMN IF NOT EXISTS clerk_user_id TEXT UNIQUE;
ALTER TABLE users ALTER COLUMN password_hash DROP NOT NULL;

-- Keep the legacy token table during the Clerk rollout so the previous API
-- image remains a viable rollback target. Remove it in a later migration.
