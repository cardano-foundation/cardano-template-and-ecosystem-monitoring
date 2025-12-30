import { KoiosProvider } from '@meshsdk/core';

const provider = new KoiosProvider('preprod');
const address =
  'addr_test1qr0a9nz8matzpy9j454dx0eza3d926u646c78d3kf486kz5w0y4xkqvzg6c5uw3mw8dyzpp54579k86a0dyes4ew4j6q8h4wte';
const utxos = await provider.fetchAddressUTxOs(address);
console.log(JSON.stringify(utxos, null, 2));
