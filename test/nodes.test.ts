import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ListNodesUseCase } from '../src/nodes/useCases/listNodes/listNodes.useCase.ts';

test('listing Nodes returns public diagnostics from the injected repository', async () => {
    const node = {
        id: '11111111-1111-4111-8111-111111111111',
        label: 'Injected Node',
        public_connection: {
            inbound_tag: 'vless',
            host: 'vpn.example.test',
            port: 443,
            server_name: 'example.test',
            public_key: Buffer.alloc(32, 4).toString('base64url'),
            short_id: 'abcd',
            fingerprint: 'chrome',
        },
        include_in_subscription: true,
        confirmed_at: null,
        last_seen_at: null,
        last_received_report: null,
        desired_revision: '1',
        confirmed_revision: null,
    };
    const useCase = new ListNodesUseCase({ readNodes: async () => [node] });

    assert.deepEqual(await useCase.execute({}), [node]);
});
