import type { Pool } from 'pg';
import { transaction } from '../../../database.ts';
import type { AuthorizeSubscriptionLinkUseCase } from '../../../access/useCases/authorizeSubscriptionLink/authorizeSubscriptionLink.useCase.ts';
import type { ListReadyNodesUseCase } from '../../../nodes/useCases/listReadyNodes/listReadyNodes.useCase.ts';

export type GetConfigurationsDto = { linkSecret: Buffer };

export class GetConfigurationsUseCase {
    private readonly pool: Pool;
    private readonly authorizeSubscriptionLinkUseCase: Pick<AuthorizeSubscriptionLinkUseCase, 'execute'>;
    private readonly listReadyNodesUseCase: Pick<ListReadyNodesUseCase, 'execute'>;

    constructor(
        pool: Pool,
        authorizeSubscriptionLinkUseCase: Pick<AuthorizeSubscriptionLinkUseCase, 'execute'>,
        listReadyNodesUseCase: Pick<ListReadyNodesUseCase, 'execute'>,
    ) {
        this.pool = pool;
        this.authorizeSubscriptionLinkUseCase = authorizeSubscriptionLinkUseCase;
        this.listReadyNodesUseCase = listReadyNodesUseCase;
    }

    execute(dto: GetConfigurationsDto): Promise<string> {
        return transaction(this.pool, async (tx) => {
            const options = { tx };
            const profile = await this.authorizeSubscriptionLinkUseCase.execute(dto, options);
            const readyNodes = await this.listReadyNodesUseCase.execute(profile, options);
            const configs = [];

            for (const node of readyNodes) {
                const connection = node.public_connection;
                const query = new URLSearchParams({
                    encryption: 'none',
                    type: 'tcp',
                    security: 'reality',
                    flow: 'xtls-rprx-vision',
                    sni: connection.server_name,
                    pbk: connection.public_key,
                    sid: connection.short_id,
                    fp: connection.fingerprint,
                });

                configs.push(
                    'vless://' +
                        profile.vless_uuid +
                        '@' +
                        connection.host +
                        ':' +
                        connection.port +
                        '?' +
                        query +
                        '#' +
                        encodeURIComponent(node.label),
                );
            }

            if (!configs.length) {
                throw new Error('no_ready_nodes');
            }

            return configs.join('\n') + '\n';
        });
    }
}
