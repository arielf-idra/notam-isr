// Cloudflare Worker: every 10 minutes (see wrangler.toml), start the
// "Scrape IAA NOTAMs" workflow via GitHub's workflow_dispatch API.
// GitHub's own cron is best-effort and often hours late; this is the
// reliable trigger. The workflow's hourly cron remains as a backup.
//
// Requires the Worker secret GITHUB_TOKEN (fine-grained PAT, notam-isr only,
// Actions: Read and write). Never log the token.

const DISPATCH_URL =
  'https://api.github.com/repos/arielf-idra/notam-isr/actions/workflows/scrape.yml/dispatches';

export default {
  async scheduled(controller, env, ctx) {
    if (!env.GITHUB_TOKEN) {
      throw new Error('GITHUB_TOKEN secret is not set');
    }

    const res = await fetch(DISPATCH_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.GITHUB_TOKEN}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'notam-isr-scheduler',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ ref: 'main' }),
    });

    if (res.status === 204) {
      console.log(`workflow_dispatch accepted (cron ${controller.cron})`);
      return;
    }

    const body = await res.text();
    console.error(`workflow_dispatch failed: HTTP ${res.status}: ${body.slice(0, 1000)}`);
    // Throwing marks this invocation as failed in Cloudflare's logs.
    throw new Error(`workflow_dispatch failed with HTTP ${res.status}`);
  },
};
