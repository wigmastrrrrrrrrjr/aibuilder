-- Live-only seed: reserves the "john_doe" undercover account and grants it
-- exactly 1,000,000 credits available every day (30-credit daily grant +
-- a 9,999,700-unit earnings balance = 30 + 999,970 = 1,000,000).
-- Idempotent and re-asserted on every deploy, so the balance self-heals.
-- phash = PBKDF2-SHA256(100k iterations, per-user salt) of the account password.

INSERT INTO users (id, name, phash, email, verified, created_at, ip)
VALUES (
  '0c7498f7-9d3c-4a5f-9d9b-e21d121c0b51',
  'john_doe',
  'd3546e45dfc417f72ee70f0a594d87ef$002b17bb3446b2f415bed4511d62213664b47ae8496412d3d66d7913e6b6af33',
  '',
  1,
  strftime('%s', 'now') * 1000,
  ''
)
ON CONFLICT (name) DO UPDATE SET phash = excluded.phash, verified = 1;

INSERT INTO earnings (name, units)
VALUES ('john_doe', 9999700)
ON CONFLICT (name) DO UPDATE SET units = excluded.units;