# myopiaBackend (EYELOG)

Express + Prisma + PostgreSQL backend.

## Setup

1. Copy `.env.example` to `.env` and fill in the values.
2. `npm install`
3. `npx prisma migrate dev` (applies migrations and generates the client)
4. `npm run dev`

## Email alerts (SMTP)

Set `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, and `SMTP_FROM` in `.env` to enable threshold-exceeded notification emails; leave them blank to disable outgoing email.
