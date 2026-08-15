-- GitHub OAuth account linking (NULL for users who never signed in with
-- GitHub). Mirrors google_sub from 0012: the partial unique index enforces one
-- account per GitHub user without penalizing the common NULL case.
--
-- github_id holds GitHub's NUMERIC user id as TEXT. The login handle is not
-- usable as an identity key — it can be renamed, and the freed name can then
-- be claimed by someone else.
ALTER TABLE users ADD COLUMN github_id TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_github_id ON users(github_id) WHERE github_id IS NOT NULL;
