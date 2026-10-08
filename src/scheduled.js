/**
 * Daily cron: run the New Arrivals sync (see wrangler.toml [triggers]).
 *
 * Gated by NEW_ARRIVALS_LIVE: the cron writes ONLY when it equals exactly
 * "true". Anything else (unset, "false", "TRUE", "yes") is a dry run that only
 * logs. Every run logs exactly one summary line to Workers Logs.
 */

import { createBcClient } from "./bc-client.js";
import { runNewArrivalsSync } from "./tools/sync-new-arrivals.js";

export async function runScheduledNewArrivalsSync(env, { bc, now } = {}) {
  const live = env.NEW_ARRIVALS_LIVE === "true";
  const mode = live ? "live" : "dry_run";
  const client = bc || createBcClient(env);
  client.toolName = "sync_new_arrivals (cron)";

  try {
    const result = await runNewArrivalsSync(client, env, { dryRun: !live, now });
    console.log(result.summary);
    return result;
  } catch (e) {
    console.error(
      `new_arrivals_sync mode=${mode} status=error subrequests=${client.subrequestCount} ` +
        `error=${JSON.stringify(e.message)}`
    );
    throw e; // marks the cron invocation as failed in the dashboard
  }
}
