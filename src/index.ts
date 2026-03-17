/**
 * Gather CLI – subcommands: music, dance, spin, login.
 * Run: yarn start <command> [options]
 */
import { runMusic } from "./commands/music.js";
import { runDance } from "./commands/dance.js";
import { runSpin } from "./commands/spin.js";
import { runLogin } from "./commands/login.js";

const subcommand = process.argv[2];

async function main(): Promise<void> {
  if (process.env.DEBUG) {
    console.log("Debug mode enabled (DEBUG=1)");
  }

  const spaceIdArg = process.argv[3];
  switch (subcommand) {
    case "music":
      await runMusic();
      break;
    case "dance":
      await runDance();
      break;
    case "spin":
      await runSpin();
      break;
    case "login":
      await runLogin(spaceIdArg);
      break;
    default:
      if (subcommand === "-h" || subcommand === "--help" || !subcommand) {
        console.log(`
Usage: yarn start <command> [options]

Commands:
  music             Update Gather custom status from Apple Music (every 5s)
  dance             Move randomly and show party emoji
  spin              Spin in place (faceDirection + 🌀 emote)
  login [spaceId]   Interactive Google OAuth login (opens browser); optional space ID or space URL saved to .auth

Examples:
  yarn start music
  yarn start dance
  yarn start spin
  yarn start login
  yarn start login <spaceId-or-spaceUrl>   save space to .auth for music/dance
`);
        process.exit(0);
      }
      console.error("Unknown command:", subcommand);
      console.error("Run 'yarn start --help' for usage.");
      process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
