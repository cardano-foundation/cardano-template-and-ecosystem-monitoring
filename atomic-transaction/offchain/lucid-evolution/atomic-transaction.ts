import { 
  Lucid, 
  Koios, 
  Data, 
  fromText, 
  Constr, 
  generateSeedPhrase, 
  LucidEvolution, 
  MintingPolicy,
  mintingPolicyToId,
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

async function mint(walletIndex: string | number = 0) {
    const lucid = await Lucid(new Koios("https://preprod.koios.rest/api/v1"), "Preprod");
    selectWallet(lucid, walletIndex);

    const address = await lucid.wallet().address();
    console.log(`Using address: ${address}`);

    const validator = blueprint.validators.find(v => v.title === "atomic.placeholder.mint");
    if (!validator) throw new Error("Minting validator not found");

    const script: MintingPolicy = {
        type: "PlutusV3",
        script: validator.compiledCode
    };

    const policyId: string = mintingPolicyToId(script);
    const assetName = fromText("AtomicToken");
    const unit: string = policyId + assetName;

    // Redeemer: Password is "super_secret_password"
    // MintRedeemer { password: ByteArray } -> Constr(0, [bytes])
    const redeemer = Data.to(new Constr(0, [fromText("super_secret_password")]));

    try {
        const tx = await lucid.newTx()
            .mintAssets({ [unit]: 1n }, redeemer)
            .attach.MintingPolicy(script)
            .complete();

        const signedTx = await tx.sign.withWallet().complete();
        const txHash = await signedTx.submit();
        console.log(`Minted 1 AtomicToken. Tx Hash: ${txHash}`);
        console.log(`Asset ID: ${unit}`);
    } catch (e) {
        console.error("Minting failed:", e);
    }
}

async function burn(walletIndex: string | number = 0, amountStr: string = "1") {
    const lucid = await Lucid(new Koios("https://preprod.koios.rest/api/v1"), "Preprod");
    selectWallet(lucid, walletIndex);

    const validator = blueprint.validators.find(v => v.title === "atomic.placeholder.mint");
    if (!validator) throw new Error("Minting validator not found");

    const script: MintingPolicy = {
        type: "PlutusV3",
        script: validator.compiledCode
    };

    const policyId: string = mintingPolicyToId(script);
    const assetName = fromText("AtomicToken");
    const unit: string = policyId + assetName; // Asset Name
    
    // Redeemer: Password matches
    const redeemer = Data.to(new Constr(0, [fromText("super_secret_password")]));
    
    const amount = BigInt(amountStr) * -1n;

    try {
        const tx = await lucid.newTx()
            .mintAssets({ [unit]: amount }, redeemer)
            .attach.MintingPolicy(script)
            .complete();

        const signedTx = await tx.sign.withWallet().complete();
        const txHash = await signedTx.submit();
        console.log(`Burned ${-amount} AtomicToken. Tx Hash: ${txHash}`);
    } catch (e) {
        console.error("Burning failed:", e);
    }
}


if (import.meta.main) {
  const args = Deno.args;
  if (args.length === 0) {
      console.log("Commands: mint [walletIndex], burn [walletIndex] [amount], prepare <count>");
      Deno.exit(1);
  }
  
  const cmd = args[0];
  
  if (cmd === 'mint') {
      await mint(args[1] || 0);
  } else if (cmd === 'burn') {
      await burn(args[1] || 0, args[2] || "1");
  } else if (cmd === 'prepare') {
      if (args[1]) await prepare(parseInt(args[1]));
      else console.log("Provide count");
  } else {
      console.log("Unknown command");
  }
}
