import { describe, expect, it } from 'bun:test';
import type { ArgumentsHost } from '@nestjs/common';
import { InternalError } from '../../errors';
import { AppExceptionFilter } from './app-exception.filter';

describe('AppExceptionFilter', () => {
  it('falls back to the fastify request id for errors before interceptors run', () => {
    const { headers, host, reply, sent } = createHttpHost();

    new AppExceptionFilter().catch(new Error('boom'), host);

    expect(headers.get('x-request-id')).toBe('018f6ea2-7b34-7cc8-9a1b-2f1d7b9a0001');
    expect(sent).toEqual([
      {
        status: 500,
        body: {
          error: 'internal_server_error',
          message: '服务器内部错误',
          requestId: '018f6ea2-7b34-7cc8-9a1b-2f1d7b9a0001',
        },
      },
    ]);
    expect((reply.raw as { err?: Error }).err?.message).toBe('boom');
  });

  it('ignores aborted requests after the client connection is closed', () => {
    const { host, sent } = createHttpHost({
      raw: { destroyed: true, headersSent: false, writableEnded: false },
    });
    const err = new DOMException('request aborted', 'AbortError');

    new AppExceptionFilter().catch(err, host);

    expect(sent).toEqual([]);
  });

  it('summarizes internal error details before logging them', () => {
    const { host } = createHttpHost();
    const logs: Array<[Record<string, unknown>, string]> = [];
    const filter = new AppExceptionFilter();
    (filter as unknown as { logger: { error: (...args: unknown[]) => void } }).logger = {
      error: (fields: unknown, message: unknown) => {
        logs.push([fields as Record<string, unknown>, String(message)]);
      },
    };

    filter.catch(
      new InternalError('boom', {
        token: 'secret-token',
        meta: { target: ['email'], nested: { api_key: 'secret-api-key' } },
        long: 'x'.repeat(600),
      }),
      host
    );

    expect(logs).toHaveLength(1);
    expect(logs[0]?.[0].detail).toEqual({
      token: '[Redacted]',
      meta: { target: ['email'], nested: { api_key: '[Redacted]' } },
      long: `${'x'.repeat(512)}... [truncated 88 chars]`,
    });
  });
});

function createHttpHost(
  opts: {
    raw?: Record<string, unknown>;
    req?: Record<string, unknown>;
  } = {}
): {
  headers: Map<string, string>;
  host: ArgumentsHost;
  reply: {
    raw: Record<string, unknown>;
    header: (name: string, value: string) => unknown;
    status: (status: number) => { send: (body: unknown) => void };
  };
  sent: Array<{ status: number; body: unknown }>;
} {
  const sent: Array<{ status: number; body: unknown }> = [];
  const headers = new Map<string, string>();
  const reply = {
    raw: { writableEnded: false, headersSent: false, ...opts.raw },
    header: (name: string, value: string) => {
      headers.set(name, value);
      return reply;
    },
    status: (status: number) => ({
      send: (body: unknown) => sent.push({ status, body }),
    }),
  };
  const req = {
    id: '018f6ea2-7b34-7cc8-9a1b-2f1d7b9a0001',
    headers: {},
    method: 'GET',
    url: '/api/v2/probe',
    ...opts.req,
  };
  const host = {
    switchToHttp: () => ({
      getRequest: () => req,
      getResponse: () => reply,
    }),
  } as unknown as ArgumentsHost;
  return { headers, host, reply, sent };
}
