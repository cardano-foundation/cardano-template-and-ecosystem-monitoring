import { Data } from '@evolution-sdk/lucid';

const ProxyDatumSchema = Data.Object({
  script_pointer: Data.Bytes(),
  script_owner: Data.Bytes(),
});

type ProxyDatum = Data.Static<typeof ProxyDatumSchema>;
export const ProxyDatum = ProxyDatumSchema as unknown as ProxyDatum;

const WithdrawalRedeemerV1Schema = Data.Object({
  token_name: Data.Bytes(),
  password: Data.Bytes(),
});

type WithdrawalRedeemerV1 = Data.Static<typeof WithdrawalRedeemerV1Schema>;
export const WithdrawalRedeemerV1 =
  WithdrawalRedeemerV1Schema as unknown as WithdrawalRedeemerV1;

const WithdrawalRedeemerV2Schema = Data.Object({
  invalid_token_name: Data.Bytes(),
});

type WithdrawalRedeemerV2 = Data.Static<typeof WithdrawalRedeemerV2Schema>;
export const WithdrawalRedeemerV2 =
  WithdrawalRedeemerV2Schema as unknown as WithdrawalRedeemerV2;
