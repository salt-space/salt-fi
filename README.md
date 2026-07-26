# salt-fi

A mini terminal app to get started using Salt's new SDK ([`salt-sdk`](https://www.npmjs.com/package/salt-sdk) on npm).

Salt is in Beta — treat this project as subject to change.

## New to the terminal? Start here

No experience needed — this section gets you comfortable before anything else.
If you already live in a terminal, skip to [Prerequisites](#prerequisites).

**What is a terminal?** It's just a window where you type commands instead of
clicking buttons. This whole app runs inside that window: you'll type a command
to start it, then use your arrow keys and Enter to move through menus. That's
it — no coding required.

**Open your terminal:**

- **macOS** — press `Cmd + Space` to open Spotlight, type `Terminal`, and press
  Enter. (It also lives in Applications → Utilities → Terminal.)
- **Windows** — click Start, type `PowerShell`, and press Enter. (Or open the
  newer "Windows Terminal" if you have it — either works.)
- **Linux** — press `Ctrl + Alt + T`, or search your apps for "Terminal".

A window opens with a blinking cursor. You type a line, press Enter, and it
runs. If something looks stuck, you can always press `Ctrl + C` to stop the
current command and get your prompt back.

**Move into a folder.** After you clone this project (step 1 of
[Setup](#setup)), you need to tell the terminal to "go into" that folder before
running the app. The command is `cd` (short for "change directory"):

```
cd salt-fi
```

Not sure of the full path to the folder? On macOS and most Linux desktops you
can type `cd ` (with a space after it), then **drag the folder from your file
explorer onto the terminal window** — it fills in the path for you. Then press
Enter. To check where you are, type `pwd` ("print working directory") and press
Enter; it shows the folder you're currently in.

That's the whole toolkit you need: open the terminal, `cd` into the folder, and
type the commands below exactly as shown.

## Prerequisites

You'll need these installed on your machine first:

- **Node.js 22 or newer** (this installs `npm` alongside it). Grab it from
  [nodejs.org](https://nodejs.org/) or, if you juggle Node versions, via
  [nvm](https://github.com/nvm-sh/nvm) (`nvm install 22 && nvm use 22`). The
  SDK declares Node 24+, so on 22 you may see a harmless `EBADENGINE` warning
  during `npm install` — it still works. Verify your install with:
  ```
  node --version   # should print v22.x or higher
  npm --version
  ```
- **Git** — to clone this repository ([git-scm.com](https://git-scm.com/)).
- **An EVM wallet private key** — a 0x-prefixed private key for any Ethereum
  account (see step 3 below for what it's used for). A throwaway key is fine
  for testnet; don't reuse one that holds real mainnet funds.

## Setup

1. Clone the repository and enter it:
   ```
   git clone https://github.com/salt-space/salt-fi.git
   cd salt-fi
   ```
2. Install dependencies:
   ```
   npm install
   ```
3. Copy `.env.example` to `.env` and set:
   - `PRIVATE_KEY` — a 0x-prefixed private key for any EVM EOA (this is the
     wallet that signs the SIWE login and, if you use "Create account",
     co-signs the account's keygen ceremony). You never interact with
     Arbitrum Sepolia directly — that's just the chain hosting Salt's on-chain
     shard registry (where your account's key shards are registered/backed up).
     Salt covers the gas for those registry operations — the signer's wallet
     never pays gas; the accounts you create/hold assets in can live on many
     other supported testnets.
   - `RPC_URL` — optional; an RPC endpoint for Arbitrum Sepolia, the chain Salt
     records key-shard registry data on. The SDK labels this the "orchestration
     chain", but that's a misnomer — the MPC ceremonies (keygen + signing) run
     over the websocket, not on this chain. Leave blank to use viem's default
     public RPC for the chain.
4. Run in dev mode:
   ```
   npm run dev
   ```
   This signs you in and drops you into the interactive menu. First-time
   users should pick **Getting started** for a guided walkthrough.

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
privileged domain) and drops you into an interactive menu. It's grouped, with a
guided walkthrough at the top and the individual tools organised into submenus.

- **Getting started** — a guided, five-step walkthrough that teaches each Salt
  concept as it sets it up: organisation → collaborators → Robo Guardians →
  account → first policy. It detects what you've already done and resumes, and
  when a step depends on something outside the terminal (a collaborator
  accepting an invite, a Robo Guardian coming online) it polls for a bit, then
  lets you exit and re-run later to continue. Aimed at first-time users; drawn
  from the [Salt onboarding docs](https://kagamidigital.github.io/docs/documentation/using-salt/onboarding).

### Organisation

- **Create organisation** — create a new organisation with you as owner, then
  optionally register a Robo Guardian host for it and choose how to set it
  up: a self-hosted install script (`robo-setup-<org-name>-<org-id>.sh`,
  gitignored — it embeds a secret OTP / one-time password), fully automated — run it as root
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

### Robo Guardians

- **Set up Robo Guardians** — register (or re-issue setup for) an existing
  organisation's robo host and get its self-hosted script or CloudFormation
  URL — the same setup "Create organisation" offers, but available any time,
  not just at creation. Reuses an existing host record rather than failing if
  one's already registered.
- **Check robo guardians** — see whether an organisation's Robo Guardians
  are currently online, before starting a ceremony that needs them. Worth
  checking if "Create account" ever seems stuck waiting for a signer to join
  — there's no timeout for a party that never shows up in the huddle
  (`timeoutMs` on account creation only bounds keygen rounds *after*
  everyone's present, not the wait for presence itself).

### Accounts

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

### Assets

- **Faucet for Salt accounts** — top up a Salt account with test funds on any
  of the four supported testnets (only fully set-up accounts are offered as
  targets, not your signing wallet). Pick the account and network; it prints
  and can open the account's address alongside **Circle** (the chain's gas
  token — ETH, or POL on Amoy — plus testnet USDC) and **Google Cloud** (gas
  token only). Both work for brand-new accounts with no prior mainnet
  history, unlike Alchemy or Chainlink's faucets. Circle also has a
  programmatic drip API — a future upgrade once we have a verified API key.
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
- **Swap assets** — swap one of the account's ERC-20 tokens for another. Two
  paths: **Fast swap** (Uniswap v3 — an immediate on-chain swap, no API key)
  and **Slow swap** (Turbine — coming soon). Fast swap quotes across Uniswap's
  fee tiers, picks the best, then runs the `approve` and the swap as MPC
  ceremonies from the account itself. Uniswap v3 is deployed on Sepolia, so
  unlike a mainnet-only aggregator this works on testnet today (e.g. USDC ↔
  WETH). ERC-20 → ERC-20 only for now (wrap native first). See
  [`docs/swap.md`](docs/swap.md).

### Policies

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
