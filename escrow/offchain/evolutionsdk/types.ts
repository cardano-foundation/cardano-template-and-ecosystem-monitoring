import { Data, Assets } from '@evolution-sdk/lucid';

export type StoredEscrow = {
  txHash: string;
  initiator: string;
  recipient?: string;
  initiatorAssets: Assets;
  recipientAssets?: Assets;
  state: 'Initiation' | 'ActiveEscrow';
};

export const Credential = Data.Enum([
  Data.Object({ VerificationKey: Data.Tuple([Data.Bytes()]) }),
  Data.Object({ Script: Data.Tuple([Data.Bytes()]) }),
]);

export const StakeCredential = Data.Enum([
  Data.Object({ Inline: Data.Tuple([Credential]) }),
  Data.Object({
    Pointer: Data.Tuple([Data.Integer(), Data.Integer(), Data.Integer()]),
  }),
]);

export const Address = Data.Object({
  payment_credential: Credential,
  stake_credential: Data.Nullable(StakeCredential),
});

export const MValue = Data.Map(
  Data.Bytes(),
  Data.Map(Data.Bytes(), Data.Integer())
);

export const EscrowDatum = Data.Enum([
  Data.Object({
    Initiation: Data.Object({
      initiator: Address,
      initiator_assets: MValue,
    }),
  }),
  Data.Object({
    ActiveEscrow: Data.Object({
      initiator: Address,
      initiator_assets: MValue,
      recipient: Address,
      recipient_assets: MValue,
    }),
  }),
]);

export const EscrowRedeemer = Data.Enum([
  Data.Object({
    RecipientDeposit: Data.Object({
      recipient: Address,
      recipient_assets: MValue,
    }),
  }),
  Data.Literal('CancelTrade'),
  Data.Literal('CompleteTrade'),
]);
