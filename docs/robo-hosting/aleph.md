# Hosting a Robo Guardian on Aleph Cloud (experimental)

[Aleph Cloud](https://aleph.cloud) is a decentralised cloud: independent node
operators run virtual machines, and you pay for them by the hour in Aleph
credits. In salt-fi, **Robo Guardians → Set up Robo Guardians → Aleph Cloud VM
(experimental)** (also offered by "Create organisation" and Getting started)
does the whole job for you: it creates a pay-as-you-go VM, runs your
organisation's setup script on it, waits for the robo to connect and offers
2FA activation. You don't rent a server or set up SSH yourself.

Two more menu items go with it:

- **Robo Guardians → Aleph Cloud VMs** lists the VMs created from here, with
  their SSH command, and can resume a setup that stopped, open an SSH session,
  or delete a VM.
- **Robo Guardians → Aleph credits** shows the Aleph wallet's credits and how
  long they'll last, and buys more.

The flow has been run end to end on mainnet: the VM was created, the robo
connected to Salt and was activated. Two things haven't been tested yet:
deleting a VM, and whether Aleph's billing stops the moment it's deleted.

## Before you start

- **An Aleph wallet.** This wallet owns the VM and pays for it from its Aleph
  credits, and the VM's SSH key is derived from it. You have two choices:
  - **A separate wallet:** put its key in `.env` as `ALEPH_PRIVATE_KEY=0x…`.
    When that's set, the flow always uses it.
  - **Your signing wallet:** if you sign with a private key (`SIGNER` unset or
    `private-key`) and there's no `ALEPH_PRIVATE_KEY`, the flow offers your
    `PRIVATE_KEY` wallet. It shows that wallet's address and credits and asks
    first. You're already the robo's trust root (the setup script encrypts its
    seed to you), so this keeps control in one place. The trade-offs: the
    credits sit on your signing key; that key also signs Aleph's messages and
    the message the SSH key comes from; and only that wallet can manage or
    delete the VM later.

  **Signing with a Ledger?** Set `ALEPH_PRIVATE_KEY`: a Ledger can't be the
  Aleph wallet yet. Your Ledger still owns the organisation, the robo's seed
  is still encrypted to it, and it's still what activates the robo.

- **Credits for at least a day.** One VM (1 vCPU, 2 GB RAM, 20 GB disk,
  Debian 12) cost 14,250 credits an hour when this was written, about $10 a
  month (1 USD = 1,000,000 credits); the app reads the live price. The flow
  stops if the wallet holds less than 24 hours' worth. Aleph credits are real
  money whichever Salt environment you're on, testnet included.

- **Buying credits** (Robo Guardians → **Aleph credits**, or offered by setup
  when credits are short). The Aleph wallet pays for its own credits, on
  **Ethereum mainnet**: USDC at exactly 1,000,000 credits per USDC, or ETH at
  the market price. It also needs a little ETH for gas: a USDC payment uses
  about 45,000 gas and an ETH payment about 28,000. Before paying, the app
  checks Aleph's credit contract
  (`0x6b55F32Ea969910838defd03746Ced5E2AE8cB8B`), shows what you'd get and
  the gas, and asks; this defaults to No. Then it waits for the credits to
  land, usually within a minute or two.

  There's no purchase function to call: credits go to whichever address sends
  USDC, ETH or ALEPH to that contract, so a payment can't credit another
  address. Only Ethereum counts. The same address on any other chain has no
  contract, and funds sent there are lost. To get USDC or ETH onto the Aleph
  wallet on Ethereum, send it from a Salt account on mainnet (Assets → Send
  assets), an exchange or another wallet. You can also buy credits outside
  salt-fi, at app.aleph.cloud or with Aleph's CLI (`aleph credit buy`).

- **`ssh` and `scp`** on your machine. macOS and Linux have them, and so does
  Windows 10 and later.

- **A network that allows high ports.** SSH reaches the VM through its node's
  IPv4 address on a random high port. Hotel, guest and office Wi-Fi often
  block those; a phone hotspot is a good fallback. If SSH doesn't answer, the
  flow tells you whether this network blocks high ports or the VM isn't ready
  yet.

## What the flow does

1. **Checks** the Aleph wallet's credits and Aleph's live price, and asks you
   to pick a compute node (see below). It shows what you're about to pay for,
   then asks you to confirm; this defaults to No.
2. **Creates** the VM: an Aleph INSTANCE message pinned to that node. Its SSH
   key is derived from a signature by the Aleph wallet, so the same wallet
   always gives the same key and there's nothing extra to back up. The VM is
   recorded in `.aleph-vms.json` (gitignored) straight away, so it can always
   be found and deleted, even if a later step fails.
3. **Makes it reachable.** It forwards an IPv4 port to SSH (Aleph's
   `port-forwarding` aggregate), starts the VM on its node, waits for its
   address, then gives it up to 4 minutes to boot and answer on SSH. Host keys
   are kept in `.aleph-known-hosts` (gitignored), not your `~/.ssh`.
4. **Runs the setup script.** It copies the generated `robo-setup-….sh` over,
   runs it as root, and deletes it from the VM afterwards, since it holds the
   one-time OTP. The copy on your machine stays for Resume setup; delete it
   once the robo is activated.
5. **Finishes.** It waits for the robo to connect to Salt, then offers 2FA
   activation.

## Picking a node

The picker checks each likely node's live free memory, disk and load (its
public `/about/usage/system` endpoint), and lists only the nodes that answer
with room for the VM plus 25%. First comes the recommended node,
**AlephVision4**, where a robo has run; then nodes where a robo set up from
your copy of salt-fi has connected; then the rest by Aleph's score. To make
another node the recommended one, set `ALEPH_CRN_HASH` in `.env` to its hash.

## After setup: Robo Guardians → Aleph Cloud VMs

Each of these needs the wallet that created the VM (`ALEPH_PRIVATE_KEY`, or
`PRIVATE_KEY` if you used your signing wallet). VMs are recorded in the folder
you run salt-fi from, so run it from the same one.

- **Resume setup:** finishes a VM whose setup stopped partway. It's safe to
  repeat, and it finds the organisation's `robo-setup-…sh` in the working
  directory.
- **Open an SSH session:** derives the key from the owning wallet and opens
  `ssh` in this terminal, as `debian` (with sudo). Type `exit` to come back.
- **Delete it:** erases the VM's disk, drops its port forward, and tells Aleph
  to forget the instance, which should stop its credits. This hasn't been
  tested yet, so check the wallet's credits afterwards (Robo Guardians → Aleph
  credits) to confirm they've stopped going down.

## Trade-offs

- **The robo's seed lives on a VM run by a third-party node operator.** That's
  the price of not running a server yourself.
- **Node quality varies.** A node has been seen to boot a VM with no network
  at all. The picker only offers nodes that answer with room, but it can't
  check a node's networking in advance. If a VM never becomes reachable,
  delete it and set up again on another node: until a robo has connected, its
  setup script can be generated again.
- **Deleting a VM stops that robo for good.** Once a robo host is activated,
  its one-time setup OTP is used up, so it can't be set up again somewhere
  else. The seed backup encrypted to you is for recovery (moving funds out of
  an account), not for bringing the robo back.
- **Untested:** deleting a VM, and whether billing stops the moment it's
  deleted.
