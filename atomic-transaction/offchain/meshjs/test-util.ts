import {applyCborEncoding, resolveScriptHash,} from "@meshsdk/core";


export const alwaysSucceedCbor = applyCborEncoding(
  "58340101002332259800a518a4d153300249011856616c696461746f722072657475726e65642066616c736500136564004ae715cd01",
);

export const alwaysSucceedHash = resolveScriptHash(alwaysSucceedCbor, "V3");

