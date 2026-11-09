/**
 * Profiles: `npm run dev <name>` runs as the identity in `.env.<name>`, so any
 * `.env.<name>` file you create can be used without a package.json script of its own.
 */

const PROFILE_FILE = /^\.env\.([\w.-]+)$/;

/** The profile names among `files` (a directory listing): every `.env.<name>` except the `.env.example` template. */
export function profileNames(files: readonly string[]): string[] {
  return files
    .flatMap((f) => {
      const name = PROFILE_FILE.exec(f)?.[1];
      return name && name !== "example" ? [name] : [];
    })
    .sort();
}

/**
 * The env file a command-line argument names (`b` or `.env.b` → `.env.b`), or why it names none.
 * `files` is the directory listing to look in, so only a file that's really there can be chosen.
 */
export function resolveProfile(arg: string, files: readonly string[]): { file: string } | { problem: string } {
  const name = arg.replace(/^\.env\./, "");
  const names = profileNames(files);
  if (names.includes(name)) return { file: `.env.${name}` };
  const here = names.length > 0 ? `Profiles here: ${names.join(", ")}.` : "There are no profiles here yet.";
  return { problem: `No profile "${name}" (looked for .env.${name}). ${here} To make one, copy .env.example to .env.${name}.` };
}
