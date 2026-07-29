import type { AccountCeremonyEvents } from "salt-sdk";

// salt-sdk 0.0.35 excludes the `SafeEventEmitter` base class from its published
// types ("Excluded from this release type: SafeEventEmitter" in its
// index.d.ts). Because `AccountCeremony extends SafeEventEmitter`, that strips
// the typed `.on()` (and the rest of the emitter surface) from `AccountCeremony`
// / `HostAccountCeremony` even though the runtime still emits these events — so
// consumer code like `ceremony.on("presence", …)` fails to typecheck.
//
// Restore the typed event API via declaration merging until the SDK re-exports
// the base class. Runtime is unaffected; this is a types-only shim.
declare module "salt-sdk" {
  interface AccountCeremony {
    on<E extends keyof AccountCeremonyEvents>(event: E, listener: AccountCeremonyEvents[E]): this;
    once<E extends keyof AccountCeremonyEvents>(event: E, listener: AccountCeremonyEvents[E]): this;
    off<E extends keyof AccountCeremonyEvents>(event: E, listener: AccountCeremonyEvents[E]): this;
    removeListener<E extends keyof AccountCeremonyEvents>(event: E, listener: AccountCeremonyEvents[E]): this;
    emit<E extends keyof AccountCeremonyEvents>(event: E, ...args: Parameters<AccountCeremonyEvents[E]>): boolean;
  }
}
