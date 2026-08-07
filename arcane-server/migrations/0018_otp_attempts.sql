-- Failed-guess counter for one-time sign-in codes. A 6-digit OTP lives in a
-- 10^6 space, small enough that the per-IP rate limiter alone would still
-- allow thousands of guesses inside the code's 10-minute life. The verify
-- route increments this on every miss and consumes the row once it hits the
-- cap, so a code self-destructs long before brute force becomes viable.
--
-- Applies to every purpose but only ever moves for otp_login; the link-style
-- tokens (verify_email, password_reset, web_login) carry 256 bits of entropy
-- and are not guessable.
ALTER TABLE auth_tokens ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0;
