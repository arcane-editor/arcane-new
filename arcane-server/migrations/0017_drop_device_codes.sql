-- Retire the device-code login flow.
--
-- It was a SECOND login path with no PKCE binding at all: an 8-character user
-- code drawn from a 32-character alphabet, guarded only by a rate limit, and
-- an indefinite obligation to keep two auth systems hardened in step. The
-- PKCE-bound poll channel added in 0016 (/v1/auth/editor/poll) covers the
-- same need — completing a sign-in when no callback can be delivered — with
-- the same cryptographic binding as the deep link.
--
-- Ordering matters: 0016 created editor_attempts, this migration drops
-- device_codes, and the code that read it is removed in the same commit. A
-- table is never dropped before its last reader is gone.
--
-- Deploy note: in-flight device codes are abandoned by this DROP. They live
-- 15 minutes, so deploying outside a burst of sign-ins is safe. Anyone caught
-- mid-flow simply signs in again through the browser flow.

DROP TABLE IF EXISTS device_codes;
