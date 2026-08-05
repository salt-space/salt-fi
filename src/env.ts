import "dotenv/config";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name} (see .env.example)`);
  }
  return value;
}

export const env = {
  get privateKey(): `0x${string}` {
    const key = requireEnv("PRIVATE_KEY");
    if (!key.startsWith("0x")) {
      throw new Error("PRIVATE_KEY must be a 0x-prefixed hex string");
    }
    return key as `0x${string}`;
  },
  get rpcUrl(): string | undefined {
    return process.env.RPC_URL || undefined;
  },
};
