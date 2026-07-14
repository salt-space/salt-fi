# Hosting a Robo Guardian on AWS

**One-click via CloudFormation** (recommended): in "Create organisation",
choose "AWS CloudFormation" when setting up Robo Guardians, pick a stack
name, and open the generated URL while signed into the AWS console. It
launches a pre-filled stack that installs Docker, generates and encrypts
the robo's seed, and starts the container automatically — no server access
needed at all.

### If the link just lands you on the empty CloudFormation page

The generated URL is an AWS deep link: everything that pre-fills the stack
(template, stack name, parameters) lives in the URL's `#...` fragment. AWS
**only keeps that fragment if the console is already loaded in the
`us-east-1` (N. Virginia) region.** If opening the link makes AWS switch
region or refresh your sign-in first, it silently drops the fragment and
you end up on the bare CloudFormation console — even though you're logged
in. This is an AWS behaviour, not a problem with the link itself.

Two ways around it:

1. **Load us-east-1 first.** Open CloudFormation, switch the region selector
   to *N. Virginia (us-east-1)*, let it finish loading, then paste the URL
   into that same tab.
2. **Create the stack by hand.** Create stack → With new resources → *Amazon
   S3 URL*, paste the template URL, and fill the parameters. The app prints
   the exact template URL, region, and parameter values alongside the link
   for this purpose. (The parameter AWS labels `ApiKey` is the robo's OTP /
   one-time password — a secret; treat it like a password.)

This was broken for TESTNET through SDK `0.0.26` — `generateCloudFormationUrl()`
pointed at a template hardcoding the mainnet API domain (`app.salt.space`)
and Arbitrum One's chain ID (`42161`) instead of TESTNET's
(`testnet.salt.space`, `421614`), so the container would boot but never
authenticate. **Fixed as of SDK `0.0.27`** — see the root `claude.md` for how
this was verified (the template is now environment-namespaced and its
contents were checked directly). No one's launched a real stack from it in
this app yet, so if you hit anything unexpected, compare against the
self-hosted path below and flag it.

## Self-hosted (manual EC2)

If you'd rather not use CloudFormation, "Create organisation" can also
generate the same self-hosted install script used on other platforms.
Launch an Ubuntu or Debian EC2 instance, get a root shell on it (SSH with
your key pair, or EC2 Instance Connect from the console), then follow the
same steps as the [Hostinger guide](hostinger.md) from "get the script onto
the box" onward.
