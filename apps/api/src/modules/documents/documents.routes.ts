import { Router, type Request, type Response } from 'express';

import {
  DocumentPermissionTagSchema,
  DocumentSearchInputSchema,
  type DocumentPermissionTag,
} from '@cornven/contracts';

import { RagError } from './rag-errors.js';
import { DocumentsService } from './documents.service.js';
import { PostgresDocumentIndex } from './postgres-document-index.js';
import { getRequestId } from '../../shared/request-id.js';

const ServerPermissionTagsSchema = DocumentPermissionTagSchema.array().min(1);

export type DocumentPermissionResolver = (request: Request, response: Response) => unknown;

function permissionsFromTrustedServerContext(_request: Request, response: Response): unknown {
  return response.locals.documentPermissionTags;
}

function authorisedPermissionTags(
  request: Request,
  response: Response,
  resolvePermissionTags: DocumentPermissionResolver,
): DocumentPermissionTag[] | undefined {
  const parsed = ServerPermissionTagsSchema.safeParse(resolvePermissionTags(request, response));
  if (parsed.success) {
    return parsed.data;
  }

  response.status(403).json({
    error: {
      code: 'FORBIDDEN',
      message: 'The authenticated actor is not allowed to access internal documents.',
      requestId: getRequestId(request),
      details: [],
    },
  });
  return undefined;
}

export function createDocumentsService(environment: NodeJS.ProcessEnv = process.env) {
  const backend = environment.RAG_STORAGE_BACKEND ?? 'memory';
  if (backend === 'memory') {
    return new DocumentsService({ environment });
  }
  if (backend === 'postgres') {
    return new DocumentsService({ environment, persistentIndex: new PostgresDocumentIndex() });
  }
  throw new RagError('RAG_CONFIG_INVALID');
}

// A broken RAG configuration must not prevent health or financial tools from starting.
export function lazyDocumentsService(
  environment: NodeJS.ProcessEnv = process.env,
): Pick<DocumentsService, 'search' | 'status'> {
  let service: DocumentsService | undefined;
  const get = () => (service ??= createDocumentsService(environment));
  return {
    search: async (input, context) => get().search(input, context),
    status: async (context) => {
      try {
        return await get().status(context);
      } catch {
        return {
          status: 'not_configured',
          indexedDocuments: 0,
          indexedChunks: 0,
          embeddingProvider: 'unavailable',
          message: new RagError('RAG_CONFIG_INVALID').message,
        };
      }
    },
  };
}
export const documentsService = lazyDocumentsService();

export function createDocumentsRouter(
  service: Pick<DocumentsService, 'search' | 'status'> = documentsService,
  resolvePermissionTags: DocumentPermissionResolver = permissionsFromTrustedServerContext,
) {
  const router = Router();

  router.get('/status', async (request, response, next) => {
    try {
      const permissionTags = authorisedPermissionTags(request, response, resolvePermissionTags);
      if (!permissionTags) {
        return;
      }
      response.json(await service.status({ permissionTags }));
    } catch (error) {
      next(error);
    }
  });

  router.post('/search', async (request, response, next) => {
    try {
      const permissionTags = authorisedPermissionTags(request, response, resolvePermissionTags);
      if (!permissionTags) {
        return;
      }
      const input = DocumentSearchInputSchema.parse(request.body);
      const controller = new AbortController();
      const close = () => {
        if (!response.writableEnded) controller.abort();
      };
      response.once('close', close);
      try {
        response.json(await service.search(input, { permissionTags, signal: controller.signal }));
      } finally {
        response.off('close', close);
      }
    } catch (error) {
      next(error);
    }
  });

  return router;
}

export const documentsRouter = createDocumentsRouter();
