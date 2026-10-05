# Local Runtime

Website: http://localhost:3000/admin/tables

Supabase API: http://localhost:8000

PrintAgent copy: `C:\Tool\PrintAgentLocal`. The original Desktop directory is unchanged.

## Configuration

Run from `C:\Tool\WebBanHang`:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\configure-local.ps1
npm ci
npm run build
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\local-web.ps1 start
```

Local credentials are loaded from `C:\Tool\SupabaseLocal\credentials.env` into the ignored `.env.local` and the copied PrintAgent `.env`. The service role key must never be exposed in a `NEXT_PUBLIC_*` variable.

Rebuild after changing the website URL or public key. The launcher uses the production build and binds only to this machine. Supabase must be running first.

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\local-web.ps1 status
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\local-web.ps1 logs
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\local-web.ps1 stop
```

Logs and the process record are stored under `C:\Tool\SupabaseLocal`.

## Scheduled Database Cleanup

`pg_cron` job `purge-unselected-quota-bills` is active, explicitly authorized on 2026-10-05. Its schedule is `*/5 * * * *` (every five minutes). It can delete local data according to the restored function's rules. The cloud job is unchanged.

## PrintAgent

PrintAgent is running from the copied directory. Its existing printer settings are preserved. `PRINT_JOB_MIN_ID=28267` skips historical imported jobs, including pending jobs 28265 and 28266. New jobs are processed normally. Automatic deletion of old print history is disabled for this test setup.

Manage the local queue consumer:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File C:\Tool\SupabaseLocal\print-agent.ps1 start
powershell -NoProfile -ExecutionPolicy Bypass -File C:\Tool\SupabaseLocal\print-agent.ps1 status
powershell -NoProfile -ExecutionPolicy Bypass -File C:\Tool\SupabaseLocal\print-agent.ps1 logs
powershell -NoProfile -ExecutionPolicy Bypass -File C:\Tool\SupabaseLocal\print-agent.ps1 stop
```

Status page when running: http://localhost:3003

Do not run the original agent against local at the same time. After the printers were powered on, TCP port 9100 connected successfully on 192.168.1.224, 192.168.1.223 and 192.168.1.212. PrintAgent is running and listening to local Realtime. Paper output still needs verification with a new test order; connectivity checks did not print anything.

## Scope

The local website does not replace or shut down the Vercel deployment. Cloud and local databases no longer synchronize. Direct LAN access is not configured by this launcher.

## Windows Login Autostart

The existing HKCU Run entry `WebBanHangSupabaseLocal` now runs the complete stack through `C:\Tool\SupabaseLocal\autostart.ps1`: Supabase, the production website, PrintAgent, the local proxy and the named Cloudflare tunnel. Each stage is retried up to three times, with database readiness checked before dependent services. The temporary trycloudflare link is not started.

Startup happens after this Windows user logs in, not before login. Windows automatic login is not configured. No ChatGPT or Codex session is required for the login trigger. The last production build is reused; startup does not pull or build code.

Logs: `C:\Tool\SupabaseLocal\autostart.log` and per-stage output files alongside it.

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File C:\Tool\SupabaseLocal\autostart.ps1
```

The named tunnel needs Internet access; physical printers must be powered on and reachable. The login launcher retries startup failures but is not a continuous process supervisor.

When launching from a Codex-managed terminal, use `powershell -NoProfile -ExecutionPolicy Bypass -File C:\Tool\SupabaseLocal\start-independent.ps1` (or add `check` for recovery). This uses Windows WMI to launch outside the terminal's job object. The launcher returns immediately; read `autostart.log` or `check-services.log` to confirm completion. Existing healthy processes are not replaced by this launcher. The currently running stack was restarted through WMI and the main website, PrintAgent, proxy, cloudflared and WSL keepalive processes were checked to be outside the Codex job. Login autostart remains independent of Codex.

## Manual Service Recovery

Double-click `C:\Tool\WebBanHang\scripts\check-local-services.cmd`, or run it from CMD. It checks Supabase readiness, website and PrintAgent HTTP responses, the proxy, named tunnel and public domain. Stopped services are started; owned website, PrintAgent or proxy processes that do not respond are restarted. It does not stop unrelated processes, reset data, rebuild the website or send a test print. Normal pending print jobs may be consumed when PrintAgent starts.

For unattended invocation, run `powershell -NoProfile -ExecutionPolicy Bypass -File C:\Tool\SupabaseLocal\check-services.ps1`. Exit code 0 means the checks passed; 1 means a failure or another startup/check is in progress. Logs are in `C:\Tool\SupabaseLocal\check-services.log` and per-stage output files. Run as the configured Windows user, after login. This is an on-demand check, not a scheduled monitor.

## Isolated Dev Database

A separate Supabase stack is installed under `/opt/webbanhang-supabase-dev`, with management files in `C:\Tool\SupabaseDev`. Dev API/Studio uses `http://localhost:8001`, session PostgreSQL uses port `5433`, and the transaction pooler uses `6544`. Keys, database cluster, container names, networks and writable volumes are independent from prod. The existing website, public domain and PrintAgent continue using prod; no application environment was switched.

Dev is seeded from a one-time public-schema snapshot of prod, without production Zalo tokens or private weborder integration settings. Physical printers and cron are disabled. Auth users and Storage data are not copied. Read `C:\Tool\SupabaseDev\README.txt` for management and credentials. Both stacks still share the same physical host and Docker daemon.

### Website Modes

`npm run dev` starts the development website at `http://127.0.0.1:3001`, loading `.env.development.local` and Supabase dev on port `8001`. It writes only `.next-dev`; PWA generation is disabled. The admin UI is marked DEV, uses a separate session cookie/signing key, and its status/log API reads only dev services. It does not connect to the real PrintAgent, printers or public tunnel. Production integration variables are blank in the generated dev environment.

`npm run build` and `npm start` force production mode, loading `.env.production.local`, using Supabase prod on port `8000`, production build folder `.next`, and web port `3000`. The public domain and login autostart use an isolated production release selected by `C:\Tool\SupabaseLocal\production-current.json`, not the developer checkout. See `docs/deployment.md`. The config rejects missing credentials or a database URL/APP_ENV inconsistent with the command's mode, rather than falling back to the other database.

`npm run configure:environments` regenerates both protected, Git-ignored environment files from the local credentials and original `.env.local`. It preserves production integration settings and blanks them in dev. Review edits before regenerating if you have customized either environment-specific file. Do not put real credentials in the committed example files.

Background management: `powershell -NoProfile -ExecutionPolicy Bypass -File C:\Tool\WebBanHang\scripts\local-web.ps1 start -Mode dev` (or `stop`, `status`, `logs`). The default mode remains `prod`. Dev process records/logs are in `C:\Tool\SupabaseDev`; production records/logs remain in `C:\Tool\SupabaseLocal`. Dev web startup is on demand, not added to the Windows login startup.

## Admin Status Dashboard

`/admin/status` shows all eleven Supabase containers, PostgreSQL function availability, cron schedules and latest runs, website, proxy, public domain, Cloudflare process, PrintAgent Realtime mode, Windows printer TCP connectivity, host memory and uptime. Status checks are read-only and cached for 15 seconds. The page checks only when opened or when the user clicks the refresh button; there is no automatic polling. A successful printer TCP connection is not proof that paper was printed. PrintAgent success/failure counters include imported historical jobs, not just the current process lifetime.

The log selector reads only allowlisted local log files or fixed Compose services, with bounded tail output and credential redaction. No shell command, filename or container supplied by the browser is executed. Responses are not cached in the browser. This dashboard has no restart or printing action; use the manual recovery script when the web server itself is unavailable.

Admin login now creates an eight-hour HTTP-only signed session cookie. The layout restores this same server session; the dashboard has no second login form. Old localStorage-only sessions require one login to migrate. The status API rechecks the staff role in PostgreSQL; an arbitrary staff ID or edited browser role does not authorize access. Session signing material lives in the protected local runtime directory, outside Git. A non-Windows deployment requires `ADMIN_SESSION_SECRET` and does not expose this local dashboard backend.

Existing broad anonymous database permissions, including access to staff credentials/roles, are unchanged by this feature and remain a security risk on the public test setup. Signed cookies do not fix those database grants. Restrict database permissions before using this setup as a secure public production deployment.

These URLs work only on this machine. Phone access requires a separate LAN/HTTPS setup. Zalo, Groq, remote fonts, remote images and VietQR still require Internet access where used.

## Temporary HTTPS Test Link

Cloudflared: `C:\Tool\Cloudflared\cloudflared.exe`

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File C:\Tool\SupabaseLocal\tunnel.ps1 start
powershell -NoProfile -ExecutionPolicy Bypass -File C:\Tool\SupabaseLocal\tunnel.ps1 status
powershell -NoProfile -ExecutionPolicy Bypass -File C:\Tool\SupabaseLocal\tunnel.ps1 stop
```

The generated `trycloudflare.com` URL is temporary. It is not automatically restarted after login. Starting a new tunnel may change the URL.

The test link is public without the extra password gate, as explicitly requested after disclosing the risk. The database contains real data and broad existing anonymous permissions. Share the URL carefully and stop the tunnel after testing. Normal staff login still appears inside the app, but does not replace database authorization.

Set `public` to `false` in `C:\Tool\SupabaseLocal\tunnel-mode.json` and restart the tunnel to restore the password gate. Its password is stored in `tunnel-access.json` in the same protected directory.

The loopback-only proxy on port 3005 forwards the website to port 3000 and `/supabase/` API requests to port 8000, including Realtime WebSockets. Supabase Studio and PostgreSQL are not exposed. On localhost, the website continues using Supabase directly. The database stays local; tunnel traffic traverses Cloudflare.

```powershell
node C:\Tool\SupabaseLocal\verify-tunnel.cjs
node scripts\verify-local-runtime.cjs
```
