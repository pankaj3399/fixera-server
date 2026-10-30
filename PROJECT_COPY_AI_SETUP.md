# Project title and FAQ generation

Set these variables in the **server runtime**, using your environment's secret manager:

```dotenv
OPENAI_API_KEY=
OPENAI_MODEL=gpt-5.4-mini
```

Supply your OpenAI API key for `OPENAI_API_KEY`. `OPENAI_MODEL` is optional; the default
is `gpt-5.4-mini`. Keep the key out of client environment variables, source control,
logs, and browser code. Restart the backend after changing its runtime configuration.

Approved professionals use the wizard's generation buttons to request three title
suggestions or eight FAQ pairs. The authenticated endpoint is
`POST /api/projects/generate-copy`. Editing an existing project also checks ownership.
Requests send only allowlisted project facts and the selected English, Dutch, or French
locale. Images, credentials, profiles, contact fields, and customer answers are omitted.
Per-unit duration bases and RFQ duration ranges are included; the prompt does not assume
a booked quantity or turn per-unit timing into a total job estimate.

Suggestions stay editable. Applying a title is explicit. FAQ generation merges into the
latest authored entries, preserving edits made during the request. No generation call
publishes or saves the project. Calls have a 20-second timeout, bounded context/output,
a per-professional concurrency guard, and a limit of 12 calls per IP per 10 minutes.

Without the server key, the endpoint returns `AI_NOT_CONFIGURED` and the wizard identifies
its local suggestion fallback. Other errors are shown as generation failures rather
than silently replacing provider output with local templates.

Development verification mocks the provider and makes no live, billable calls:

```sh
./node_modules/.bin/vitest run src/tests/utils/projectCopyGeneration.test.ts src/tests/routes/projectCopyRoute.test.ts
```

Provider access, billing, and real output quality require separate verification with the
configured OpenAI account. This change does not deploy secrets or enable automatic calls.
