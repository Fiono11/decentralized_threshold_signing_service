import { ApiPromise, WsProvider } from '@polkadot/api';

async function testPolkadotApiConnection() {
    console.log('Testing Polkadot API Connection to Westend...');

    let api = null;

    try {
        const wsProvider = new WsProvider('wss://westend-rpc.polkadot.io');

        api = await ApiPromise.create({ provider: wsProvider });

        // Wait for API to be ready
        await api.isReady;

        console.log('✓ Connected successfully');
        console.log('Genesis Hash:', api.genesisHash.toHex());

        // Clean up
        await api.disconnect();
        console.log('✓ Disconnected successfully');
        process.exit(0);
    } catch (error) {
        console.error('✗ Connection failed:', error.message || error);
        if (api) {
            try {
                await api.disconnect();
            } catch (disconnectError) {
                // Ignore disconnect errors
            }
        }
        process.exit(1);
    }
}

testPolkadotApiConnection();