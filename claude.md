# salt-fi

Rebuild of `KagamiDigital/salt-autofi` on Salt's new SDK (INTU has been replaced).
Salt is in Beta — treat all of this as subject to change; verify against
current docs/types before relying on anything below long-term.

## The SDK itself

- **Real package**: `@kagamidigital/salt-sdk-mirror`, scoped, distributed via
  **GitHub Packages** — NOT public npm. A public npm package literally named
  `salt-sdk` exists and is unrelated/unaffiliated; do not install it.
- Install requires a `.npmrc` with a GitHub PAT (`read:packages` scope) and
  being added as an external collaborator on the `salt-sdk-mirror` repo.
  ```
  @kagamidigital:registry=https://npm.pkg.github.com
  //npm.pkg.github.com/:_authToken=YOUR_CLASSIC_PAT
  ```
  `.npmrc` contains a real credential once the token is in it — gitignore it.
- Docs: https://kagamidigital.github.io/docs/
- TypeDoc/API reference: https://kagamidigital.github.io/salt-sdk-mirror/
- When published docs and the installed package's actual type definitions
  disagree, trust the type definitions — this is beta software and docs can
  lag behind. Read `node_modules/@kagamidigital/salt-sdk-mirror` directly
  when in doubt.
- Requires `"type": "module"` in package.json — the SDK ships with top-level
  `await` in an ESM file, which breaks under CJS-default Node resolution.

## Authentication model

- Wallet-based, SIWE (Sign-In with Ethereum). An EOA signs a login message
  via a viem `walletClient`; Salt verifies and issues a session token scoped
  to a **domain**.
- Constructor: `new Salt({ environment: 'TESTNET', domain: 'testnet.salt.space' })`
- **Domain matters a lot**: Robo Guardian configuration (API keys, seed
  material) is only returned to sessions authenticated against Salt's
  *privileged* domain for that environment. For TESTNET, that domain is
  `testnet.salt.space`. Using the wrong domain doesn't necessarily error —
  it can silently return `null` for secrets, or (see CloudFormation bug
  below) connect a live service to entirely the wrong backend.

## Network / chain IDs — the bug we hit

- **TESTNET orchestration chain is Arbitrum Sepolia, chain ID `421614`.**
- Arbitrum **One** (mainnet) is `42161` — do NOT use this for testnet work.
- `INTU_NETWORK` / `INTU_*` naming is from the **old** pre-SDK-rewrite stack.
  If you see `INTU_NETWORK` or similar in any generated config, that's a
  signal you're looking at stale/legacy tooling, not the current SDK.

### Fixed in 0.0.27: AWS CloudFormation robo-host template

Previously (through SDK 0.0.26), `RoboHost.generateCloudFormationUrl()`
pointed at a single hardcoded `setup.cloudformation-x86.yaml`, miswired for
testnet: hardcoded `API_URL="https://app.salt.space/api"` (mainnet/production)
instead of `testnet.salt.space`, `ORCHESTRATION_NETWORK_ID=42161` (Arbitrum
One) instead of `421614`, and a legacy `INTU_NETWORK=arbitrum-main` that
shouldn't have been present. Symptom: container boots, pulls
`saltrobo/app:latest`, but loops forever logging `Socket inactive, attempting
manual reconnection...` against `app.salt.space` — the API key only exists in
testnet's database, so it never authenticates. Was flagged to Jason/Edd as
unresolved.

**Verified fixed as of SDK `0.0.27`** (checked by diffing 0.0.26 vs 0.0.27's
bundled `salt.es.js` directly, then generating a real URL and fetching the
template): `generateCloudFormationUrl()` now builds an environment-namespaced
template URL (`https://${environment.name}-robo-signers-cloud-launch-template.s3...`,
ties into the `EnvironmentName` enum added in 0.0.26's types) instead of one
universal bucket. The `testnet-robo-signers-cloud-launch-template` bucket's
`setup.cloudformation-x86.yaml` now correctly has
`API_URL="https://testnet.salt.space/api"` and `SALT_CHAIN_ID=421614`, and no
`INTU_NETWORK` reference at all. Re-verify with the same
diff-then-fetch-the-template approach before trusting this on any future SDK
bump — don't assume a fix holds across versions without checking again.

### What actually works for testnet robo hosting

Both paths are now viable on `0.0.27`+:
- `RoboHost.generateSetupScript()` (self-hosted install script) — verified
  working end-to-end on a Hostinger VPS, correctly pulled
  `saltrobo/staging:latest` and connected to `testnet.salt.space` with
  `HTTP 200` on every step, no reconnect loop.
- `RoboHost.generateCloudFormationUrl()` — the bug above is fixed as of
  0.0.27 (verified by fetching the actual template, see above), but salt-fi
  hasn't wired this path into `create-organisation.ts` yet (it intentionally
  only offers `generateSetupScript()` today). Re-verify end-to-end (actually
  launch a stack) before wiring it up and defaulting users to it.

## Org / Account structure

- `createOrganisation()` → org with an owner (your EOA).
- `createRoboHost({ name, organisationId, ownerAddress })` — one robo host
  per org; a second call 409s. Use `getRoboHost({ organisationId })` to
  fetch the existing one instead of re-creating.
- `RoboHost.provisioned` — true once at least one signer has actually
  connected. If false, `generateSetupScript`/`generateCloudFormationUrl`
  are safe to re-run (per SDK docs).
- **Accounts require at least 2 collaborators** on the org (owner + 1) before
  they can be created — invite a second member first if starting fresh.
- Largest account configuration needs up to 3 Robo Guardian signers.

## Migration notes from salt-autofi

- Re-check every call site that referenced INTU-specific naming/config —
  treat `INTU_*` anywhere in the old codebase as a signal that section needs
  rewriting against the new SDK, not a direct port.
- Old repo may reference mainnet or a different environment entirely; don't
  assume its network/chain constants carry over to TESTNET work here.