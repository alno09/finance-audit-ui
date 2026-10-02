# FinanceAudit

FinanceAudit is a Next.js UI for uploading invoice PDFs and reviewing extracted
financial data, line items, and audit findings.

If you want to understand the architecture, visit this repo:
[Finance Audit Engine](https://github.com/alno09/finance-audit-engine).

Since you are here, here's how you can run it.

## Run Locally

First, run the development server:

```bash
npm run dev
# or
yarn dev
# or
pnpm dev
# or
bun dev
```

Open [http://localhost:3001](http://localhost:3001) with your browser to see the result.

Set the API URL before auditing a document:

```bash
NEXT_PUBLIC_API_URL=http://localhost:3000 npm run dev
```

## Docker

Build and run the production container with Compose:

```bash
NEXT_PUBLIC_API_URL=http://localhost:3000 docker compose up --build
```

The UI will be available at [http://localhost:3001](http://localhost:3001), with the backend API at [http://localhost:3000](http://localhost:3000).
