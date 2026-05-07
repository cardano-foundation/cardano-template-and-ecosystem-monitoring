// Minimal stub for MeshTxInitiator — satisfies escrow.ts imports without external dependencies
export type MeshTxInitiatorInput = Record<string, any>;

export class MeshTxInitiator {
  // deno-lint-ignore no-explicit-any
  mesh: any;
  languageVersion: string;
  networkId: number;
  version: number;

  constructor(inputs: MeshTxInitiatorInput) {
    this.mesh = inputs["mesh"] ?? {};
    this.languageVersion = "V2";
    this.networkId = inputs["networkId"] ?? 0;
    this.version = inputs["version"] ?? 1;
  }

  // deno-lint-ignore no-explicit-any
  getScriptAddress(_cbor: string): string {
    throw new Error("Not implemented");
  }

  // deno-lint-ignore no-explicit-any
  async getWalletInfoForTx(): Promise<any> {
    throw new Error("Not implemented");
  }

  // deno-lint-ignore no-explicit-any
  async _getUtxoByTxHash(_txHash: string, _cbor: string): Promise<any> {
    throw new Error("Not implemented");
  }
}
