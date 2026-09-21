# Cloudflare Web Analytics

Administrators can view public-site traffic under **Overview → Analytics**.
Analytics is optional and disabled until connected.

## Connect

Your public site must already collect data with Cloudflare Web Analytics.
Studio reads those statistics; it does not install the collection script or
change Cloudflare settings.

1. In **Site Settings → General**, set the public site URL and time zone.
   Analytics matches its exact hostname, so `www.example.com` and `example.com`
   are separate targets.
2. Open **Site Settings → Analytics** and select **Select site in Cloudflare**.
   Choose your site, then copy the browser address into **Web Analytics URL**.
   Studio fills in the Account ID and Site Tag.
3. Select **Create API Token in Cloudflare**. The link preselects
   **Account Analytics → Read**. Create the token in the site's Cloudflare
   account and paste it into **API Token**.
4. Select **Test connection**, then enable Analytics and save. Testing uses the
   current form values without saving. A successful query with no traffic in
   the last 24 hours confirms API access, not that collection is working.

To enter the Account ID and Site Tag yourself, turn on **Enter IDs manually**.
Site Tag identifies the Web Analytics site, not the collection script's token.
Only the two IDs are saved from the URL; its date range and other filters do
not change Studio's statistics.

The saved token is encrypted with `STUDIO_AUTH_SECRET` and is never returned
to the browser or included in Preview Data. Leave the token field empty to
keep it; enter a value to replace it. Disable Analytics before removing its
saved token. Keep `STUDIO_AUTH_SECRET` stable or re-enter the token after
changing that secret.

## Read the statistics

The default period is the last 24 hours. Choose a relative range from 30 minutes
to 30 days, ending at the latest five-minute boundary. The daily breakdown uses
the site's time zone and includes only traffic within that range. Results are
cached for up to five minutes; the screen shows when they were fetched. It does
not refresh automatically.

- **Page views:** page views reported by Cloudflare for the selected site.
- **Visits:** arrivals from another site or a direct link, not unique people.
  One visit can include several page views. See [Cloudflare's metric definitions](https://developers.cloudflare.com/web-analytics/data-metrics/high-level-metrics/).
- **Top URLs and referring sites:** the ten highest page-view totals over the
  entire selected period. Empty referrers appear as **Direct / unknown**.

Cloudflare may return sampled estimates. Query failures are shown separately
from a successful result with no traffic. If a query exceeds the account's
Analytics limits, try the shorter period or retry later.
