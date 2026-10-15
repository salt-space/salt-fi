import type { CreatePolicyRequest, Policy, PolicyParams, Salt } from "salt-sdk";
import type { SaltWalletClient } from "./wallet.js";

/**
 * Policy writes across salt-sdk versions.
 *
 * From salt-sdk 0.0.44 the caller signs every policy change (a "seal"), so these methods take
 * the signer's wallet client as an extra, required last argument:
 *
 *   createAccountPolicy(policy, walletClient)
 *   updateAccountPolicy(policyId, params, walletClient)
 *   deleteAccountPolicy(policyId, walletClient)
 *
 * salt-sdk 0.0.43 and earlier have the shorter signatures, which is what this app's call sites use.
 * Called the short way on a newer release, a write fails at runtime with `InvalidSigner` ("The wallet
 * client has no attached signer account").
 *
 * Rather than thread a wallet through every call site, `loadSalt()` installs this shim once, binding
 * in the wallet that signed that session, so a seal is always signed by the session's own signer. A
 * call that passes its own wallet client is left alone. Every Salt instance in the app comes from
 * `loadSalt()`; one built any other way must pass the wallet itself. Feature-detected on
 * `createAccountPolicies` (the batch write that arrived with seals), so it is a no-op on 0.0.43.
 */
declare module "salt-sdk" {
  // The shim supplies the wallet, so call sites may leave it out (see above). On 0.0.43 these
  // repeat the SDK's own signatures.
  interface Salt {
    createAccountPolicy(policy: CreatePolicyRequest): Promise<Policy>;
    updateAccountPolicy(policyId: string, params: PolicyParams): Promise<Policy>;
    deleteAccountPolicy(policyId: string): Promise<void>;
  }
}

const POLICY_WRITES = { createAccountPolicy: 1, updateAccountPolicy: 2, deleteAccountPolicy: 1 } as const;

/** True when this salt-sdk's policy writes need a wallet client (0.0.44 and later; not 0.0.43 and earlier). */
export const policiesNeedSigner = (salt: unknown): boolean =>
  typeof (salt as { createAccountPolicies?: unknown })?.createAccountPolicies === "function";

export function installPolicyCompat<T extends Salt>(salt: T, walletClient: SaltWalletClient): T {
  const s = salt as unknown as Record<string, unknown> & { __policyCompat?: boolean };
  if (s.__policyCompat || !policiesNeedSigner(salt)) return salt;
  s.__policyCompat = true;
  for (const [name, arity] of Object.entries(POLICY_WRITES)) {
    const original = (s[name] as (...a: unknown[]) => Promise<unknown>).bind(salt);
    s[name] = (...args: unknown[]) => original(...(args.length > arity ? args : [...args.slice(0, arity), walletClient]));
  }
  return salt;
}
