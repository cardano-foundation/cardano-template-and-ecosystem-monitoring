import {
applyParamsToScript,
  assetsToValue,
  getAddressDetails,
  Koios,
  Lucid,
  LucidEvolution,
  Script,
  validatorToScriptHash,
} from '@evolution-sdk/lucid';
import { encodeHex } from '@std/encoding/hex';
import { sha3_256 } from '@noble/hashes/sha3.js';
import blueprint from "../../onchain/aiken/plutus.json" with { type: "json" };

export async function prepareProvider() {
  const lucid = await Lucid(
    new Koios('https://preprod.koios.rest/api/v1'),
    'Preprod'
  );

  const mnemonic = Deno.readTextFileSync(`wallet.txt`);
  lucid.selectWallet.fromSeed(mnemonic);

  const address = await lucid.wallet().address();
  const { paymentCredential } = getAddressDetails(address);

  return { lucid, address, paymentCredential };
}

export async function getUserUtxo(lucid: LucidEvolution, address: string) {
  const allUTxOs = await lucid.utxosAt(address);
  return allUTxOs.find((utxo) => {
    const value = assetsToValue(utxo.assets);
    return value.coin() > 2_000_000n;
  });
}

export function getStateTokenName(txHash: string, outputIndex: number): string {
  const txHashBytes = new Uint8Array(
    txHash.match(/.{1,2}/g)!.map((byte) => parseInt(byte, 16))
  );

  const outputIndexString = outputIndex.toString();
  const outputIndexBytes = new TextEncoder().encode(outputIndexString);

  const messageBuffer = new Uint8Array(
    txHashBytes.length + outputIndexBytes.length
  );
  messageBuffer.set(txHashBytes, 0);
  messageBuffer.set(outputIndexBytes, txHashBytes.length);

  const hash = sha3_256(messageBuffer);
  return encodeHex(new Uint8Array(hash));
}

export function resolveVersion(upgradableLogicScriptHash: string, proxyPolicyId: string) {
    const upgradableLogicValidatorV1: Script = {
    type: "PlutusV3",
    script: applyParamsToScript(
      blueprint.validators.find(validator => validator.title.startsWith(`script_logic_v_1`))!.compiledCode,
      [proxyPolicyId]
    ),
  };

  const upgradableLogicValidatorV2: Script = {
    type: "PlutusV3",
    script: applyParamsToScript(
      blueprint.validators.find(validator => validator.title.startsWith(`script_logic_v_2`))!.compiledCode,
      [proxyPolicyId]
    ),
  };

  const isV1Logic = upgradableLogicScriptHash === validatorToScriptHash(upgradableLogicValidatorV1);
  return { version: isV1Logic ? 1 : 2, script: isV1Logic ? upgradableLogicValidatorV1 : upgradableLogicValidatorV2 };
}