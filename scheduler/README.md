# notam-isr scheduler

GitHub runs scheduled workflows on a best-effort basis. In practice the
`*/10 * * * *` cron in `scrape.yml` fired only every 2.5–10 hours, so
`notams.json` was often more than 3 hours old.

This folder holds a tiny Cloudflare Worker that runs on Cloudflare's cron
every 10 minutes and starts the scrape workflow through GitHub's
`workflow_dispatch` API. The workflow's own cron is now hourly and only acts as
a backup. Its `concurrency` group means a dispatched run and a cron run never
overlap.

- `worker.js` – the `scheduled()` handler. No dependencies.
- `wrangler.toml` – Worker name, cron trigger. Contains no secrets.

## Cost

- **Cloudflare:** the Workers free plan covers this. That is about 4,320
  invocations a month, well inside the free limits. The Worker has no public URL.
- **GitHub Actions:** the repository is public, so runs on GitHub-hosted
  runners are free. If the repository is ever made private, every run is
  billed. Each run takes about 2.5 minutes and is billed as 3, so 144
  dispatched runs a day plus 24 backup runs come to roughly **15,000 minutes
  a month**. That is far beyond the free private-repo allowance. Stop the
  Worker before making the repository private.

## One-time setup

### a) Create the GitHub token

1. GitHub → Settings → Developer settings → Personal access tokens →
   **Fine-grained tokens** → *Generate new token*.
2. Name: `notam-isr-scheduler`.
3. **Expiration:** pick a date, for example one year out. **Write the expiry
   date down**, for example in a calendar reminder a week before.
4. Resource owner: `arielf-idra`.
5. **Repository access:** *Only select repositories* → `notam-isr`.
6. **Permissions → Repository permissions → Actions: Read and write.** Leave
   everything else at *No access*. GitHub adds *Metadata: Read-only*
   automatically; that is expected.
7. Generate the token and copy it. Do not save it in any file in this
   repository.

### b) Deploy the Worker to Cloudflare

From this `scheduler/` folder:

```bash
npx wrangler login                    # opens a browser to log in to Cloudflare
npx wrangler secret put GITHUB_TOKEN  # paste the token when prompted
npx wrangler deploy
```

If `secret put` says the Worker does not exist yet, answer yes when it offers
to create it, or run `npx wrangler deploy` first and then `secret put`.

### c) Check that it works

- **Cloudflare:** dashboard → Workers & Pages → `notam-isr-scheduler` →
  **Logs** (or run `npx wrangler tail` from this folder). Every 10 minutes
  you should see `workflow_dispatch accepted`. A failure logs
  `workflow_dispatch failed: HTTP <status>: <GitHub's message>`.
- **GitHub:** the repository's **Actions** tab → *Scrape IAA NOTAMs*. A new
  run with event `workflow_dispatch` should appear about every 10 minutes.
- **Feed:** `generatedAt` in
  <https://arielf-idra.github.io/notam-isr/notams.json> should stay under
  about 15 minutes old. A new commit only appears when the NOTAM data actually
  changed.

### d) When the token expires

Dispatches start failing with HTTP 401, and the feed falls back to the hourly
backup cron, which runs late. To fix it:

1. Create a new token exactly as in step (a), or use *Regenerate token* on the
   existing one. Note the new expiry date.
2. From `scheduler/`: `npx wrangler secret put GITHUB_TOKEN` and paste the new
   token. The Worker picks it up without a redeploy.
3. Check the logs as in step (c).
4. Delete the old token on GitHub if it still exists.

Common errors in the Worker logs:

| Status | Meaning |
|---|---|
| 401 | Token expired, revoked, or wrong. Replace it as in (d). |
| 403 / 404 | Token lacks *Actions: Read and write* or is not scoped to `notam-isr`. |
| 422 | The workflow or the `main` branch was renamed, or `workflow_dispatch` was removed from `scrape.yml`. |

## Turning it off

Cloudflare dashboard → the Worker → Settings → Triggers → remove the cron, or
run `npx wrangler delete` from this folder. The hourly cron in `scrape.yml`
keeps running on its own.
