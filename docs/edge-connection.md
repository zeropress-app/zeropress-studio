# Edge connection addresses

In **Edge Services**, save **Edge URL** as an HTTPS origin, for example
`https://edge.example.com`. Do not include `/api`, a query, or a custom port.
For local development, HTTP and custom ports are accepted on `localhost`,
`127.0.0.1`, and `[::1]`.

The Edge URL and the site URL are independent. They may be identical: a site
at `https://site.example.com` can use Edge through a Worker route for
`site.example.com/api/*`. Routes do not rewrite paths; `/api2/*` does not create
an alternative Edge API prefix.

Studio derives these addresses from the saved origin:

| Connection | Address |
| --- | --- |
| Comments API base | `<origin>/api` |
| Form | `<origin>/api/forms/<form slug>` |
| Newsletter | `<origin>/api/newsletters/<newsletter slug>` |

Comment settings show the derived API base. Each Form's Settings tab and the
Newsletter screen provide URL and `config.json` copy actions. Use
`form_endpoint` in `public/zp_form/config.json` and `newsletter_endpoint` in
`public/zp_newsletter/config.json` for the blog theme samples.

Saving the URL does not enable a public service. Edge feature flags, form/list
status, request protection, and allowed origins still apply. The site newsletter
setting controls its theme entry point separately.

When the Edge URL is empty, Studio omits the comments connection and request
tokens from Preview Data. Export and GitHub publishing remain available. After
changing the URL, generate and publish new Preview Data and update any standalone
sample configuration you use.

## Existing installations

Edge schema 1→2 removes the former `edge_comment_settings.api_base_url` column.
Use the Edge database upgrade in [Maintenance & Recovery](maintenance-and-recovery.md#edge-database-lifecycle-and-target-reconciliation),
then enter the Edge URL yourself. The old address is not converted or copied.
Studio's own database schema does not change for this setting.
