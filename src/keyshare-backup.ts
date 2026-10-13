import { createWalletClient, hashTypedData, http, type Address, type Hex, type TypedDataDefinition } from "viem";
import { toAccount } from "viem/accounts";
import { env } from "./env.js";
import type { SaltWalletClient } from "./wallet.js";

/**
 * The EIP-712 request salt-sdk makes of a signer to derive the key that encrypts
 * its keyshare for `accountId` (fed through Salt's OPRF). It's SDK-internal —
 * observed in salt-sdk 0.0.43 — so if an upgrade changes it, the flows that use
 * {@link keyshareBackupSigner} warn that the early approval went unused.
 */
export function keyshareKeyRequest(signer: Address, accountId: string) {
  return {
    domain: { name: "salt.space", version: "1" },
    types: {
      DeriveKey: [
        { name: "account", type: "address" },
        { name: "id", type: "string" },
        { name: "action", type: "string" },
        { name: "version", type: "string" },
      ],
    },
    primaryType: "DeriveKey",
    message: { account: signer, id: accountId, action: "derive-key", version: "v2" },
  } as const;
}

/**
 * Wraps the signer for an account-setup ceremony so its keyshare backup can be
 * approved *before* keygen.
 *
 * The SDK asks for the backup signature only after keygen has produced this
 * signer's new keyshare. On a Ledger that's a device prompt, and rejecting it
 * (or the device locking) there throws the keyshare away. So: {@link approve}
 * the request up front, while nothing has been generated, and the SDK's later
 * request is answered from memory. Every other request still goes to the signer.
 * Pass {@link walletClient} to the SDK as the ceremony's signer.
 */
export function keyshareBackupSigner(signer: SaltWalletClient) {
  const approvals = new Map<Hex, { signature: Hex; used: boolean }>();
  const requestHash = (accountId: string) => hashTypedData(keyshareKeyRequest(signer.account.address, accountId));

  const account = toAccount({
    address: signer.account.address,
    signMessage: (args) => signer.account.signMessage(args),
    signTransaction: (transaction, options) => signer.account.signTransaction(transaction, options),
    signTypedData: async (typedData) => {
      const approval = approvals.get(hashTypedData(typedData as TypedDataDefinition));
      if (!approval) return signer.account.signTypedData(typedData);
      approval.used = true;
      return approval.signature;
    },
  });

  return {
    walletClient: createWalletClient({ account, chain: signer.chain, transport: http() }),

    /** Sign the keyshare backup request for `accountId` now (a prompt, on a Ledger). */
    async approve(accountId: string): Promise<void> {
      const signature = await signer.account.signTypedData(keyshareKeyRequest(signer.account.address, accountId));
      approvals.set(requestHash(accountId), { signature, used: false });
    },

    /** Drop the approval for `accountId`, returning whether the SDK used it. */
    release(accountId: string): boolean {
      const hash = requestHash(accountId);
      const used = approvals.get(hash)?.used ?? false;
      approvals.delete(hash);
      return used;
    },
  };
}

/** Spinner text while {@link keyshareBackupSigner}'s `approve` waits on the signer. */
export function approvingMessage(): string {
  return `Approving your keyshare backup${env.signer === "ledger" ? " — confirm on your Ledger" : ""}`;
}

/** Shown when the SDK asked for something other than the early approval, so a Ledger was asked again after keygen. */
export const UNUSED_APPROVAL_WARNING =
  "salt-sdk's keyshare backup asked for a different signature than the one approved before keygen, so a Ledger " +
  "would have asked again after keygen. Re-check keyshareKeyRequest in src/keyshare-backup.ts against the installed salt-sdk.";
