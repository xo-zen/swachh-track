# No-Login Demo

The demo now opens without a phone number, OTP, login page or sign-out control. The web console opens as Resident and offers all five seeded roles in the header. The collector app opens directly as Collector; device registration is still required before collection.

## Configuration

```dotenv
NODE_ENV=development
DEMO_MODE=true
NO_AUTH=true
```

`NO_AUTH=true` is included in `.env.example` and `render.yaml`. The hosted-demo launcher also defaults to it. For an existing local `.env`, add the setting and restart the API. Both clients discover the setting through `/api/v1/access`; no new client environment flag or rebuild is needed to switch modes. Use the usual installation, migrations, fictional seed and app startup instructions in the README.

This is tokenless access, not automatic OTP login. Requests select an allowed persona with `X-Demo-Role`; the API resolves the exact seeded identity and membership. Missing or altered seed records fail visibly. Membership, tenant, role, evidence ownership, device, QR and signed-storage checks remain in place. The five personas cannot become SUPER_ADMIN. Profile edits and resident identity changes are locked.

Anyone who can reach this demo can choose any of its five roles and change shared fictional business data. Use isolated fictional data only. Audits identify the selected shared persona, not a verified visitor. Production API configuration rejects this mode. Existing authenticated behavior remains available with `NO_AUTH=false`.

## Verification

Verified on 2026-10-25 with Node 22, pnpm 10.11.0 and disposable local PostgreSQL 15.19:

- Workspace lint, all six package typechecks, production Next build and Expo dependency compatibility passed.
- Real PostgreSQL API tests cover all five tokenless roles, blocked credentials, altered seed identities, scope restrictions, identity locks and collector exception forwarding.
- Collector tests cover startup, offline restore, mode changes, explicit identity denial across retry/restart, device binding and preserved queue scope. Denied sessions are invalidated without deleting queued evidence.
- Ten scripted browser checks passed against the production-built web app: direct entry, five roles, reload, locked identity controls, mobile navigation and Hindi.
- An additional browser outage/retry check showed an error and retry button, not login, and recovered without credentials. Captured app traffic contained no authentication endpoint or bearer-token requests.

Full suite: **30 test files, 582 passed, one skipped**. The skipped route-registration test applies only to the other access mode. Screenshots and machine-readable results are supplied with this change's downloadable verification summary.

Native Android execution, Docker, public deployment and provider storage were not tested in this change. The browser used a private request bridge and local evidence storage, not a public deployment. Verification was completed locally before committing or pushing the changes.

The React type override in `package.json` resolves an existing split-version type conflict found during full-workspace verification; all packages now use the same pinned React types.
