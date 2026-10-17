# Node reference client

Register a **test** site in TrustBunny with origin `http://localhost:4400` and return URL `http://localhost:4400/callback`. Save the generated API key.

From the repository root:

```
TV_EXAMPLE_API_KEY=YOUR_TEST_KEY node examples/node-client/app.mjs
```

Open `http://localhost:4400`. The example demonstrates one-time code exchange, browser-bound state, a server-side session-ID record, and API validation before serving restricted content. Test age checks remain explicitly test results. For a real HTTPS deployment configure `TV_EXAMPLE_ISSUER`, `TV_EXAMPLE_ENVIRONMENT=live`, and `TV_EXAMPLE_HTTPS=1`, and register the corresponding live site's exact origin/return URL.

The webhook route `/webhooks/trustbunny` (with `/webhooks/trustverify` retained as an alias) verifies HMAC signatures over raw request bytes and handles revocation. Set `TV_EXAMPLE_WEBHOOK_SECRET` and configure a reachable public HTTPS URL in the TrustBunny dashboard. Localhost webhook destinations are intentionally blocked. Never expose the API or webhook key in frontend code.

This reference client uses memory for its own sessions and deduplication to keep the example readable. Replace those maps with your application's durable session store and database before production. It always requires an age check; the standalone JavaScript gate demonstrates region-selective prompting. A network error fails closed for protected responses.
