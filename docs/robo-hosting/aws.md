# Hosting a Robo Guardian on AWS

**The SDK's built-in one-click path is currently broken for TESTNET** —
`RoboHost.generateCloudFormationUrl()` produces a template that hardcodes
the mainnet API domain (`app.salt.space`) and Arbitrum One's chain ID
(`42161`) instead of TESTNET's (`testnet.salt.space`, `421614`). The
symptom is a container that boots and pulls the image but loops forever
failing to authenticate, since the API key only exists in testnet's
database. See the root `claude.md` for details — this is flagged upstream
and unresolved as of this session, so this app intentionally doesn't expose
that option ("Create organisation" only generates the self-hosted script).

**You're not fully blocked in the meantime**, though: the self-hosted script
works fine on a plain EC2 instance today, you just don't get the
CloudFormation quick-launch convenience. Launch an Ubuntu or Debian EC2
instance, get a root shell on it (SSH with your key pair, or EC2 Instance
Connect from the console), then follow the same steps as the
[Hostinger guide](hostinger.md) from "get the script onto the box" onward.

Once the CloudFormation template is fixed upstream, this guide should be
replaced with the proper one-click flow — generate the URL from
`generateCloudFormationUrl()`, open it signed into AWS, and it launches a
pre-filled stack that does the same setup automatically.
