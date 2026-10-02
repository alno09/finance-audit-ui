import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import Home from './page';

const apiUrl = 'https://api.example.test';

beforeEach(() => {
  process.env.NEXT_PUBLIC_API_URL = apiUrl;
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('Home upload quota', () => {
  test('successful final attempt with remaining=0 still processes normally', async () => {
    const resetAtSeconds = 4_102_444_800;
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse(
          { id: 'doc-1' },
          {
            headers: {
              'X-Upload-Limit': '2',
              'X-Upload-Remaining': '0',
              'X-Upload-Reset': String(resetAtSeconds),
            },
          },
        ),
      )
      .mockResolvedValueOnce(jsonResponse(documentResult()));
    vi.stubGlobal('fetch', fetchMock);

    render(<Home />);
    selectInvoice();
    fireEvent.click(screen.getByRole('button', { name: 'Run audit' }));

    expect(
      await screen.findByText('0 of 2 upload attempts remaining today'),
    ).toBeTruthy();
    expect(
      screen.getByText('Daily upload limit reached for your network.'),
    ).toBeTruthy();
    expect(await screen.findByText('Acme Supplies')).toBeTruthy();

    expect(fetchMock).toHaveBeenCalledWith(`${apiUrl}/documents`, {
      method: 'POST',
      body: expect.any(FormData),
    });
    expect(fetchMock).toHaveBeenCalledWith(`${apiUrl}/documents/doc-1`);
  });

  test('HTTP 429 displays the quota error and reset time', async () => {
    const resetAtSeconds = 4_102_444_800;
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValueOnce(
        jsonResponse(
          {
            statusCode: 429,
            message: 'Daily upload limit reached (2 attempts per IP).',
            retryAfter: 12345,
          },
          {
            status: 429,
            headers: {
              'X-Upload-Limit': '2',
              'X-Upload-Remaining': '0',
              'X-Upload-Reset': String(resetAtSeconds),
            },
          },
        ),
      ),
    );

    render(<Home />);
    selectInvoice();
    fireEvent.click(screen.getByRole('button', { name: 'Run audit' }));

    expect(
      await screen.findAllByText(/Daily upload limit reached for your network/),
    ).toHaveLength(2);
    expect(screen.getAllByText(/Resets/)[0].textContent).toContain('2100');
    expect(runAuditButton().disabled).toBe(true);
  });

  test('HTTP 503 displays temporary unavailability', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValueOnce(
        jsonResponse(
          { statusCode: 503, message: 'Service unavailable' },
          { status: 503 },
        ),
      ),
    );

    render(<Home />);
    selectInvoice();
    fireEvent.click(screen.getByRole('button', { name: 'Run audit' }));

    expect(
      await screen.findByText(
        'Uploads are temporarily unavailable. Please try again later.',
      ),
    ).toBeTruthy();
    expect(runAuditButton().disabled).toBe(false);
  });

  test('missing or invalid quota headers do not falsely exhaust quota', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValueOnce(
        jsonResponse(
          { message: 'Invalid PDF' },
          {
            status: 400,
            headers: {
              'X-Upload-Remaining': '0',
              'X-Upload-Reset': 'not-a-number',
            },
          },
        ),
      ),
    );

    render(<Home />);
    selectInvoice();
    fireEvent.click(screen.getByRole('button', { name: 'Run audit' }));

    expect(await screen.findByText('Invalid PDF')).toBeTruthy();
    expect(screen.queryByText(/upload attempts remaining today/)).toBeNull();
    expect(screen.getByText('invoice.pdf')).toBeTruthy();
    expect(runAuditButton().disabled).toBe(false);
  });

  test('reset expiry re-enables submissions', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValueOnce(
        jsonResponse(
          { statusCode: 429, message: 'Daily upload limit reached.' },
          {
            status: 429,
            headers: {
              'Retry-After': '1',
            },
          },
        ),
      ),
    );

    render(<Home />);
    selectInvoice();
    fireEvent.click(screen.getByRole('button', { name: 'Run audit' }));

    await screen.findByText('Daily upload limit reached for your network.');
    expect(runAuditButton().disabled).toBe(true);

    await act(async () => {
      await new Promise((resolve) => {
        setTimeout(resolve, 1100);
      });
    });
    fireEvent.focus(window);

    await waitFor(() => {
      expect(runAuditButton().disabled).toBe(false);
    });
  });

  test('repeated clicks do not send duplicate upload requests', async () => {
    let resolveUpload: (response: Response) => void = () => {};
    const uploadPromise = new Promise<Response>((resolve) => {
      resolveUpload = resolve;
    });
    const fetchMock = vi.fn().mockReturnValue(uploadPromise);
    vi.stubGlobal('fetch', fetchMock);

    render(<Home />);
    selectInvoice();

    const button = screen.getByRole('button', { name: 'Run audit' });
    fireEvent.click(button);
    fireEvent.click(button);

    expect(fetchMock).toHaveBeenCalledTimes(1);

    resolveUpload(jsonResponse({ id: 'doc-1' }));
    await waitFor(() => {
      expect(runAuditButton().disabled).toBe(false);
    });
  });
});

function selectInvoice() {
  const input = document.querySelector('input[type="file"]');

  if (!(input instanceof HTMLInputElement)) {
    throw new Error('File input not found');
  }

  fireEvent.change(input, {
    target: {
      files: [
        new File(['invoice'], 'invoice.pdf', {
          type: 'application/pdf',
        }),
      ],
    },
  });
}

function runAuditButton() {
  const button = screen.getByRole('button', { name: 'Run audit' });

  if (!(button instanceof HTMLButtonElement)) {
    throw new Error('Run audit button not found');
  }

  return button;
}

function jsonResponse(
  body: unknown,
  init: ResponseInit & { headers?: Record<string, string> } = {},
) {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: {
      'Content-Type': 'application/json',
      ...init.headers,
    },
  });
}

function documentResult() {
  return {
    id: 'doc-1',
    filename: 'invoice.pdf',
    status: 'APPROVED',
    errorMessage: null,
    invoice: {
      invoiceNumber: 'INV-1',
      vendorName: 'Acme Supplies',
      customerName: 'FinanceAudit',
      currency: 'USD',
      subtotal: '10.00',
      tax: '1.00',
      total: '11.00',
      lineItems: [],
      audit: {
        status: 'APPROVED',
        findings: [],
      },
    },
  };
}
