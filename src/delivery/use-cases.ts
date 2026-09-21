import type { Pool } from 'pg';
import { transaction } from '../database.ts';
import { authorizeSubscriptionLink } from '../access/use-cases.ts';
import { listReadyNodes } from '../nodes/use-cases.ts';

export async function getConfigurations(pool: Pool, linkSecret: Buffer) {
  return transaction(pool, async (db) => {
    const profile = await authorizeSubscriptionLink(db, linkSecret);
    const readyNodes = await listReadyNodes(db, profile);
    const configs = [];
    for (const node of readyNodes) {
      const c = node.public_connection;
      const query = new URLSearchParams({
        encryption: 'none',
        type: 'tcp',
        security: 'reality',
        flow: 'xtls-rprx-vision',
        sni: c.server_name,
        pbk: c.public_key,
        sid: c.short_id,
        fp: c.fingerprint,
      });
      configs.push(
        'vless://' +
          profile.vless_uuid +
          '@' +
          c.host +
          ':' +
          c.port +
          '?' +
          query +
          '#' +
          encodeURIComponent(node.label),
      );
    }
    if (!configs.length) throw new Error('no_ready_nodes');
    return configs.join('\n') + '\n';
  });
}
