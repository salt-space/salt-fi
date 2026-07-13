# salt-fi

A mini terminal app to get started using Salt's new SDK (`@kagamidigital/salt-sdk-mirror`).

Salt is in Beta — treat this project as subject to change.

## Setup

1. Copy `.npmrc.example` to `.npmrc` and add a GitHub PAT with `read:packages`
   scope (you must be a collaborator on `salt-sdk-mirror` to install
   the package, request access from @tamlyn10).
2. Install dependencies:
   ```
   npm install
   ```
3. Copy `.env.example` to `.env` and set:
   - `PRIVATE_KEY` — a 0x-prefixed private key for any EVM EOA (this is the
     wallet that signs the SIWE login and, if you use "Create account",
     co-signs the account's keygen ceremony). You never interact with
     Arbitrum Sepolia directly — that's just the chain Salt uses internally
     to orchestrate ceremonies; the accounts you create/hold assets in can
     live on many other supported testnets.
   - `RPC_URL` — optional; an RPC endpoint for Arbitrum Sepolia, since that's
     the orchestration chain the SDK connects the signer to under the hood.
     Leave blank to use viem's default public RPC for the chain.
4. Run in dev mode:
   ```
   npm run dev
   ```

### Running as two identities at once

Testing things like "Invite member" or "Listen for nudges" needs two signer
identities running at the same time — a single shared `.env` won't do it,
since editing it in one terminal changes the key the other terminal picks up
too. Instead, copy `.env.example` to `.env.a` and `.env.b` (both gitignored),
put a different `PRIVATE_KEY` in each, and run one identity per terminal:

```
npm run dev:a   # uses .env.a
npm run dev:b   # uses .env.b
```

These scripts just set `DOTENV_CONFIG_PATH`, which `dotenv/config` (used in
`src/env.ts`) natively respects to load a file other than `.env`. Both
terminals still share the same `.salt-session.json` cache, but since it's
keyed by wallet address, that's not a problem — each identity gets its own
entry.

## Usage

`npm run dev` signs you in with SIWE (against `testnet.salt.space`, TESTNET's
privileged domain) and drops you into an interactive menu:

- **Create organisation** — create a new organisation with you as owner, then
  optionally register a Robo Guardian host for it and choose how to set it
  up: a self-hosted install script (`robo-setup-<org-name>-<org-id>.sh`,
  gitignored — it embeds a secret API key), fully automated — run it as root
  on any Ubuntu or Debian box and it installs everything it needs (Docker
  included) and starts the robo itself — or an AWS CloudFormation URL that
  launches a pre-filled stack doing the same thing with no server access
  needed. Either way, check progress afterward with "Check robo guardians".
  See [`docs/robo-hosting/`](docs/robo-hosting/README.md) for platform-specific
  walkthroughs (Hostinger validated end-to-end; the AWS template's contents
  are verified correct for testnet, but no one's launched a real stack from
  it yet — more to come).
- **Invite collaborators** — invite another EVM address into an organisation
  you pick, with a role label and access level (owner/member/agent). Only
  organisation owners can actually do this — the API enforces it.
- **Manage collaborators** — edit an existing collaborator's display name,
  role label, and access level. Only organisation owners can do this too —
  the API rejects it otherwise, and also refuses to demote/deactivate an
  organisation's last remaining owner.
- **Manage your invitations** — view pending org invitations and accept or
  decline them.
- **List your organisations** — the organisations you're a member of, and
  your access level in each.
- **Check robo guardians** — see whether an organisation's Robo Guardians
  are currently online, before starting a ceremony that needs them. Worth
  checking if "Create account" ever seems stuck waiting for a signer to join
  — there's no timeout for a party that never shows up in the huddle
  (`timeoutMs` on account creation only bounds keygen rounds *after*
  everyone's present, not the wait for presence itself).
- **Create account** — start a new account's MPC keygen ceremony in an
  organisation (subject to whatever access level the API enforces for your
  membership). Co-signers are picked from the organisation's active
  collaborators (no pasting addresses); Robo Guardians are added
  automatically. Live progress shows each expected signer by name/"You"/"Robo
  guardian" and whether they've joined yet, so it's clear who the ceremony is
  still waiting on.
- **Listen for account nudges** — open a websocket connection and
  automatically join any account-setup ceremony you're nudged for (e.g. a
  teammate names you as a co-signer in "Create account"). Leave it running
  in a terminal while you wait; press Enter to stop.
- **List accounts** — the Salt accounts that exist within an organisation you
  pick.
- **Send assets** — send a mainstream asset (native currency, or a
  well-known token like USDC/USDT/DAI/WETH/WBTC — a curated allowlist rather
  than every balance an aggregator reports, to keep out spam/airdrop tokens)
  from an account you're a signer on. Checks balances across four testnets —
  Sepolia, Arbitrum Sepolia, Polygon Amoy, and Base Sepolia — so the asset
  picker doubles as the chain picker (e.g. "USDC on Base Sepolia"). Recipient
  can be picked from other accounts in the same organisation, or entered
  manually. Shows live signing progress (the account's Robo Guardians,
  nudged automatically), a per-stage timing breakdown
  (proposed/signed/broadcast — see
  [`docs/transaction-stages.md`](docs/transaction-stages.md) for exactly
  what each stage means), and the transaction hash once broadcast.
- **Manage policies** — form-driven CRUD for an account's transaction
  policies (whitelist / blocklist, denied proposers, per-transaction limits,
  contract-call restrictions) across chains. List, add, edit, and delete
  policies via guided prompts, with a few contract-restriction presets (e.g.
  "ERC-20 transfer — only to a specific recipient") to save typing. **No API
  key required** — this is the plain, always-available way to manage
  policies; Policy chat below is the natural-language alternative.
- **Policy chat** — a natural-language agent for reading and managing an
  account's transaction policies (whitelists, per-transaction limits, denied
  proposers, contract-function restrictions). Ask things like "what are my
  policies?", "copy my whitelist to all chains", "copy account A's policies
  onto account B", or "I'm going to trade on AAVE — what should I restrict?".
  Every change it proposes is shown and confirmed before it's applied.
  Requests Salt can't express yet (time-scheduled access, cumulative limits,
  enforced approvals) are logged to
  [`docs/requested-policies.md`](docs/requested-policies.md) for the Salt
  team. Requires an `ANTHROPIC_API_KEY` in `.env` (this is the only feature
  that needs one); powered by Claude via the Anthropic SDK.

The auth token from your first sign-in is cached in `.salt-session.json`
(gitignored) so you don't have to re-sign a wallet message on every launch;
it's discarded automatically and you're prompted to restart if it expires.

## Docs

- SDK docs: https://kagamidigital.github.io/docs/
- TypeDoc/API reference: https://kagamidigital.github.io/salt-sdk-mirror/

## Scripts

- `npm run dev` — run `src/index.ts` directly with `tsx`
- `npm run build` — compile TypeScript to `dist/`
- `npm start` — run the compiled output
