# Mobile API — Setup & deploy notes

The iOS app (`myopia-ios`) now has a matching Express router at
`/api/mobile`. Everything lives inside this repo — no separate service.

## What was added

- `prisma/schema.prisma`
  - `parent_child_link` — a parent (app user) ↔ child-profile mapping
  - `child_hospital_link` — links a child profile to a real hospital patient
  - `mobile_refresh_token` — hashed refresh tokens for the mobile JWT flow
  - `oauth_identity` — unified Apple / Google / Kakao / Naver identities
  - `myopia_status` enum — added `unknown` so the app can record "잘 모름" / "Don't know"
- `prisma/migrations/20260421100000_mobile_api/migration.sql` — DDL for the four new tables
- `prisma/migrations/20260425100000_myopia_status_unknown/migration.sql` — `ALTER TYPE myopia_status ADD VALUE 'unknown'`
- `src/lib/mobileAuth.ts` — JWT access tokens + rotating refresh tokens
- `src/lib/socialAuth.ts` — provider token verifiers
- `src/routes/mobile.ts` — all `/api/mobile/*` endpoints, including the new parent-entered routes (parental refraction + nearwork/outdoor activity + 6-month reminder summary)
- `src/index.ts` — mounts the router at `/api/mobile`
- `package.json` — adds `jsonwebtoken`, `jose`, and `@types/jsonwebtoken`

## Local setup (on your Mac)

```bash
cd myopiaBackend
npm install                  # installs jsonwebtoken / jose
npx prisma generate          # regenerates the Prisma client with new models
npx prisma migrate deploy    # applies the mobile_api migration to the dev DB
npx tsc                      # type-check should now pass
npm run dev                  # starts the server on :3000
```

> The sandbox running the agent cannot download Prisma engine binaries, so
> `prisma generate` was not run here. You'll need to run it once on your
> Mac to refresh `node_modules/.prisma/client`.

## Required environment variables

Add these to your `.env` (and to the VM's systemd env file / secret store):

```env
# --- JWT ---
# Generate with: node -e 'console.log(require("crypto").randomBytes(64).toString("hex"))'
MOBILE_JWT_SECRET=<64-char random hex>
MOBILE_JWT_ISSUER=myopiamanage.org

# --- Apple Sign In ---
APPLE_BUNDLE_ID=com.yourcompany.MyopiaCareApp

# --- Google (iOS client id from Google Cloud console) ---
GOOGLE_IOS_CLIENT_ID=<project>.apps.googleusercontent.com
# GOOGLE_CLIENT_ID is already set for the web flow; verification accepts both

# --- Kakao / Naver ---
# No secrets needed server-side — provider access tokens are verified via
# their userinfo endpoints. Issue them with your app-side keys.
```

## Endpoint surface (matches `myopia-ios/docs/API_SPEC.md`)

| Method | Path | Auth |
| ------ | ---- | ---- |
| POST | `/api/mobile/auth/signup` | public |
| POST | `/api/mobile/auth/login`  | public |
| POST | `/api/mobile/auth/social` | public |
| POST | `/api/mobile/auth/refresh` | public (token) |
| POST | `/api/mobile/auth/logout` | Bearer JWT |
| GET  | `/api/mobile/auth/me`     | Bearer JWT |
| GET / POST / PATCH / DELETE | `/api/mobile/children[/...]` | Bearer JWT |
| GET  | `/api/mobile/hospitals` | public |
| POST / DELETE | `/api/mobile/children/:id/hospital-links[/...]` | Bearer JWT |
| GET  | `/api/mobile/children/:id/{axial-length,refractive-error,mean-k,treatments,summary}` | Bearer JWT |

### Child-delete semantics (important)

`DELETE /api/mobile/children/:childId` removes the `parent_child_link` and
its `child_hospital_link` rows (cascade). It does **not** touch the
hospital's `patient` record or the `measurement` / `refractive_error` /
`patient_k` / `patient_treatment` rows tied to it. The foreign keys in
`child_hospital_link` to `patient` and `hospital` are `ON DELETE NO ACTION`
to enforce this at the DB level too.

### Web compatibility (`user_patient` mirror)

The iOS app shares the existing `user` / `password_auth` tables with myopiamanage.org, so any `regular_user` account can sign in with the same id+password. To make the *children list* match too, `/api/mobile/children` reads from both `parent_child_link` (iOS-side) and `user_patient` (the table populated by the web's regular-user "register child" flow), tagging each result with `source: "app" | "web"`. Patients managed only by HCPs (no `user_patient` row) are intentionally NOT exposed.

iOS link/unlink also writes through to `user_patient` so the mirror stays in sync:

- `POST /children/:id/hospital-links` upserts a `user_patient(user_id, patient_id)` row alongside the new `child_hospital_link`.
- `DELETE /children/:id/hospital-links/:hospitalId` removes the matching `child_hospital_link` and, when no other iOS hospital-link of the same user still references that patient, also drops the `user_patient` row.
- `DELETE /children/:id` (app-source) cascades the same way; (web-source) just removes the `user_patient` row.

### Hospital-link matching

When the parent taps "Link a hospital" the app sends `{ hospitalCode,
registrationNumber }`. The server:

1. Looks up `hospital` by code.
2. Looks up `patient` by `(hospital_id, registration_number_hash)` using the
   existing `hashRegistrationNumber` HMAC helper — no plaintext regnum in DB.
3. KMS-decrypts the patient's `encrypted_date_of_birth` and compares against
   the DOB/sex the parent entered when creating the child profile.
4. On full match → `INSERT INTO child_hospital_link`. On any mismatch → 404
   with `{ error: "no matching record" }` (no information leak).

## Production rollout checklist

1. Deploy the migration (`npx prisma migrate deploy`) to a staging DB first.
2. Deploy the new code; verify `/api/mobile/hospitals` returns `[]` or real rows.
3. Point the iOS TestFlight build at the staging URL and smoke-test.
4. Apply the migration to prod; deploy the new server build.
5. Add a rate limiter (e.g. `express-rate-limit`) on `/api/mobile/auth/*` —
   10 req/min/IP is a reasonable starting point.
