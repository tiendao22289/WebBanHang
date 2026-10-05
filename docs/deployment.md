# Local Production Deployment

`master` is production. `developer` is the working branch. There is no `main` deployment branch.

```powershell
git switch developer
npm run dev
git add <changed-files>
git commit -m "Describe the change"
git push origin developer
```

Open a pull request from `developer` to `master` on GitHub and merge after review. The `Deploy Local Production` workflow runs on pushes to `master`, including merge commits. A manual workflow run is also available on `master`. It never runs on pull requests or developer pushes.

## Runtime Separation

Development source stays in `C:\Tool\WebBanHang`, web port 3001, Supabase dev port 8001. Production releases live in `C:\Tool\WebBanHangReleases`, web port 3000, Supabase prod port 8000. PrintAgent, database and Cloudflare do not restart on web deploy. Production secrets live in the protected `C:\Tool\SupabaseLocal\production.env`, outside Git; edits to source `.env.production.local` do not automatically modify production deployments.

The Windows runner downloads a committed source snapshot into a new release directory, installs locked dependencies with `npm ci`, runs all Node tests, then builds production. Failures before activation leave the current website untouched. Activation briefly stops the old website, switches `production-current.json`, and starts the new website through WMI, outside the Actions process job. An HTTP failure during activation attempts to restore the previous release. Database migrations, data imports, resets and print commands are not performed.

Autostart and manual recovery read the production release pointer through `C:\Tool\SupabaseLocal\production-web.ps1`. Keep previous releases for rollback; they contain dependencies and production keys, so do not publish them. Release deletion is not automatic.

## GitHub Runner

Official Windows x64 runner is installed under `C:\Tool\GitHubRunner`. Register it for `tiendao22289/WebBanHang` using a temporary token from repository Settings > Actions > Runners > New self-hosted runner. Give it label `webbanhang-production` and name `webbanhang-local-production`. Run it as the current Windows user, who owns the WSL distribution and local services.

After registration, `scripts/start-github-runner.ps1` starts the runner independently. The installed copy in `C:\Tool\SupabaseLocal` is used for Windows login startup. The machine must be powered on, connected to the Internet and logged into this Windows account. Closing Codex does not stop the runner or website. This is login startup, not a Windows service running before login.

Self-hosted runners execute trusted repository code with the local user's permissions. This repository is public: never add pull-request or fork-triggered jobs to this production runner. Prefer a private repository, restrict write access, and protect `master` with required review where available. Only trusted maintainers should modify deployment workflows or merge production code. See [GitHub runner security guidance](https://docs.github.com/en/actions/how-tos/manage-runners/self-hosted-runners/add-runners).

## Recovery

Run `scripts/check-local-services.cmd` to recover local services. Deployment results are in GitHub Actions; activation logs are in the deployed release's `activation.log`; runner diagnostics are in `C:\Tool\GitHubRunner\_diag`. `/admin/status` remains the admin-only runtime health/log page. Retrying a failed GitHub job creates a fresh release.

For a manual deployment, check out `master`, then run `powershell -NoProfile -ExecutionPolicy Bypass -File scripts/deploy-production.ps1`. Do not work on master day to day; return to developer afterward.
