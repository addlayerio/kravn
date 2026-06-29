import type { FastifyReply } from 'fastify';
import { z, ZodError, type ZodTypeAny } from 'zod';

export function sendError(reply: FastifyReply, status: number, code: string, message: string, details?: unknown): void {
  reply.code(status).send({ error: { code, message, details } });
}

/**
 * Validate `data` against `schema`. On failure, sends a 400 and returns undefined
 * (callers should `return` when the result is undefined). Returns the parsed OUTPUT
 * type so zod defaults are applied.
 */
export function parse<S extends ZodTypeAny>(reply: FastifyReply, schema: S, data: unknown): z.output<S> | undefined {
  const res = schema.safeParse(data);
  if (!res.success) {
    sendError(reply, 400, 'validation', 'Request validation failed.', flattenZod(res.error));
    return undefined;
  }
  return res.data;
}

function flattenZod(err: ZodError): Array<{ path: string; message: string }> {
  return err.issues.map((i) => ({ path: i.path.join('.'), message: i.message }));
}
