import { 
  Lucid, 
  Koios, 
  Data, 
  generateSeedPhrase, 
  LucidEvolution, 
  applyParamsToScript,
  SpendingValidator,
  getAddressDetails,
  validatorToAddress,
} from "@evolution-sdk/lucid";
import blueprint from "../../onchain/aiken/plutus.json" with { type: "json" };

// Helper to select wallet from file
function selectWallet(lucid: LucidEvolution, index: string | number) {
    const fileName = `wallet_${index}.txt`;
    try {
        const mnemonic = Deno.readTextFileSync(fileName).trim();
        lucid.selectWallet.fromSeed(mnemonic);
    } catch {
        console.error(`Error reading ${fileName}. Run 'prepare' first.`);
        Deno.exit(1);
    }
}

async function prepare(amount: number) {
    for (let i = 0; i < amount; i++) {
        const fileName = `wallet_${i}.txt`;
        try {
            await Deno.stat(fileName);
            console.log(`${fileName} already exists, skipping.`);
        } catch {
            const mnemonic = generateSeedPhrase();
            await Deno.writeTextFile(fileName, mnemonic);
            const lucid = await Lucid(new Koios("https://preprod.koios.rest/api/v1"), "Preprod");
            lucid.selectWallet.fromSeed(mnemonic);
            console.log(`Generated ${fileName}. Address: ${await lucid.wallet().address()}`);
        }
    }
}

async function balance(walletOrAddress: string | number = 0) {
    const lucid = await Lucid(new Koios("https://preprod.koios.rest/api/v1"), "Preprod");
    let address: string;
    if (typeof walletOrAddress === "number" || (!isNaN(Number(walletOrAddress)) && walletOrAddress.toString().length < 5)) {
        selectWallet(lucid, walletOrAddress);
        address = await lucid.wallet().address();
    } else {
        address = walletOrAddress.toString();
    }
    const utxos = await lucid.utxosAt(address);
    const totalLovelace = utxos.reduce((acc, utxo) => acc + utxo.assets.lovelace, 0n);
    console.log(`Address: ${address}`);
    console.log(`Balance: ${totalLovelace} lovelace (${Number(totalLovelace) / 1000000} ADA)`);
}

async function transfer(amountStr: string, toAddress: string, walletIndex: string | number = 0) {
    const lucid = await Lucid(new Koios("https://preprod.koios.rest/api/v1"), "Preprod");
    selectWallet(lucid, walletIndex);
    try {
        const tx = await lucid.newTx()
            .pay.ToAddress(toAddress, { lovelace: BigInt(amountStr) })
            .complete();
        const signedTx = await tx.sign.withWallet().complete();
        const txHash = await signedTx.submit();
        console.log(`Transferred ${amountStr} lovelace to ${toAddress}. Tx Hash: ${txHash}`);
    } catch (e) {
        console.error("Transfer failed:", e);
    }
}

async function lock(amountStr: string, receiverAddress: string, walletIndex: string | number = 0) {
    const lucid = await Lucid(new Koios("https://preprod.koios.rest/api/v1"), "Preprod");
    selectWallet(lucid, walletIndex);

    const validator = blueprint.validators.find(v => v.title === "simple_transfer.simpleTransfer.spend");
    if (!validator) throw new Error("Validator not found");

    const receiverPKH = getAddressDetails(receiverAddress).paymentCredential?.hash;
    if (!receiverPKH) throw new Error("Invalid receiver address");

    const script = {
        type: "PlutusV3",
        script: applyParamsToScript(validator.compiledCode, [receiverPKH])
    };

    const scriptAddress = validatorToAddress("Preprod", script as SpendingValidator);
    
    try {
        const tx = await lucid.newTx()
            .pay.ToAddress(scriptAddress, { lovelace: BigInt(amountStr) })
            .complete();

        const signedTx = await tx.sign.withWallet().complete();
        const txHash = await signedTx.submit();
        console.log(`Locked ${amountStr} lovelace for ${receiverAddress}. Tx Hash: ${txHash}`);
        console.log(`Script Address: ${scriptAddress}`);
    } catch (e) {
        console.error("Locking failed:", e);
    }
}

async function claim(walletIndex: string | number = 0) {
    const lucid = await Lucid(new Koios("https://preprod.koios.rest/api/v1"), "Preprod");
    selectWallet(lucid, walletIndex);

    const address = await lucid.wallet().address();
    const pkh = getAddressDetails(address).paymentCredential?.hash;
    if (!pkh) throw new Error("Could not get PKH");
    
    const validator = blueprint.validators.find(v => v.title === "simple_transfer.simpleTransfer.spend");
    if (!validator) throw new Error("Validator not found");

    const script = {
        type: "PlutusV3",
        script: applyParamsToScript(validator.compiledCode, [pkh])
    };

    const scriptAddress = validatorToAddress("Preprod", script as SpendingValidator);
    console.log(`Checking for UTXOs at ${scriptAddress}...`);
    const utxos = await lucid.utxosAt(scriptAddress);

    if (utxos.length === 0) {
        console.log("No UTXOs to claim.");
        return;
    }

    try {
        const walletUtxos = await lucid.wallet().getUtxos();
        const collateralUtxo = walletUtxos.find(u => u.assets.lovelace >= 5000000n);
        if (!collateralUtxo) throw new Error("No UTXO >= 5 ADA found in wallet for collateral");

        const tx = await lucid.newTx()
            .collectFrom(utxos, Data.void())
            .attach.SpendingValidator(script as SpendingValidator)
            .addSigner(address)
            .complete();

        const signedTx = await tx.sign.withWallet().complete();
        const txHash = await signedTx.submit();
        console.log(`Claimed ${utxos.length} UTXOs. Tx Hash: ${txHash}`);
    } catch (e) {
        console.error("Claiming failed:", e);
    }
}


if (import.meta.main) {
  const args = Deno.args;
  if (args.length === 0) {
      console.log("Commands:");
      console.log("  lock <amount_lovelace> <receiver_address> [walletIndex]");
      console.log("  claim [walletIndex]");
      console.log("  balance [walletIndex]");
      console.log("  transfer <amount_lovelace> <to_address> [walletIndex]");
      console.log("  prepare <count>");
      Deno.exit(1);
  }

  const cmd = args[0];

  if (cmd === 'lock') {
      if (!args[1] || !args[2]) {
          console.log("Usage: lock <amount> <receiver_address> [walletIndex]");
          Deno.exit(1);
      }
      await lock(args[1], args[2], args[3] || 0);
  } else if (cmd === 'claim') {
      await claim(args[1] || 0);
  } else if (cmd === 'balance') {
      await balance(args[1] || 0);
  } else if (cmd === 'transfer') {
      if (!args[1] || !args[2]) {
          console.log("Usage: transfer <amount> <to_address> [walletIndex]");
          Deno.exit(1);
      }
      await transfer(args[1], args[2], args[3] || 0);
  } else if (cmd === 'prepare') {
      if (args[1]) await prepare(parseInt(args[1]));
      else console.log("Provide count");
  } else {
      console.log("Unknown command");
  }
}
