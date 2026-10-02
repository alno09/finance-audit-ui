'use client';

import {
  ChangeEvent,
  FormEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';

type AuditFinding = {
  id: string;
  type: string;
  severity: string;
  message: string;
  expectedValue: string | null;
  actualValue: string | null;
};

type LineItem = {
  id: string;
  description: string;
  quantity: string | null;
  unitPrice: string | null;
  total: string | null;
};

type DocumentResult = {
  id: string;
  filename: string;
  status: string;
  errorMessage: string | null;

  invoice: {
    invoiceNumber: string | null;
    vendorName: string | null;
    customerName: string | null;
    currency: string;
    subtotal: string | null;
    tax: string | null;
    total: string | null;

    lineItems: LineItem[];

    audit: {
      status: string;
      findings: AuditFinding[];
    } | null;
  } | null;
};

type UploadQuota = {
  limit: number;
  remaining: number;
  resetAtMs: number | null;
};

type UploadErrorBody = {
  message?: unknown;
  retryAfter?: unknown;
};

const TERMINAL_STATUSES = [
  'APPROVED',
  'NEEDS_REVIEW',
  'EXTRACTION_FAILED',
  'AUDIT_FAILED',
];

const STATUS_STYLES: Record<string, string> = {
  APPROVED: 'border-emerald-200 bg-emerald-50 text-emerald-700',
  NEEDS_REVIEW: 'border-amber-200 bg-amber-50 text-amber-800',
  EXTRACTION_FAILED: 'border-rose-200 bg-rose-50 text-rose-700',
  AUDIT_FAILED: 'border-rose-200 bg-rose-50 text-rose-700',
  PROCESSING: 'border-sky-200 bg-sky-50 text-sky-700',
  UPLOADED: 'border-sky-200 bg-sky-50 text-sky-700',
};

const SEVERITY_STYLES: Record<string, string> = {
  HIGH: 'border-rose-200 bg-rose-50 text-rose-700',
  MEDIUM: 'border-amber-200 bg-amber-50 text-amber-800',
  LOW: 'border-slate-200 bg-slate-50 text-slate-600',
};

export default function Home() {
  const [file, setFile] = useState<File | null>(null);
  const [documentId, setDocumentId] = useState<string | null>(null);
  const [result, setResult] = useState<DocumentResult | null>(null);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [quota, setQuota] = useState<UploadQuota | null>(null);
  const [quotaLockUntilMs, setQuotaLockUntilMs] = useState<number | null>(null);
  const [quotaExhausted, setQuotaExhausted] = useState(false);
  const uploadInFlightRef = useRef(false);

  const apiUrl = process.env.NEXT_PUBLIC_API_URL;
  const canUpload = Boolean(file && apiUrl && !uploading && !quotaExhausted);
  const isProcessing =
    Boolean(result) && !TERMINAL_STATUSES.includes(result?.status ?? '');

  const clearExpiredQuotaLock = useCallback(() => {
    const resetAtMs = quotaLockUntilMs;

    if (resetAtMs === null || resetAtMs > Date.now()) {
      return;
    }

    setQuotaLockUntilMs(null);
    setQuotaExhausted(false);
    setQuota((currentQuota) =>
      currentQuota?.resetAtMs === resetAtMs ? null : currentQuota,
    );
  }, [quotaLockUntilMs]);

  function handleFileChange(event: ChangeEvent<HTMLInputElement>) {
    setFile(event.target.files?.[0] ?? null);
    setDocumentId(null);
    setResult(null);
    setError(null);
  }

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();

    if (!file) {
      return;
    }

    if (uploadInFlightRef.current || quotaExhausted) {
      return;
    }

    if (!apiUrl) {
      setError('NEXT_PUBLIC_API_URL is not configured.');
      return;
    }

    uploadInFlightRef.current = true;
    setUploading(true);
    setError(null);
    setResult(null);

    try {
      const formData = new FormData();
      formData.append('file', file);

      const response = await fetch(`${apiUrl}/documents`, {
        method: 'POST',
        body: formData,
      });

      const nextQuota = readUploadQuota(response.headers);
      if (nextQuota) {
        setQuota(nextQuota);

        if (
          nextQuota.remaining === 0 &&
          nextQuota.resetAtMs &&
          nextQuota.resetAtMs > Date.now()
        ) {
          setQuotaLockUntilMs(nextQuota.resetAtMs);
          setQuotaExhausted(true);
        } else {
          setQuotaLockUntilMs(null);
          setQuotaExhausted(false);
        }
      }

      if (!response.ok) {
        const data = await readUploadErrorBody(response);

        if (response.status === 429) {
          const resetAtMs =
            nextQuota?.resetAtMs ??
            readResetFromRetryAfter(response.headers) ??
            readResetFromRetryAfterBody(data);

          if (resetAtMs && resetAtMs > Date.now()) {
            setQuotaLockUntilMs(resetAtMs);
            setQuotaExhausted(true);
          }

          setError(formatQuotaError(resetAtMs));
          return;
        }

        if (response.status === 503) {
          setError('Uploads are temporarily unavailable. Please try again later.');
          return;
        }

        throw new Error(readErrorMessage(data) ?? 'Upload failed');
      }

      const document = await response.json();
      setDocumentId(document.id);
    } catch (error) {
      setError(error instanceof Error ? error.message : 'Upload failed');
    } finally {
      uploadInFlightRef.current = false;
      setUploading(false);
    }
  }

  useEffect(() => {
    if (!quotaLockUntilMs) {
      return;
    }

    const delayMs = Math.max(0, quotaLockUntilMs - Date.now());
    const timeoutId = setTimeout(clearExpiredQuotaLock, delayMs);
    const handleFocus = () => clearExpiredQuotaLock();

    window.addEventListener('focus', handleFocus);

    return () => {
      clearTimeout(timeoutId);
      window.removeEventListener('focus', handleFocus);
    };
  }, [clearExpiredQuotaLock, quotaLockUntilMs]);

  useEffect(() => {
    if (!documentId || !apiUrl) {
      return;
    }

    let active = true;
    let timeoutId: ReturnType<typeof setTimeout>;

    const poll = async () => {
      try {
        const response = await fetch(`${apiUrl}/documents/${documentId}`);

        if (!response.ok) {
          throw new Error('Failed to load document');
        }

        const data: DocumentResult = await response.json();

        if (!active) {
          return;
        }

        setResult(data);

        if (!TERMINAL_STATUSES.includes(data.status)) {
          timeoutId = setTimeout(poll, 1000);
        }
      } catch (error) {
        if (!active) {
          return;
        }

        setError(
          error instanceof Error ? error.message : 'Failed to load result',
        );
      }
    };

    void poll();

    return () => {
      active = false;
      clearTimeout(timeoutId);
    };
  }, [documentId, apiUrl]);

  return (
    <main className="min-h-screen bg-[#f7f4ef] text-slate-950">
      <div className="mx-auto flex min-h-screen w-full max-w-7xl flex-col gap-8 px-4 py-6 sm:px-6 lg:px-8">
        <header className="grid gap-5 border-b border-slate-200 pb-6 lg:grid-cols-[1fr_auto] lg:items-end">
          <div>
            <p className="text-sm font-semibold uppercase tracking-[0.18em] text-teal-700">
              FinanceAudit
            </p>
            <h1 className="mt-3 max-w-3xl text-4xl font-semibold leading-tight text-slate-950 sm:text-5xl">
              Review invoice totals with less guesswork.
            </h1>
            <p className="mt-4 max-w-2xl text-base leading-7 text-slate-600">
              Upload a PDF invoice, then review extracted fields, totals, line
              items, and audit findings in one calm workspace.
            </p>
          </div>

          <div className="grid grid-cols-3 gap-2 rounded-lg border border-slate-200 bg-white p-2 shadow-sm">
            <Metric label="Files" value={result ? '1' : '0'} />
            <Metric label="Issues" value={getIssueCount(result)} />
            <Metric label="Status" value={result ? formatStatus(result.status) : 'Ready'} />
          </div>
        </header>

        <div className="grid flex-1 gap-6 lg:grid-cols-[380px_1fr]">
          <aside className="space-y-4">
            <section className="rounded-lg border border-slate-200 bg-white p-5 shadow-sm">
              <div className="flex items-start justify-between gap-4">
                <div>
                  <h2 className="text-lg font-semibold">New audit</h2>
                  <p className="mt-1 text-sm leading-6 text-slate-500">
                    PDF invoices only
                  </p>
                </div>
                <span className="rounded-full border border-teal-200 bg-teal-50 px-3 py-1 text-xs font-semibold text-teal-700">
                  AI + rules
                </span>
              </div>

              <form onSubmit={handleSubmit} className="mt-5 space-y-4">
                <label className="flex cursor-pointer flex-col items-center justify-center rounded-lg border border-dashed border-slate-300 bg-slate-50 px-4 py-8 text-center transition hover:border-teal-500 hover:bg-teal-50/60">
                  <span className="text-sm font-semibold text-slate-800">
                    {file ? file.name : 'Choose invoice PDF'}
                  </span>
                  <span className="mt-1 text-xs text-slate-500">
                    {file ? formatFileSize(file.size) : 'No file selected'}
                  </span>
                  <input
                    type="file"
                    accept="application/pdf"
                    onChange={handleFileChange}
                    className="sr-only"
                  />
                </label>

                {quota && (
                  <div className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-sm font-medium text-slate-700">
                    {quota.remaining} of {quota.limit} upload attempts remaining today
                  </div>
                )}

                {quotaExhausted && (
                  <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm leading-6 text-amber-900">
                    <p className="font-semibold">
                      Daily upload limit reached for your network.
                    </p>
                    {quotaLockUntilMs && (
                      <p className="mt-1">
                        Resets {formatResetTime(quotaLockUntilMs)}.
                      </p>
                    )}
                  </div>
                )}

                <button
                  type="submit"
                  disabled={!canUpload}
                  className="flex h-11 w-full items-center justify-center rounded-lg bg-slate-950 px-4 text-sm font-semibold text-white transition hover:bg-teal-800 disabled:cursor-not-allowed disabled:bg-slate-300 disabled:text-slate-500"
                >
                  {uploading ? 'Uploading...' : 'Run audit'}
                </button>
              </form>

              {!apiUrl && (
                <div className="mt-4 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm leading-6 text-amber-900">
                  Set NEXT_PUBLIC_API_URL before running an audit.
                </div>
              )}
            </section>

            <section className="rounded-lg border border-slate-200 bg-white p-5 shadow-sm">
              <h2 className="text-lg font-semibold">Document</h2>
              {result ? (
                <div className="mt-4 space-y-4">
                  <div className="min-w-0">
                    <p className="truncate font-medium text-slate-900">
                      {result.filename}
                    </p>
                    <p className="mt-1 text-xs text-slate-500">
                      ID {result.id}
                    </p>
                  </div>
                  <StatusBadge status={result.status} />
                  {isProcessing && (
                    <div className="rounded-lg bg-sky-50 p-3 text-sm text-sky-800">
                      Processing now
                    </div>
                  )}
                  {result.errorMessage && (
                    <div className="rounded-lg bg-rose-50 p-3 text-sm text-rose-700">
                      {result.errorMessage}
                    </div>
                  )}
                </div>
              ) : (
                <EmptyState title="No invoice yet" body="Your audit result will appear here." />
              )}
            </section>
          </aside>

          <section className="min-h-[520px] rounded-lg border border-slate-200 bg-white shadow-sm">
            {error && (
              <div className="border-b border-rose-100 bg-rose-50 px-5 py-4 text-sm font-medium text-rose-700">
                {error}
              </div>
            )}

            {result?.invoice ? (
              <InvoiceResult result={result} />
            ) : (
              <div className="flex min-h-[520px] items-center justify-center px-6">
                <EmptyState
                  title={uploading ? 'Uploading invoice' : 'Ready when you are'}
                  body={
                    uploading
                      ? 'FinanceAudit is sending the PDF to the audit service.'
                      : 'Select an invoice PDF to start the review.'
                  }
                />
              </div>
            )}
          </section>
        </div>
      </div>
    </main>
  );
}

function InvoiceResult({ result }: { result: DocumentResult }) {
  const invoice = result.invoice!;
  const findings = invoice.audit?.findings ?? [];
  const totals = useMemo(
    () => [
      ['Subtotal', invoice.subtotal],
      ['Tax', invoice.tax],
      ['Total', invoice.total],
    ],
    [invoice.subtotal, invoice.tax, invoice.total],
  );

  return (
    <div className="divide-y divide-slate-200">
      <section className="p-5 sm:p-6">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <p className="text-sm font-semibold uppercase tracking-[0.16em] text-teal-700">
              Invoice
            </p>
            <h2 className="mt-2 text-2xl font-semibold text-slate-950">
              {invoice.vendorName ?? 'Unknown vendor'}
            </h2>
            <p className="mt-1 text-sm text-slate-500">
              {invoice.invoiceNumber ?? 'No invoice number'}
            </p>
          </div>
          {invoice.audit && <StatusBadge status={invoice.audit.status} />}
        </div>

        <div className="mt-6 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <Field label="Customer" value={invoice.customerName} />
          <Field label="Currency" value={invoice.currency} />
          <Field label="Line items" value={String(invoice.lineItems.length)} />
          <Field label="Findings" value={String(findings.length)} />
        </div>

        <div className="mt-5 grid gap-3 sm:grid-cols-3">
          {totals.map(([label, value]) => (
            <div key={label} className="rounded-lg border border-slate-200 p-4">
              <p className="text-sm text-slate-500">{label}</p>
              <p className="mt-2 text-2xl font-semibold text-slate-950">
                {value ?? '-'}
              </p>
            </div>
          ))}
        </div>
      </section>

      <section className="p-5 sm:p-6">
        <div className="flex items-center justify-between gap-4">
          <h2 className="text-lg font-semibold">Line items</h2>
          <span className="text-sm text-slate-500">
            {invoice.lineItems.length} rows
          </span>
        </div>

        {invoice.lineItems.length > 0 ? (
          <div className="mt-4 overflow-x-auto">
            <table className="w-full min-w-[640px] border-separate border-spacing-0 text-left text-sm">
              <thead>
                <tr className="text-slate-500">
                  <th className="border-b border-slate-200 py-3 pr-4 font-medium">
                    Description
                  </th>
                  <th className="border-b border-slate-200 px-4 py-3 font-medium">
                    Qty
                  </th>
                  <th className="border-b border-slate-200 px-4 py-3 font-medium">
                    Unit price
                  </th>
                  <th className="border-b border-slate-200 py-3 pl-4 text-right font-medium">
                    Total
                  </th>
                </tr>
              </thead>
              <tbody>
                {invoice.lineItems.map((item) => (
                  <tr key={item.id} className="align-top">
                    <td className="border-b border-slate-100 py-4 pr-4 font-medium text-slate-900">
                      {item.description}
                    </td>
                    <td className="border-b border-slate-100 px-4 py-4 text-slate-600">
                      {item.quantity ?? '-'}
                    </td>
                    <td className="border-b border-slate-100 px-4 py-4 text-slate-600">
                      {item.unitPrice ?? '-'}
                    </td>
                    <td className="border-b border-slate-100 py-4 pl-4 text-right font-medium text-slate-900">
                      {item.total ?? '-'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <EmptyState title="No line items found" body="The invoice was extracted without row-level items." />
        )}
      </section>

      <section className="p-5 sm:p-6">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <h2 className="text-lg font-semibold">Audit findings</h2>
          {invoice.audit && <StatusBadge status={invoice.audit.status} />}
        </div>

        {findings.length === 0 ? (
          <div className="mt-4 rounded-lg border border-emerald-200 bg-emerald-50 p-4 text-sm font-medium text-emerald-700">
            No findings. Totals and rules look good.
          </div>
        ) : (
          <div className="mt-4 grid gap-3">
            {findings.map((finding) => (
              <article
                key={finding.id}
                className="rounded-lg border border-slate-200 p-4"
              >
                <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
                  <div>
                    <h3 className="font-semibold text-slate-950">
                      {formatStatus(finding.type)}
                    </h3>
                    <p className="mt-2 text-sm leading-6 text-slate-600">
                      {finding.message}
                    </p>
                  </div>
                  <SeverityBadge severity={finding.severity} />
                </div>

                {(finding.expectedValue || finding.actualValue) && (
                  <div className="mt-4 grid gap-3 rounded-lg bg-slate-50 p-3 text-sm sm:grid-cols-2">
                    <Field label="Expected" value={finding.expectedValue} />
                    <Field label="Actual" value={finding.actualValue} />
                  </div>
                )}
              </article>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  return (
    <span
      className={`inline-flex w-fit items-center rounded-full border px-3 py-1 text-xs font-semibold ${STATUS_STYLES[status] ?? 'border-slate-200 bg-slate-50 text-slate-600'}`}
    >
      {formatStatus(status)}
    </span>
  );
}

function SeverityBadge({ severity }: { severity: string }) {
  return (
    <span
      className={`inline-flex w-fit items-center rounded-full border px-3 py-1 text-xs font-semibold ${SEVERITY_STYLES[severity] ?? 'border-slate-200 bg-slate-50 text-slate-600'}`}
    >
      {formatStatus(severity)}
    </span>
  );
}

function Field({
  label,
  value,
}: {
  label: string;
  value: string | null | undefined;
}) {
  return (
    <div className="min-w-0">
      <p className="text-xs font-medium uppercase tracking-[0.12em] text-slate-500">
        {label}
      </p>
      <p className="mt-1 break-words font-medium text-slate-950">
        {value ?? '-'}
      </p>
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0 rounded-md px-3 py-2">
      <p className="text-xs font-medium text-slate-500">{label}</p>
      <p className="mt-1 truncate text-sm font-semibold text-slate-950">
        {value}
      </p>
    </div>
  );
}

function EmptyState({ title, body }: { title: string; body: string }) {
  return (
    <div className="mx-auto max-w-sm text-center">
      <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-teal-50 text-lg font-semibold text-teal-700">
        FA
      </div>
      <h2 className="mt-4 text-lg font-semibold text-slate-950">{title}</h2>
      <p className="mt-2 text-sm leading-6 text-slate-500">{body}</p>
    </div>
  );
}

function getIssueCount(result: DocumentResult | null) {
  return String(result?.invoice?.audit?.findings.length ?? 0);
}

function formatStatus(status: string) {
  return status
    .toLowerCase()
    .split('_')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

function formatFileSize(size: number) {
  if (size < 1024 * 1024) {
    return `${Math.max(1, Math.round(size / 1024))} KB`;
  }

  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

function readUploadQuota(headers: Headers): UploadQuota | null {
  const limit = readNonNegativeIntegerHeader(headers, 'X-Upload-Limit');
  const remaining = readNonNegativeIntegerHeader(headers, 'X-Upload-Remaining');
  const resetAtSeconds = readNonNegativeIntegerHeader(headers, 'X-Upload-Reset');

  if (limit === null || remaining === null) {
    return null;
  }

  return {
    limit,
    remaining,
    resetAtMs: resetAtSeconds === null ? null : resetAtSeconds * 1000,
  };
}

function readNonNegativeIntegerHeader(headers: Headers, name: string) {
  return readNonNegativeInteger(headers.get(name));
}

function readNonNegativeInteger(value: unknown) {
  if (typeof value !== 'string' && typeof value !== 'number') {
    return null;
  }

  const parsed = Number(value);

  if (!Number.isInteger(parsed) || parsed < 0) {
    return null;
  }

  return parsed;
}

function readResetFromRetryAfter(headers: Headers) {
  const retryAfterSeconds = readNonNegativeIntegerHeader(headers, 'Retry-After');

  if (retryAfterSeconds === null) {
    return null;
  }

  return Date.now() + retryAfterSeconds * 1000;
}

function readResetFromRetryAfterBody(body: UploadErrorBody | null) {
  const retryAfterSeconds = readNonNegativeInteger(body?.retryAfter);

  if (retryAfterSeconds === null) {
    return null;
  }

  return Date.now() + retryAfterSeconds * 1000;
}

async function readUploadErrorBody(response: Response) {
  try {
    return (await response.json()) as UploadErrorBody;
  } catch {
    return null;
  }
}

function readErrorMessage(body: UploadErrorBody | null) {
  return typeof body?.message === 'string' ? body.message : null;
}

function formatQuotaError(resetAtMs: number | null) {
  if (!resetAtMs) {
    return 'Daily upload limit reached for your network.';
  }

  return `Daily upload limit reached for your network. Resets ${formatResetTime(resetAtMs)}.`;
}

function formatResetTime(resetAtMs: number) {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(resetAtMs));
}
