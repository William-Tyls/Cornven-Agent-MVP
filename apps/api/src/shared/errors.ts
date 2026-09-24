import type { ErrorRequestHandler, RequestHandler } from 'express';
import { ZodError } from 'zod';
import { ReportError } from './report-errors.js';

import { getRequestId } from './request-id.js';

export class RequestValidationError extends Error {
  constructor(
    message: string,
    readonly field = 'request',
  ) {
    super(message);
    this.name = 'RequestValidationError';
  }
}

export type CsvRowValidationDetail = {
  lineNumber: number;
  field: string;
  code: string;
  reason: string;
};

export class CsvRowsValidationError extends Error {
  constructor(readonly details: CsvRowValidationDetail[]) {
    super('The CSV file contains invalid rows.');
    this.name = 'CsvRowsValidationError';
  }
}

export const notFoundHandler: RequestHandler = (request, response) => {
  response.status(404).json({
    error: {
      code: 'ROUTE_NOT_FOUND',
      message: 'The requested API route does not exist.',
      requestId: getRequestId(request),
      details: [],
    },
  });
};

export const errorHandler: ErrorRequestHandler = (error, request, response, _next) => {
  const requestId = getRequestId(request);

  if (error instanceof ReportError) {
    if (error.code.startsWith('RAG_')) console.warn({ requestId, code: error.code });
    response
      .status(error.status)
      .json({ error: { code: error.code, message: error.message, requestId, details: [] } });
    return;
  }

  if (error instanceof ZodError) {
    response.status(400).json({
      error: {
        code: 'VALIDATION_FAILED',
        message: 'The request did not match the public contract.',
        requestId,
        details: error.issues.map((issue) => ({
          field: issue.path.join('.'),
          reason: issue.message,
        })),
      },
    });
    return;
  }

  if (error instanceof CsvRowsValidationError) {
    response.status(400).json({
      error: {
        code: 'VALIDATION_FAILED',
        message: error.message,
        requestId,
        details: error.details,
      },
    });
    return;
  }

  if (error instanceof RequestValidationError) {
    response.status(400).json({
      error: {
        code: 'VALIDATION_FAILED',
        message: 'The request failed business validation.',
        requestId,
        details: [{ field: error.field, reason: error.message }],
      },
    });
    return;
  }

  console.error({ requestId, error });
  response.status(500).json({
    error: {
      code: 'INTERNAL_ERROR',
      message: 'An unexpected error occurred.',
      requestId,
      details: [],
    },
  });
};
