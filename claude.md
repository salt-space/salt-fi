# salt-fi

A terminal app for getting started with the Salt SDK. Verify against the
current docs and package types before relying on anything below long-term.

## The SDK

- Install [`salt-sdk`](https://www.npmjs.com/package/salt-sdk) from public npm —
  a plain `npm install`, no authentication needed.
- Docs: https://docs.salt.space
- API reference: https://developer.salt.space/sdk/
- When the published docs and the installed package's type definitions
  disagree, trust the types — the docs can lag. Read
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
- The SDK only ever asks the signer's `walletClient` for **signatures**:
  EIP-191 (SIWE, robo activation) and an EIP-712 `DeriveKey` struct (domain
  `salt.space`) that, through Salt's OPRF, derives the key encrypting that
  signer's keyshare, once per keygen/signing ceremony. So signatures must be
  deterministic (RFC 6979). That's why a Ledger works as the signer
  (`SIGNER=ledger`, `src/ledger.ts`): it's a viem custom account over
  `@ledgerhq/hw-app-eth`, loaded via `require()` because Ledger's ESM build
  breaks under Node's ESM loader.
- Account setup asks for that `DeriveKey` signature only *after* keygen, so a
  Ledger rejection there would lose the new keyshare. `src/keyshare-backup.ts`
  collects it before keygen and answers the SDK's request from memory. It copies
  the SDK-internal struct: re-check `keyshareKeyRequest` when upgrading
  salt-sdk (the flows warn if the early approval went unused).

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

## Trading desk (in progress on `feat/trading-desk`)

"Set up my trading desk": someone who isn't a coder and has no wallet gives this
repo to their own AI agent, and salt-fi sets up an organisation, Robo Guardians
on Aleph Cloud, and an account with a trading agent on it. The agent pitches a
trading strategy; the owner turns it into policies, and approves them, before
funding the account the agent trades from. Venue and chain follow the strategy.
The owner's only manual steps: choose a passphrase, write down the recovery
phrase, send ETH to one address, and the approvals only an owner should make.

**Roles. The separation is the point of the design:**
- **Owner** (the person): a 12-word recovery phrase, encrypted with their
  passphrase (scrypt N=2^17, AES-256-GCM) in `~/.salt-fi/desks/<desk>/owner.json`.
  Creates the organisation, activates the robos (2FA), seals policies, enables
  or stops the agent, funds the account.
- **Trading agent**: its own key, `agent.json` (plain, 0600). Proposes only;
  joins the organisation as an agent (access level 3, being renamed Delegate).
- **Robo Guardian**: on an Aleph Cloud VM the owner pays for. Co-signs only
  within policy.
- **Account**: owner + agent + robo. Owner and agent keys together could sign
  around the robo and the policies, so **an AI assistant must never see, ask
  for, store or type the owner's passphrase or recovery phrase.** Owner-only
  steps are hand-off points the person does themselves.
- **Setup money**: ETH on Ethereum to the owner's address. It pays for Aleph
  credits (bought with ETH on Ethereum), Salt's fees (USDC only, so part is
  converted) and gas. Trading money goes into the account only after the
  policies are sealed.

**Done (Phase 1):** `src/desk/keystore.ts` (keys), `state.ts` (`desk.json`:
progress by step, so setup resumes), `start.ts` (no `PRIVATE_KEY` and no
Ledger → set up, restore or unlock a desk; the recovery phrase shows on the
terminal's alternate screen, then a two-word check), `funding.ts` (budget,
amount of ETH, QR code, waits for it to arrive). Wired in `src/app.ts`;
`createSaltWalletClient(desk?)` in `src/wallet.ts` takes the unlocked owner.
Tests: `test/desk-keystore.test.ts`, `test/desk-setup.test.ts`.

**Next:**
- **Phase 2, setup flow** (resumable through `desk.json` steps `organisation`,
  `agent-invited`, `agent-joined`, `robos`, `robos-activated`, `account`):
  create the organisation as the owner; invite the agent's address as an agent
  and accept with the agent's key; host a robo on Aleph with the owner's key as
  the Aleph wallet (the Aleph command reads `PRIVATE_KEY` from `.env` today:
  pass the desk owner's account instead); owner activates the robo (hand-off);
  create the account (owner + agent + robo).
- **Phase 3, strategy → policies:** the agent writes a strategy file (venue,
  chain, contracts, functions, limits); salt-fi turns it into policies
  (`allowed_recipients`, `transaction_limit_token_denominated`,
  `contract_param_restriction`, and `denied_proposers` as the agent's off
  switch), explains each in plain English, and the owner seals them, then
  funds the account. Builds on PR #49 (contract restriction checks). It is
  open, predates SDK 0.0.44 and needs review. Undecided: bring #49 up to date
  and merge it first, or build on its branch.
- **Phase 4:** a field guide for the person's AI agent, non-interactive agent
  commands (propose a trade with the agent's key, status), and converting ETH
  to USDC for Salt's fees.

**Limits to keep in view:**
- `nominated_approvers` isn't implemented in 0.0.44 (the SDK refuses it).
- Calls whose arguments are structs or bytes (Uniswap V3 `exactInput`,
  Universal Router `execute`) can't be restricted by argument; #49 refuses
  tuple and array arguments.
- Hyperliquid orders are signed messages, not transactions: check whether
  Salt's policies see them before offering it as a venue.
- Fiat on-ramps (Coinbase Onramp, MoonPay, Stripe, Transak) need a business
  account and server keys, so for now: the address, a QR code and US options.

**Testing:** where `.env` holds a real key, run unit tests only
(`npx vitest run --exclude '**/*.integration.test.ts'`); integration tests sign
in. `SALT_DESK_DIR` moves desks to a scratch directory. The prompts can be
driven in a pseudo-terminal with `expect`; give it a width
(`set stty_init "columns 120 rows 40"`) or clack wraps every character.
