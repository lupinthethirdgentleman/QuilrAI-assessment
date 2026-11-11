/**
 * Mints a development JWT for the gateway.
 *   npm run task2:token -- admin alice
 *   npm run task2:token -- viewer bob
 * The token goes to stdout, so it can be captured: TOKEN=$(npm run -s task2:token -- viewer)
 */
import { signJwt } from "./jwt.js";

const [role = "viewer", sub = `${role}-user`] = process.argv.slice(2);
const secret = process.env.GATEWAY_JWT_SECRET ?? "dev-only-secret-change-me";
const now = Math.floor(Date.now() / 1000);

process.stdout.write(
  signJwt({ sub, role, aud: process.env.GATEWAY_AUDIENCE ?? "mcp-gateway", iat: now, exp: now + 3600 }, secret) + "\n",
);
