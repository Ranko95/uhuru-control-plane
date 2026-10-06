import type { DeliveryUnitOfWork } from '../../unit-of-work.ts';

export type GetConfigurationsDto = { linkSecret: Buffer };

export class GetConfigurationsUseCase {
    private readonly unitOfWork: Pick<DeliveryUnitOfWork, 'transaction'>;

    constructor(unitOfWork: Pick<DeliveryUnitOfWork, 'transaction'>) {
        this.unitOfWork = unitOfWork;
    }

    execute(dto: GetConfigurationsDto): Promise<string> {
        return this.unitOfWork.transaction(async ({ authorizeSubscriptionLinkUseCase, listReadyNodesUseCase }) => {
            const profile = await authorizeSubscriptionLinkUseCase.execute(dto);
            const readyNodes = await listReadyNodesUseCase.execute(profile);
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
