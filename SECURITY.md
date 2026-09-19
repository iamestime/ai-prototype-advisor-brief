# Security policy

Advisor Brief is a public demonstration repository. Do not commit runtime credentials, client data, or private filing material.

## Secret handling

- Store `GEMINI_API_KEY` and `SUPABASE_SERVICE_ROLE_KEY` only in encrypted server runtime bindings or an ignored local environment file.
- Never expose a privileged value through a `VITE_` variable, browser bundle, response payload, log, screenshot, test fixture, or documentation example.
- `.env`, `.env.*`, private-key files, and certificate bundles are ignored. `.env.example` is the only environment template allowed in Git.
- `npm run security:secrets` inspects the tracked tree for prohibited runtime files and common credential signatures. It runs as part of `npm test`.
- Rotate a credential immediately if it is ever committed. Removing a file in a later commit does not revoke or erase a secret from Git history.

The removed repository `.env` contained only Supabase project identifiers, URL, and a publishable browser key. No Gemini key, Supabase service-role key, private key, or other privileged credential was found in the tracked history reviewed for this release.

## Reporting

Please report a suspected vulnerability privately through [AiQorx](https://aiqorx.com/contact). Do not open a public issue containing exploit details or credentials.
