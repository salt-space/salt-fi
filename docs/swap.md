# Swapping assets

"Swap assets" swaps one of a Salt account's ERC-20 tokens for another. There
are two paths:

- **Fast swap** — an immediate on-chain swap via **Uniswap v3**. No API key,
  no external service; it's pure on-chain contracts.
- **Slow swap** — via **Turbine** (a private orderbook that settles over a
  time window). Coming soon — it's pending a testnet endpoint from the Turbine
  team, so the menu option is a placeholder for now.

## How fast swap works

Everything runs from the **MPC account**, not your signing EOA — the `approve`
and the swap are both ordinary contract calls executed through
`salt.submitTx`, so they go through the normal MPC signing ceremony (co-signers
and Robo Guardians nudged automatically), exactly like "Send assets".

1. Pick the account (one you're a signer on) and the chain.
2. Pick the token to sell (from the account's own balances) and the token to
   buy (a curated shortcut list, or paste any ERC-20 address), the amount, and
   a max slippage (default 0.5%).
3. The app quotes your pair across Uniswap's three fee tiers (0.05% / 0.3% /
   1%) via QuoterV2 and picks the best output. `amountOutMinimum` is derived
   from that quote and your slippage.
4. If the router's allowance is short, an `approve` ceremony runs first, then
   the swap ceremony (`SwapRouter02.exactInputSingle`). The bought tokens land
   back in the same account.

## Scope (v1)

- **ERC-20 → ERC-20 only.** To swap the chain's native currency, wrap it to
  WETH first and swap that. Native in/out (which needs the router's
  `msg.value` wrapping and a `multicall` + `unwrapWETH9`) is a follow-up.
- **Testable on Sepolia today.** Uniswap v3 is deployed on Sepolia with liquid
  WETH/USDC pools, so fast swap works end-to-end on a Salt Sepolia account —
  unlike mainnet-only aggregators (1inch, and Turbine, which were both ruled
  out for fast swap for exactly this reason).

## Verified Uniswap v3 deployment (Sepolia, chain 11155111)

| Contract | Address |
| --- | --- |
| UniswapV3Factory | `0x0227628f3F023bb0B980b67D528571c95c6DaC1c` |
| SwapRouter02 | `0x3bFA4769FB09eefC5a80d6E87c3B9C650f7Ae48E` |
| QuoterV2 | `0xEd1f6473345F45b75F8179591dd5bA1888cf2FB3` |
| WETH9 | `0xfff9976782d46cc05630d1f6ebab18b2324d6b14` |
| USDC (known liquid) | `0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238` |

Add more chains in `src/uniswap.ts` (`UNISWAP_V3_BY_CHAIN`) only after
confirming the addresses on-chain the same way (mainnet + other testnets are
in Uniswap's deployment docs).
