import { createWalletClient, http, type TypedDataDefinition } from "viem";
import { generatePrivateKey, privateKeyToAccount, toAccount } from "viem/accounts";
import { arbitrumSepolia } from "viem/chains";
import { describe, expect, it } from "vitest";
import { keyshareBackupSigner, keyshareKeyRequest } from "../src/keyshare-backup.js";
import { LedgerError } from "../src/ledger.js";

/** A signer that counts typed-data requests, standing in for device prompts. */
function countingSigner(opts: { reject?: boolean } = {}) {
  const local = privateKeyToAccount(generatePrivateKey());
  let prompts = 0;
  const account = toAccount({
    address: local.address,
    signMessage: (args) => local.signMessage(args),
    signTransaction: (tx, options) => local.signTransaction(tx, options),
    signTypedData: async (typedData) => {
      prompts++;
      if (opts.reject) throw new LedgerError("Rejected on the Ledger.", true);
      return local.signTypedData(typedData);
    },
  });
  const walletClient = createWalletClient({ account, chain: arbitrumSepolia, transport: http() });
  return { walletClient, local, prompts: () => prompts };
}

describe("keyshareBackupSigner", () => {
  it("answers the SDK's backup request from the early approval, without asking again", async () => {
    const signer = countingSigner();
    const backup = keyshareBackupSigner(signer.walletClient);

    await backup.approve("acct-1");
    expect(signer.prompts()).toBe(1);

    // The SDK goes through the wallet client, which adds EIP712Domain to the types.
    const request = keyshareKeyRequest(signer.local.address, "acct-1");
    const signature = await backup.walletClient.signTypedData(request);
    expect(signer.prompts()).toBe(1);
    expect(signature).toBe(await signer.local.signTypedData(request));

    expect(backup.release("acct-1")).toBe(true);
  });

  it("forgets an approval once released", async () => {
    const signer = countingSigner();
    const backup = keyshareBackupSigner(signer.walletClient);
    await backup.approve("acct-1");
    backup.release("acct-1");
    await backup.walletClient.signTypedData(keyshareKeyRequest(signer.local.address, "acct-1"));
    expect(signer.prompts()).toBe(2);
  });

  it("passes every other request through to the signer", async () => {
    const signer = countingSigner();
    const backup = keyshareBackupSigner(signer.walletClient);
    await backup.approve("acct-1");

    await backup.walletClient.signTypedData(keyshareKeyRequest(signer.local.address, "acct-2"));
    const other: TypedDataDefinition = {
      domain: { name: "Exchange", version: "1", chainId: 1337 },
      types: { Agent: [{ name: "source", type: "string" }] },
      primaryType: "Agent",
      message: { source: "a" },
    };
    await backup.walletClient.signTypedData(other);
    expect(signer.prompts()).toBe(3);
    expect(await backup.walletClient.signMessage({ message: "hi" })).toBe(await signer.local.signMessage({ message: "hi" }));
  });

  it("reports an approval the SDK never used", async () => {
    const signer = countingSigner();
    const backup = keyshareBackupSigner(signer.walletClient);
    await backup.approve("acct-1");
    expect(backup.release("acct-1")).toBe(false);
  });

  it("lets a rejection surface before anything is generated", async () => {
    const backup = keyshareBackupSigner(countingSigner({ reject: true }).walletClient);
    await expect(backup.approve("acct-1")).rejects.toMatchObject({ rejected: true });
  });
});
