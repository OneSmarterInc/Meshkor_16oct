# meshkor-web

Marketing site for MeshKor — the trust authority for AI agents.

Static, no build step. Five pages:

- `index.html` — landing
- `builders.html` — for builders
- `receivers.html` — for receivers
- `how-it-works.html` — the pedigree, sandbox, credential root
- `programme.html` — the Trusted Bot Programme and trust ladder

## Deploy

Hosted on Vercel. Every push to `main` deploys automatically; pull requests get preview URLs. No framework, no build command — Vercel serves the files at the root.

## Local preview

Open `index.html` in a browser, or run `python3 -m http.server` from this folder and visit http://localhost:8000.

## Waitlist

The signup form on `index.html` posts to the URL in the form's `data-endpoint` attribute. Set it to a real POST endpoint (a Vercel serverless function or a Formspree URL) to capture emails. Until it's a valid https URL the form validates and confirms client-side but stores nothing.
