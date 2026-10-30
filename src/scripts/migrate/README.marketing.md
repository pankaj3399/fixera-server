# Marketing lead rollout

Stop API writes while applying these offline migrations. Back up the target database first.
Both scripts require `MIGRATION_MONGO_URI` explicitly, never load `.env`, and never use
`MONGO_URI` or `MONGODB_URI`. They print the selected database name before processing.
Set `MIGRATION_MONGO_URI` securely in the shell environment for the intended target.

Preview both scripts, then apply to that same target:

```sh
npm run migrate:marketing-leads -- --dry-run
npm run migrate:marketing-identities -- --dry-run
npm run migrate:marketing-leads -- --apply
npm run migrate:marketing-identities -- --apply
```

Omitting mode flags is read-only for both scripts. Combining `--apply` and `--dry-run`
is rejected. Dry runs do not create collections/indexes or run application startup helpers.
The lead apply drops only obsolete single-field unique `emailNormalized` indexes before
normalization, merges exact active tuple duplicates, preserves other email variants and
opt-outs, removes legacy `validatedRows` payloads, and explicitly creates the lead indexes.
Check reported unnormalizable rows and other unique email indexes before restarting the API.
Reruns are supported; apply is not transactional and interrupted runs may be partially applied.
No campaign delivery or provider synchronization occurs in these scripts.
