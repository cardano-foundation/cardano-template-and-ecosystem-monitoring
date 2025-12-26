import { describe, it, expect, vi } from 'vitest';

const ASSET_UNIT =
  '648823c9d3132c153f0884d5c0ac41947e935262f2c1ddc0c011355c4d794e4654';
const ASSET_POLICY = ASSET_UNIT.slice(0, 56);
const ASSET_NAME = ASSET_UNIT.slice(56);
const SELLER_PKH = '00'.repeat(28);
const BIDDER_PKH = 'ff'.repeat(28);

vi.mock('@meshsdk/core', async () => {
  const actual = await vi.importActual<any>('@meshsdk/core');
  return {
    ...actual,
    deserializeAddress: () => ({
      pubKeyHash: 'ab'.repeat(28),
      stakeCredentialHash: undefined,
    }),
    deserializeDatum: () => ({
      fields: [
        SELLER_PKH,
        BIDDER_PKH,
        10000000,
        Math.floor(Date.now() / 1000) + 3600,
        ASSET_POLICY,
        ASSET_NAME,
      ],
    }),
  };
});

import { MeshAuctionContract, auctionDatum } from './index.js';

class MockMeshTxBuilder {
  txHex = '';

  txOut() {
    return this;
  }
  txOutInlineDatumValue() {
    return this;
  }
  changeAddress() {
    return this;
  }
  selectUtxosFrom() {
    return this;
  }
  spendingPlutusScript() {
    return this;
  }
  txIn() {
    return this;
  }
  spendingReferenceTxInInlineDatumPresent() {
    return this;
  }
  txInRedeemerValue() {
    return this;
  }
  txInScript() {
    return this;
  }
  txInCollateral() {
    return this;
  }
  invalidBefore() {
    return this;
  }
  complete() {
    this.txHex = 'mock-tx-hex';
    return Promise.resolve();
  }
}

describe('MeshAuctionContract', () => {
  const mockMesh = new MockMeshTxBuilder();

  // Use a valid vkey address that deserializeAddress can handle
  const testAddress =
    'addr_test1qpv9666p9666p9666p9666p9666p9666p9666p9666p9666p9666p';

  const mockFetcher = {
    fetchAddressUtxos: vi.fn().mockResolvedValue([]),
  };

  const mockWallet = {
    getUtxos: vi.fn().mockResolvedValue([
      {
        input: { txHash: '11'.repeat(32), outputIndex: 0 },
        output: {
          address: testAddress,
          amount: [
            { unit: 'lovelace', quantity: '100000000' },
            {
              unit: ASSET_UNIT,
              quantity: '1',
            },
          ],
        },
      },
    ]),
    getUsedAddresses: vi.fn().mockResolvedValue([testAddress]),
    getCollateral: vi.fn().mockResolvedValue([
      {
        input: { txHash: '00'.repeat(32), outputIndex: 0 },
        output: {
          address: testAddress,
          amount: [{ unit: 'lovelace', quantity: '5000000' }],
        },
      },
    ]),
  } as any;

  const contract = new MeshAuctionContract({
    mesh: mockMesh as any,
    fetcher: mockFetcher,
    wallet: mockWallet,
    networkId: 0,
  });

  it('should have a valid script address', () => {
    expect(contract.scriptAddress).toBeDefined();
    expect(contract.scriptAddress).toMatch(/^addr_test/);
  });

  it('should build initiateAuction transaction', async () => {
    const txHex = await contract.initiateAuction(
      {
        unit: ASSET_UNIT,
        quantity: '1',
      },
      Math.floor(Date.now() / 1000) + 3600,
      10000000
    );
    expect(txHex).toBeDefined();
    expect(typeof txHex).toBe('string');
  });

  it('should build placeBid transaction', async () => {
    const sellerPkh = SELLER_PKH;
    const assetPolicy = ASSET_POLICY;
    const assetName = ASSET_NAME;

    // Create a mock datum that deserializeDatum can handle
    const mockDatum = auctionDatum(
      sellerPkh,
      BIDDER_PKH,
      10000000,
      Math.floor(Date.now() / 1000) + 3600,
      assetPolicy,
      assetName
    );

    const auctionUtxo = {
      input: { txHash: '22'.repeat(32), outputIndex: 0 },
      output: {
        address: contract.scriptAddress,
        amount: [
          { unit: 'lovelace', quantity: '10000000' },
          { unit: assetPolicy + assetName, quantity: '1' },
        ],
        plutusData: mockDatum, // Passing the object directly might work with Mesh's internal logic in some versions, or we might need to serialize it
      },
    } as any;

    const txHex = await contract.placeBid(auctionUtxo, 15000000);
    expect(txHex).toBeDefined();
    expect(typeof txHex).toBe('string');
  });
});
