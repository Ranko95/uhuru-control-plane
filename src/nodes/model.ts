import type { State } from '../snapshot.ts';

export type Connection = {
  inbound_tag: string;
  host: string;
  port: number;
  server_name: string;
  public_key: string;
  short_id: string;
  fingerprint: string;
};
export type Report = {
  node_id: string;
  saved: State | null;
  verified: State | null;
  error: { target: State | null; stage: string; code: string } | null;
};
export type PublicNode = {
  id: string;
  label: string;
  public_connection: Connection;
  include_in_subscription: boolean;
};
export type Diagnostics = {
  confirmed_at: Date | null;
  last_seen_at: Date | null;
  last_received_report: Report | null;
};
