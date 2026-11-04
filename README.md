# ez-finance

> **This is an anonymized public copy.** The real project is a private repository that I use day to day and run as
> a closed pilot. This copy is a snapshot as of **2026-11-04**. It has no git history, and personal information has
> been removed: real names, bank account and card numbers, project IDs, production URLs, internal business documents
> and the test fixtures that came from real bank statements (replaced with fictional data in the same format). The
> code, tests, database migrations and design notes are otherwise the same as the original.
>
> *Esta es una copia pública anonimizada del repositorio privado, a la fecha indicada, sin historial ni datos
> personales.*

Personal finance app with **automatic expense capture**. The bank already sends a notice for every movement (email,
phone notification). ez-finance collects those notices, has Claude extract the transaction, validates it, and leaves
it in an inbox where you only confirm, correct or discard. No bank credentials and no manual entry.

The product, the code and the docs are in Spanish (it is built for Ecuador: USD, Banco Pichincha, PacifiCard).

## How it works

```
Gmail (Apps Script) / Android (MacroDroid) / iOS (Shortcuts)
  → POST /api/ingest (per-user bearer token) → ingest_events (raw text, deduplicated by hash)
  → /api/ingest triggers a GitHub Actions workflow
  → parse-pending: claude -p with a JSON schema (+ the user's accounts and known merchants) → decide() → 'pending'
  → web push to the user's devices: "N new in your inbox"
  → /inbox: confirm, correct or discard
  (bank statements: parsed without the LLM → reconcile.ts adjusts the balance at the cutoff and
   cross-checks every credit-card line against what was recorded)
```

## Stack

- **Astro 7** (SSR on Vercel), Astro Actions with plain HTML forms that work without JavaScript, Tailwind. No React.
- **Supabase** (Postgres + Auth): row-level security on every table, composite foreign keys `(id, user_id)` so the
  database itself refuses to mix users' data, balances computed by a view (never stored).
- **Claude Code headless** in GitHub Actions as the parser (Haiku, structured output, no tools).
- Web Push (VAPID, Declarative Web Push), a hand-written WebGL background (no three.js), Vitest.

## Things worth looking at

- **LLM output is treated as untrusted.** `decide()` in [`src/lib/parse.ts`](src/lib/parse.ts) checks amounts, dates,
  references and account/category ids against the user's own data. Anything doubtful goes to review and nothing is
  confirmed without the user. A transfer only counts as internal if the notice itself names both accounts.
- **Prompt changes need an eval.** Few-shot examples taken from real notices (anonymized) were measured before and
  after on 50 real notices × 3 runs: correct merchant 70 → 100 %, consistency 54 → 98 %, no regression.
- **Layered duplicate detection.** The same movement arrives by email and by push: hash → bank reference → manual
  payment → email/push pairing → same amount and type (the user decides).
- **Reconciliation with the bank.** Statements are parsed deterministically and validated (previous + credits −
  debits = current). Small differences are adjusted automatically; large ones go back to the inbox.
- **Shared account** between two users, where each contributes the same % of their monthly income, built on
  additive RLS policies.
- **Performance measured on real hardware**, not guessed (GPU 76 % → 43 % on an integrated-GPU laptop at 120 Hz).

The reasons behind each choice are in **[`docs/decisiones.md`](docs/decisiones.md)** (technical decision log).

## Repository map

| Path | What it is |
|---|---|
| `src/lib/parse.ts` (+ test) | Prompt, JSON schema and `decide()`. Pure, no framework deps |
| `src/lib/statement.ts`, `card.ts`, `split.ts` | Statement parsing, card cycles, shared-account contributions |
| `scripts/parse-pending.ts`, `reconcile.ts` | What the GitHub Action runs |
| `src/pages/api/ingest.ts` | Capture endpoint |
| `src/actions/index.ts` | All mutations |
| `supabase/migrations/` | Schema, RLS, views and functions |
| `clients/gmail.gs`, `docs/captura.md` | Capture clients and setup |
| `CLAUDE.md`, `.claude/rules/` | Project context and area rules (developed with Claude Code) |

## Running it

It needs your own Supabase project, a Vercel deployment and a Claude Code token for the parser. See `.env.example`
and `docs/captura.md`. The scheduled run of the parser is disabled in this copy.

```bash
npm install
npm test         # vitest
npm run check    # astro check
npm run dev      # localhost:4321 (needs .env)
```

Author: [Alejololer](https://github.com/Alejololer) · [alejololer.is-a.dev](https://alejololer.is-a.dev)
