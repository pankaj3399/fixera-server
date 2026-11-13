# API message translations (en / nl / fr)

User-facing API messages (`msg`, `message`, `error`, `error.message`,
`data.message`) are returned in the language of the request.

## How it works

- The web app sends its UI language as `Accept-Language` on every API request
  (`lib/i18n/backendLocale.ts` in the frontend). Admin pages send `en`.
- `localizeApiResponses` (`middleware.ts`, mounted in `src/index.ts`) wraps
  `res.json`. For envelope bodies it looks the English copy up in
  `messages/en.ts` and replaces it with the `nl`/`fr` translation.
- Handlers keep writing plain English (`res.json({ msg: "..." })`,
  `new UserFacingError(400, "...")`). Interpolated messages are catalogued as
  templates with `{name}` placeholders and matched against the rendered text.
  Interpolated values that are themselves catalogued (labels such as
  "Subject", weekdays, lists of catalogued items) are translated as well.
- Localized bodies also carry `messageKey` (stable key), `messageParams`
  (interpolated values) and, for nl/fr, `messageEn` (English source) so
  clients can keep matching on stable identifiers.
- Requests without a supported language get the unchanged English body.
  Unknown (uncatalogued) text always falls back to English.

## Adding or changing a message

1. Write the English copy at the call site as usual.
2. Add `"<domain>.<slug>": "<English copy>"` to `messages/en.ts` (use
   `{name}` for `${...}` expressions) and the translations to `messages/nl.ts`
   (informal "je") and `messages/fr.ts` ("vous"). TypeScript enforces that
   nl/fr have every key.
3. Run `npx vitest run src/tests/i18n`. `messageCatalogCoverage.test.ts`
   scans the sources and lists every user-facing string without a key or
   translation. Admin-only/operator strings go to
   `src/tests/i18n/messageExclusions.ts` with a reason instead.
