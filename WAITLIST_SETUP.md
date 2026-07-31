# MeshKor waitlist setup

This branch turns the existing landing-page waitlist into a real registration flow.

## What happens on signup

1. The visitor submits an email address.
2. `/api/waitlist` validates and normalizes the email.
3. The email is stored in Supabase. Duplicate addresses are not inserted again.
4. A confirmation email is sent to the visitor from the configured MeshKor SMTP mailbox.
5. A notification email is sent to `info@meshkor.com` (or `WAITLIST_ADMIN_EMAIL`).
6. Delivery flags are recorded in the waitlist row.

## 1. Create the Supabase table

Create a Supabase project, open **SQL Editor**, and run:

`supabase/waitlist.sql`

The table keeps these fields:

- `id`
- `email` (unique)
- `status`
- `source`
- `confirmation_sent`
- `admin_notified`
- `email_last_attempt_at`
- `created_at`

RLS is enabled and there are no public policies. The Vercel API uses a server-side Supabase secret key, which bypasses RLS. The legacy service-role key is also supported as a fallback.

## 2. Add Vercel environment variables

In the Vercel project, add these variables for the Preview deployment first:

- `SUPABASE_URL`
- `SUPABASE_SECRET_KEY` (recommended current server-side key)
- `SMTP_HOST`
- `SMTP_PORT` (`587` for STARTTLS or `465` for SSL)
- `SMTP_USER=info@meshkor.com`
- `SMTP_PASSWORD`
- `SMTP_FROM=MeshKor <info@meshkor.com>`
- `WAITLIST_ADMIN_EMAIL=info@meshkor.com`

If your Supabase project only exposes legacy keys, `SUPABASE_SERVICE_ROLE_KEY` is supported instead of `SUPABASE_SECRET_KEY`.

Do not commit real secrets to GitHub. `.env.example` contains placeholders only.

## 3. Deploy the branch preview

Deploy branch `agent/waitlist-smtp-supabase` on Vercel. The root route is rewritten to `/api/home`, which serves the existing `index.html` and injects the current deployment origin into its waitlist `data-endpoint`. This allows Preview and Production deployments to use the same code.

## 4. Test

Submit an email that is not already in the table. Verify all three results:

1. A new row exists in `public.waitlist`.
2. The entered address receives the MeshKor confirmation email.
3. `info@meshkor.com` receives the admin notification.

Submit the same email again. The API should return success with `duplicate: true`, and no second database row or duplicate emails should be created.

## SMTP notes

Use the SMTP host and port supplied by the provider hosting `info@meshkor.com`. For reliable delivery, configure SPF, DKIM, and DMARC for `meshkor.com` with that provider.
