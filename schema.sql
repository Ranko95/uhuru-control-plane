BEGIN;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
CREATE TABLE users (
  id uuid PRIMARY KEY,
  label text NOT NULL CHECK (length(btrim(label)) BETWEEN 1 AND 200)
);
CREATE TABLE access_profiles (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id),
  vless_uuid uuid NOT NULL UNIQUE CHECK (vless_uuid <> id AND vless_uuid::text ~ '^[0-9a-f-]{14}4[0-9a-f]{3}-[89ab]'),
  link_secret bytea NOT NULL UNIQUE CHECK (octet_length(link_secret) = 32),
  revoked_at timestamptz CHECK (isfinite(revoked_at)),
  UNIQUE (id, user_id)
);
CREATE TABLE subscriptions (
  user_id uuid PRIMARY KEY REFERENCES users(id),
  first_profile_id uuid NOT NULL,
  starts_at timestamptz NOT NULL CHECK (isfinite(starts_at)),
  ends_at timestamptz NOT NULL CHECK (isfinite(ends_at) AND ends_at > starts_at),
  FOREIGN KEY (first_profile_id, user_id) REFERENCES access_profiles(id, user_id)
);
CREATE TABLE service_settings (
  id integer PRIMARY KEY CHECK (id = 1),
  price_kopecks bigint CHECK (price_kopecks >= 0),
  currency text NOT NULL DEFAULT 'RUB' CHECK (currency = 'RUB'),
  duration_hours integer NOT NULL DEFAULT 720 CHECK (duration_hours = 720),
  profile_limit integer NOT NULL DEFAULT 3 CHECK (profile_limit = 3),
  unlimited_traffic boolean NOT NULL DEFAULT true CHECK (unlimited_traffic)
);
INSERT INTO service_settings(id) VALUES (1);
CREATE TABLE nodes (
  id uuid PRIMARY KEY,
  label text NOT NULL CHECK (length(btrim(label)) BETWEEN 1 AND 200),
  public_connection jsonb NOT NULL CHECK (jsonb_typeof(public_connection) = 'object'),
  agent_secret_hash bytea NOT NULL UNIQUE CHECK (octet_length(agent_secret_hash) = 32),
  include_in_subscription boolean NOT NULL DEFAULT true
);
CREATE TABLE node_sync (
  node_id uuid PRIMARY KEY REFERENCES nodes(id),
  desired_snapshot jsonb NOT NULL CHECK (jsonb_typeof(desired_snapshot) = 'object'),
  sent_snapshot jsonb CHECK (jsonb_typeof(sent_snapshot) = 'object'),
  confirmed_snapshot jsonb CHECK (jsonb_typeof(confirmed_snapshot) = 'object'),
  confirmed_at timestamptz CHECK (isfinite(confirmed_at)),
  last_seen_at timestamptz CHECK (isfinite(last_seen_at)),
  last_received_report jsonb CHECK (jsonb_typeof(last_received_report) = 'object'),
  CHECK ((confirmed_snapshot IS NULL) = (confirmed_at IS NULL)),
  CHECK ((last_received_report IS NULL) = (last_seen_at IS NULL))
);
CREATE FUNCTION active_profiles(at_time timestamptz)
RETURNS TABLE(profile_id uuid, vless_uuid uuid) LANGUAGE sql STABLE AS $$
  SELECT p.id, p.vless_uuid FROM access_profiles p
  JOIN subscriptions s ON s.user_id = p.user_id
  WHERE p.revoked_at IS NULL AND at_time < s.ends_at
  ORDER BY p.id
$$;
REVOKE ALL ON FUNCTION active_profiles(timestamptz) FROM PUBLIC;
COMMIT;
