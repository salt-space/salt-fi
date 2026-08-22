# salt-fi

A terminal app for getting started with the Salt SDK. Salt is in Beta — treat
this project as subject to change, and verify against the current docs and
package types before relying on anything below long-term.

## The SDK

- Install [`salt-sdk`](https://www.npmjs.com/package/salt-sdk) from public npm —
  a plain `npm install`, no authentication needed.
- Docs: https://docs.salt.space
- API reference: https://developer.salt.space/sdk/
- When the published docs and the installed package's type definitions
  disagree, trust the types — this is beta software and the docs can lag. Read
  `node_modules/salt-sdk` directly when in doubt.
- Requires `"type": "module"` in package.json — the SDK ships top-level `await`
  in an ESM file, which breaks under CJS-default Node resolution.

## Authentication model

- Wallet-based, SIWE (Sign-In with Ethereum). An EOA signs a login message via a
  viem `walletClient`; Salt verifies it and issues a session token scoped to a
  **domain**.
- Constructor: `new Salt({ environment: 'TESTNET', domain: 'testnet.salt.space' })`
- **Domain matters**: Robo Guardian configuration (the robo credential and seed
  material) is only returned to sessions authenticated against Salt's privileged
  domain for that environment. For TESTNET that domain is `testnet.salt.space`.
  Using the wrong domain doesn't necessarily error — it can silently return
  `null` for secrets.
- The robo credential is surfaced to users as an **OTP (one-time password)**.

## Network / chain IDs

- **TESTNET's Arbitrum Sepolia (chain ID `421614`) is Salt's shard-registry
  chain** — the on-chain registry where an account's key shards are registered
  and backed up. Salt itself pays the gas for those registry operations; the
  signer's wallet never pays gas (creating or using an account costs the signer
  nothing on this chain). The MPC ceremonies (keygen + signing) run over the
  websocket, not on this chain.
- Arbitrum **One** (mainnet) is `42161` — don't use it for testnet work.

## Robo Guardian hosting

Both hosting paths work:
- `RoboHost.generateSetupScript()` — a self-hosted install script; run it as
  root on any Ubuntu/Debian box and it installs everything it needs (Docker
  included) and starts the robo.
- `RoboHost.generateCloudFormationUrl()` — an AWS CloudFormation URL that
  launches a pre-filled stack doing the same thing with no server access needed.

## Org / account structure

- `createOrganisation()` → an organisation with an owner (your EOA).
- `createRoboHost({ name, organisationId, ownerAddress })` — one robo host per
  org; a second call 409s. Use `getRoboHost({ organisationId })` to fetch the
  existing one instead of re-creating.
- `RoboHost.provisioned` — true once at least one signer has connected. While
  false, `generateSetupScript` / `generateCloudFormationUrl` are safe to re-run.
- **Accounts require at least 2 collaborators** on the org (owner + 1) before
  they can be created — invite a second member first if starting fresh.
- The largest account configuration uses up to 3 Robo Guardian signers.
