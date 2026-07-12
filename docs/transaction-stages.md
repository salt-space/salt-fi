# Transaction ceremony stages

`salt.submitTx()` drives a transaction through four stages, reported via the
`stateChanged` event on the returned `TransactionHostCeremony` (see
`TransactionStage` in the SDK's type definitions — this is quoted directly
from its doc comments, not inferred):

| Stage | What it means |
|---|---|
| `proposing` | Creating the transaction record and running policy checks. |
| `signing` | Nudging robo co-signers and running the MPC signing rounds. |
| `broadcasting` | Broadcasting the signed transaction to the destination chain. |
| `confirming` | Waiting for the transaction to be confirmed on-chain. |

Practically: `proposing` is a REST/DB-level step (create the `AccountTransaction`
record, evaluate the account's policies — spending limits, approvers,
`denied_proposers`, etc. — against it). The websocket/relay side — actually
nudging the robo guardian into a signing session — only starts at `signing`,
not before. We don't have visibility into the exact internal implementation
beyond this (it's a minified bundle), but nothing in the SDK's own stage
definitions attributes any websocket activity to `proposing`.

## What "Send" in this app shows

The app times each stage transition and prints a permanent line as each one
completes (see `src/commands/send.ts`):

- **`Transaction proposed in Xs (tx record + policy check)`** — time spent in
  `proposing`.
- **`Transaction signed in Xs`**, with an optional sub-note
  **`(Ys of that was the MPC round)`** — time spent in `signing`, further
  split using the first `presence` event where every expected signer has
  joined (i.e. the huddle is ready) as the boundary. The remainder before
  that point is nudge/connection latency to the robo, not the cryptographic
  rounds themselves.
- **`Transaction broadcast successfully`** — `broadcasting` completed.
- Final success message, once `confirming` resolves — includes the
  transaction hash if a broadcast receipt was returned.
