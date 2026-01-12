import {
  MeshWallet,
  MeshTxBuilder,
  KoiosProvider,
  deserializeAddress,
  mConStr0,
  mConStr1,
  mConStr2,
  resolvePlutusScriptAddress,
  deserializeDatum,
  mConStr,
} from "@meshsdk/core";
import { applyParamsToScript } from "@meshsdk/core-cst";
import blueprint from "../../onchain/aiken/plutus.json" with { type: "json" };

const PREPROD_SYSTEM_START = 1655683200000; // ms
const SLOT_LENGTH = 1000; // ms

function getSlotFromTime(timeVal: number): number {
    return Math.floor((timeVal - PREPROD_SYSTEM_START) / SLOT_LENGTH);
}

function getTimeFromSlot(slot: number): number {
    return (slot * SLOT_LENGTH) + PREPROD_SYSTEM_START;
}

export const setup = async (walletName: string | number = 0) => {
  const provider = new KoiosProvider("preprod");
  
  let prefix = "";
  try {
    await Deno.stat("vault/offchain/meshjs");
    prefix = "vault/offchain/meshjs/";
  } catch {
    prefix = "";
  }

  const fileName = typeof walletName === 'number' 
      ? `${prefix}wallet_${walletName}.txt`
      : `${prefix}${walletName}`;
  let wallet;
  try {
    const mnemonic = await Deno.readTextFile(fileName);
    wallet = new MeshWallet({
      networkId: 0,
      fetcher: provider,
      submitter: provider,
      key: {
        type: "mnemonic",
        words: mnemonic.trim().split(" "),
      },
    });
  } catch (_e) {
    console.log("No wallet found, generating new one...");
    const mnemonic = MeshWallet.brew();
    await Deno.writeTextFile(fileName, Array.isArray(mnemonic) ? mnemonic.join(" ") : mnemonic);
    wallet = new MeshWallet({
    networkId: 0,
    fetcher: provider,
    submitter: provider,
    key: {
        type: "mnemonic",
        words: Array.isArray(mnemonic) ? mnemonic : mnemonic.split(" "),
    },
    });
    console.log(`Generated ${fileName}. Send some tADA to: ` + (await wallet.getUnusedAddresses())[0]);
  }
  return { provider, wallet };
};

export class MeshVaultContract {
  provider: KoiosProvider;
  wallet: MeshWallet;
  scriptCbor!: string;
  scriptAddress!: string;
  waitTime: number;

  constructor(provider: KoiosProvider, wallet: MeshWallet, waitTime: number = 60000) { // Default 60s
    this.provider = provider;
    this.wallet = wallet;
    this.waitTime = waitTime;
  }

  async initContract() {
     const address = (await this.wallet.getUnusedAddresses())[0];
     const { pubKeyHash } = deserializeAddress(address);
     
     this.scriptCbor = applyParamsToScript(blueprint.validators[0].compiledCode, [
        pubKeyHash,
        BigInt(this.waitTime)
     ]);
     
     this.scriptAddress = resolvePlutusScriptAddress({
        code: this.scriptCbor,
        version: "V3"
     }, 0);
  }

  async getUtxos() {
    return await this.provider.fetchAddressUTxOs(this.scriptAddress);
  }

  async getNetworkSlot(): Promise<number> {
      try {
        const res = await fetch('https://preprod.koios.rest/api/v1/tip');
        const data = await res.json();
        return Number(data[0].abs_slot);
      } catch (e) {
          console.error("Failed to fetch tip:", e);
          // Fallback to time-based (risky if time skewed)
          return getSlotFromTime(Date.now());
      }
  }

  async lock(amount: string, infinite = true) {
    const utxos = await this.wallet.getUtxos();
    console.log("LOCK DEBUG: Available UTxOs:", utxos.length);
    utxos.forEach(u => console.log(`- ${u.input.txHash}#${u.input.outputIndex} : ${u.output.amount[0].quantity}`));

    await this.initContract();
    const address = (await this.wallet.getUnusedAddresses())[0];
    const txBuilder = new MeshTxBuilder({ fetcher: this.provider, submitter: this.provider });
    
    // If infinite, set to 100 years. If not, set to NOW (Chain Time)
    let lockTime;
    if (infinite) {
        lockTime = Date.now() + 3153600000000;
    } else {
        const slot = await this.getNetworkSlot();
        console.log("DEBUG: Network Slot:", slot);
        lockTime = getTimeFromSlot(slot) - 100000; // 100s in past
        console.log("DEBUG: Calculated LockTime:", lockTime);
    }
    const datum = mConStr0([lockTime]);

    await txBuilder
      .txOut(this.scriptAddress, [{ unit: "lovelace", quantity: amount }])
      .txOutInlineDatumValue(datum)
      .changeAddress(address)
      .selectUtxosFrom(await this.wallet.getUtxos())
      .complete();
      
    const signedTx = await this.wallet.signTx(txBuilder.txHex);
    const txHash = await this.wallet.submitTx(signedTx);
    return txHash;
  }

  async withdraw(utxoHash: string) {
    await this.initContract();
    const address = (await this.wallet.getUnusedAddresses())[0];
    const txBuilder = new MeshTxBuilder({ fetcher: this.provider, submitter: this.provider });
    
    const utxos = await this.getUtxos();
    console.log("Available UTxOs in withdraw:", utxos.map(u => u.input.txHash));
    const utxoToSpend = utxos.find(u => u.input.txHash === utxoHash);
    if (!utxoToSpend) throw new Error("UTxO not found");

    // Calculate slot from current time
    // Use network slot to align time
    const networkSlot = await this.getNetworkSlot();
    const slot = networkSlot - 1000; // Buffer for node lag
    const lockTime = getTimeFromSlot(slot - 200); // Lock time slightly in past to pass valid_after check

    // const lockTime = 1000; // Fixed old time
    const datum = mConStr0([lockTime]);
    
    // Auto-setup collateral
    const collateral = (await this.wallet.getCollateral())[0];
    if (collateral) {
        txBuilder.txInCollateral(
            collateral.input.txHash,
            collateral.input.outputIndex,
            collateral.output.amount,
            collateral.output.address
        );
    }
    
    txBuilder
      .spendingPlutusScript("V3")
      .txIn(
         utxoToSpend.input.txHash,
         utxoToSpend.input.outputIndex,
         utxoToSpend.output.amount,
         this.scriptAddress
      );

    if (utxoToSpend.output.plutusData) {
        txBuilder.txInInlineDatumPresent();
    }

    await txBuilder
      // Removed txInInlineDatumPresent because input from Cancel has NoDatum
      .txInScript(this.scriptCbor)
      .txInRedeemerValue(mConStr0([])) // redeemer: Action.WITHDRAW (Index 0)
      
      .txOut(this.scriptAddress, utxoToSpend.output.amount) // Send back value
      .txOutInlineDatumValue(datum)
      
      .requiredSignerHash(deserializeAddress(address).pubKeyHash)
      .changeAddress(address)
      .selectUtxosFrom(await this.wallet.getUtxos())
      .invalidBefore(slot) 
      .complete();

    const signedTx = await this.wallet.signTx(txBuilder.txHex);
    const txHash = await this.wallet.submitTx(signedTx);
    return txHash;
  }

  async finalize(utxoHash: string) {
    await this.initContract();
    const address = (await this.wallet.getUnusedAddresses())[0];
    const txBuilder = new MeshTxBuilder({ fetcher: this.provider, submitter: this.provider });
    
    const utxos = await this.getUtxos();
    const utxoToSpend = utxos.find(u => u.input.txHash === utxoHash);
    if (!utxoToSpend) throw new Error("UTxO not found");

    // We can only spend if valid_after(range, waitTime + lock_time)
    const datum = deserializeDatum(utxoToSpend.output.plutusData!);
    const lockTime = Number(datum.fields[0].int);
    
    const validAfter = lockTime + this.waitTime;
    const validAfterSlot = getSlotFromTime(validAfter);
    
    console.log("DEBUG: LockTime from Datum:", lockTime);
    console.log("DEBUG: ValidAfter Time:", validAfter);
    console.log("DEBUG: ValidAfter Slot:", validAfterSlot);
    const currentSlot = await this.getNetworkSlot();
    const currentTime = getTimeFromSlot(currentSlot);

    if (currentTime < validAfter) {
         const diff = validAfter - currentTime;
         console.log(`Too early! Waiting ${(diff/1000).toFixed(1)}s until ${new Date(validAfter).toISOString()}...`);
         await new Promise(r => setTimeout(r, diff + 1000));
         console.log("Resuming...");
    }

    const collateral = (await this.wallet.getCollateral())[0];
    if (collateral) {
        txBuilder.txInCollateral(
            collateral.input.txHash,
            collateral.input.outputIndex,
            collateral.output.amount,
            collateral.output.address
        );
    }

    await txBuilder
      .spendingPlutusScript("V3")
      .txIn(
         utxoToSpend.input.txHash,
         utxoToSpend.input.outputIndex,
         utxoToSpend.output.amount,
         this.scriptAddress
      )
      .txInInlineDatumPresent()
      .txInScript(this.scriptCbor)
      .txInRedeemerValue(mConStr1([])) // redeemer: Action.FINALIZE (Index 1)
      
      .requiredSignerHash(deserializeAddress(address).pubKeyHash)
      .changeAddress(address)
      .selectUtxosFrom(await this.wallet.getUtxos())
      .invalidBefore(validAfterSlot + 1)
      .complete();

    const signedTx = await this.wallet.signTx(txBuilder.txHex);
    const txHash = await this.wallet.submitTx(signedTx);
    return txHash;
  }

  async cancel(utxoHash: string) {
    await this.initContract();
    const address = (await this.wallet.getUnusedAddresses())[0];
    const txBuilder = new MeshTxBuilder({ fetcher: this.provider, submitter: this.provider });
    
    const utxos = await this.getUtxos();
    const utxoToSpend = utxos.find(u => u.input.txHash === utxoHash);
    if (!utxoToSpend) throw new Error("UTxO not found");

    const collateral = (await this.wallet.getCollateral())[0];
    if (collateral) {
        txBuilder.txInCollateral(
            collateral.input.txHash,
            collateral.input.outputIndex,
            collateral.output.amount,
            collateral.output.address
        );
    }

    txBuilder
      .spendingPlutusScript("V3")
      .txIn(
         utxoToSpend.input.txHash,
         utxoToSpend.input.outputIndex,
         utxoToSpend.output.amount,
         this.scriptAddress
      );

    if (utxoToSpend.output.plutusData) {
        txBuilder.txInInlineDatumPresent();
    }

    await txBuilder
      .txInScript(this.scriptCbor)
      .txInRedeemerValue(mConStr2([])) // redeemer: Action.CANCEL (Index 2)
      
      .txOut(this.scriptAddress, utxoToSpend.output.amount)
      // No datum (reset)
      
      .requiredSignerHash(deserializeAddress(address).pubKeyHash)
      .changeAddress(address)
      .selectUtxosFrom(await this.wallet.getUtxos())
      .complete();

    const signedTx = await this.wallet.signTx(txBuilder.txHex);
    const txHash = await this.wallet.submitTx(signedTx);
    return txHash;
  }
}

const isPositiveNumber = (s: string) => Number.isInteger(Number(s)) && Number(s) > 0;

if (import.meta.main) {
  if (Deno.args.length > 0) {
    if (Deno.args[0] === 'init') {
        const { provider, wallet } = await setup();
        const contract = new MeshVaultContract(provider, wallet);
        await contract.initContract();
        console.log(`Vault Script Address: ${contract.scriptAddress}`);
    } else
    if (Deno.args[0] === 'lock') {
      if (Deno.args.length > 1 && isPositiveNumber(Deno.args[1])) {
        const { provider, wallet } = await setup();
        const contract = new MeshVaultContract(provider, wallet);
        const tx = await contract.lock(Deno.args[1], true);
        console.log(`Locked ${Deno.args[1]} lovelace (Infinite). Tx: ${tx}`);
      } else {
        console.log('Expected a positive number (lovelace amount) as the second argument.');
      } 
    } else
    if (Deno.args[0] === 'lock-withdrawable') {
      if (Deno.args.length > 1 && isPositiveNumber(Deno.args[1])) {
        const { provider, wallet } = await setup();
        const contract = new MeshVaultContract(provider, wallet);
        const tx = await contract.lock(Deno.args[1], false);
        console.log(`Locked ${Deno.args[1]} lovelace (Withdrawable). Tx: ${tx}`);
      } else {
        console.log('Expected a positive number (lovelace amount) as the second argument.');
      } 
    } else if (Deno.args[0] === 'withdraw') {
      if (Deno.args.length > 1) {
        const { provider, wallet } = await setup();
        const contract = new MeshVaultContract(provider, wallet);
        const tx = await contract.withdraw(Deno.args[1]);
        console.log(`Withdraw requested. Tx: ${tx}`);
      } else {
        console.log('Expected transaction hash/id as the second argument.');
      }
    } else if (Deno.args[0] === 'finalize') {
         if (Deno.args.length > 1) {
            const { provider, wallet } = await setup();
            const contract = new MeshVaultContract(provider, wallet);
            const tx = await contract.finalize(Deno.args[1]);
            if (tx) console.log(`Withdraw finalized! Tx: ${tx}`);
          } else {
            console.log('Expected transaction hash/id as the second argument.');
          }
    } else if (Deno.args[0] === 'cancel') {
          if (Deno.args.length > 1) {
            const { provider, wallet } = await setup();
            const contract = new MeshVaultContract(provider, wallet);
            const tx = await contract.cancel(Deno.args[1]);
            console.log(`Canceled. Tx: ${tx}`);
          } else {
            console.log('Expected transaction hash/id as the second argument.');
          }
    } else if (Deno.args[0] === 'prepare') {
      if (Deno.args.length > 1 && isPositiveNumber(Deno.args[1])) {
        const amount = parseInt(Deno.args[1]);
        for (let i = 0; i < amount; i++) {
           await setup(i); // This handles generation
        }
        console.log(`Prepared ${amount} wallets.`);
      } else {
        console.log('Expected a positive number (of seed phrases to prepare) as the second argument.');
      }    
    } else {
      console.log('Invalid argument. Allowed arguments: init, lock, withdraw, finalize, cancel, prepare.');
    }
  } else {
    console.log('Expected an argument. Allowed arguments: init, lock, withdraw, finalize, cancel, prepare.');
  }
}

