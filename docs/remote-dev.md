# Remote Development Through Tailscale

The database host must be running with Supabase dev and Tailscale connected. The other machine must join the same authorized tailnet. These endpoints are private to that tailnet, not public Internet endpoints.

- API and Studio: https://desktop-8sbg15n.tail012010.ts.net:8443
- PostgreSQL host: 100.114.225.123, port 5433, database postgres, user postgres.webbanhang-dev.
- PostgreSQL password and Studio login: protected C:\Tool\SupabaseDev\credentials.env on the database host.

The existing HTTPS service on port 443 is unchanged. Dev uses Tailscale Serve HTTPS port 8443 forwarding to 127.0.0.1:8001, and TCP port 5433 forwarding to 127.0.0.1:5433. Both routes were started with --bg and persist in Tailscale configuration. No Funnel or router port forwarding is enabled. Tailnet access rules still apply; only trusted developers should be granted access because this snapshot contains real data.

Clone the repository on the other machine, switch to developer, and install locked dependencies with npm ci. Transfer C:\Tool\SupabaseDev\remote-website.env securely from the database host into the cloned source as .env.development.local. This file contains DEV keys and a dedicated remote-machine admin signing secret, not production keys. Never commit it. Do not run configure:environments on the other machine: that script reads credentials from the database host's local directories.

Run npm run dev and open http://127.0.0.1:3001 on the coding machine. That website connects through Tailscale to the central DEV database. Dev runtime accepts the explicit DEV_SUPABASE_REMOTE_URL only for HTTPS .ts.net endpoints on port 8443; production still accepts only the local prod URL on port 8000.

The admin status page inspects services on the machine where Next.js runs, not the remote database host. It is not a remote Windows/WSL management console. Dev printers and cron stay disabled.

On the other Windows machine, verify networking with PowerShell:

```powershell
tailscale ping 100.114.225.123
Test-NetConnection 100.114.225.123 -Port 5433
```

To disable only these DEV forwarding routes on the database host:

```powershell
tailscale serve --https=8443 off
tailscale serve --tcp=5433 off
```

Do not run tailscale serve reset; it would remove other existing services.
