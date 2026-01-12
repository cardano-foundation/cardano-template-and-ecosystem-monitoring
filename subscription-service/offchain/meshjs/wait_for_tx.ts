import { getScriptAddress, koiosProvider } from './lib/utils.ts';

const args = Deno.args;
const txHash = args[0];

if (!txHash) {
  console.error('No txHash provided');
  Deno.exit(1);
}

const scriptAddr = getScriptAddress();
console.log(`Waiting for UTXO ${txHash} at ${scriptAddr} to be confirmed...`);

let attempts = 0;
while (attempts < 60) {
  // 10 minutes max
  try {
    const utxos = await koiosProvider.fetchAddressUTxOs(scriptAddr);
    const utxo = utxos.find((u) => u.input.txHash === txHash);
    if (utxo) {
      console.log('UTXO confirmed.');
      Deno.exit(0);
    }
  } catch (e) {
    // console.log("Waiting...");
  }
  await new Promise((r) => setTimeout(r, 10000));
  attempts++;
  if (attempts % 6 === 0) console.log(`Still waiting... (${attempts * 10}s)`);
}

console.error('Timeout waiting for UTXO');
Deno.exit(1);
