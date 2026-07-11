import "dotenv/config";
import { Salt } from "@kagamidigital/salt-sdk-mirror";

const salt = new Salt({
  environment: "TESTNET",
  domain: "testnet.salt.space",
});

async function main() {
  console.log("salt-fi starting against", salt);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
