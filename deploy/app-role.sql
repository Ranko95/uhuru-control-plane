-- Run as the schema owner. The local service connects through Unix peer authentication.
CREATE ROLE uhuru LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION;
REVOKE ALL ON DATABASE uhuru FROM PUBLIC;
GRANT CONNECT ON DATABASE uhuru TO uhuru;
GRANT USAGE ON SCHEMA public TO uhuru;
GRANT SELECT ON users, access_profiles, subscriptions, service_settings, nodes, node_sync TO uhuru;
GRANT INSERT ON users, access_profiles, subscriptions, nodes, node_sync TO uhuru;
-- FOR UPDATE also requires an UPDATE privilege; immutable columns are never granted.
GRANT UPDATE(label) ON users TO uhuru;
GRANT UPDATE(price_kopecks) ON service_settings TO uhuru;
GRANT UPDATE(agent_secret_hash) ON nodes TO uhuru;
GRANT UPDATE(desired_snapshot, sent_snapshot, confirmed_snapshot, confirmed_at,
             last_seen_at, last_received_report) ON node_sync TO uhuru;
GRANT EXECUTE ON FUNCTION active_profiles(timestamptz) TO uhuru;
