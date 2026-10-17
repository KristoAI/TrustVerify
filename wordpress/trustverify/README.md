# TrustBunny WordPress embed plugin

Copy this directory to `wp-content/plugins/trustverify`, activate it, then open **Settings → TrustBunny**. Enter your deployed TrustBunny HTTPS origin and the site's public ID, and enable the gate.

Register the WordPress site's exact origin in TrustBunny. Choose a return URL that renders a normal WordPress page containing `wp_footer()` so the same embed script runs there. All public pages use the same client policy, branding, geographic rules, and site receipt. Disable page-level optimization that strips the script's `data-site` attribute.

This is an **embed plugin**, not a server access-control plugin. WordPress still serves page HTML, REST responses, feeds, media, and downloads. A JavaScript overlay can be removed. Use the session API and a server-side WordPress integration to protect restricted responses. No server API key is stored by this plugin.

For CSP-controlled sites, allow the verification origin for scripts and connections; the embed currently uses inline shadow-root styles. This plugin's settings validate and escape input and use WordPress's Settings API for capabilities/nonces. A WordPress runtime acceptance test is still required before distribution; no WordPress installation is bundled with this repository.

The plugin directory, PHP functions, and saved option names retain their original `trustverify` identifiers so existing installations keep their settings. The public service domain is `https://trustbunny.com`; use your local or self-hosted origin when appropriate.
