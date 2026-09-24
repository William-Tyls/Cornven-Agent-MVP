import { Router, type Request, type Response } from 'express';
import { DocumentPermissionTagSchema } from '@cornven/contracts';
import { loadDocumentSources } from './source-loader.js';
import { findRegisteredAsset } from './document-resources.js';
import { readRegisteredAsset } from './source-structure.js';
export function createDocumentAssetsRouter(
  options: {
    load?: typeof loadDocumentSources;
    permissions?: (request: Request, response: Response) => string[];
  } = {},
) {
  const router = Router();
  router.get('/assets/:assetId', async (request, response) => {
    const parsed = DocumentPermissionTagSchema.array().safeParse(
      response.locals.documentPermissionTags,
    );
    const demo =
      process.env.LOCAL_DEVELOPMENT_IDENTITY === 'true' && process.env.NODE_ENV !== 'production';
    const permissions =
      options.permissions?.(request, response) ??
      (parsed.success ? parsed.data : demo ? ['staff'] : []);
    response.set('Cache-Control', 'no-store');
    if (!permissions.length) {
      response
        .status(403)
        .json({ error: { code: 'FORBIDDEN', message: '当前没有资料访问权限。' } });
      return;
    }
    const id = request.params.assetId;
    if (
      typeof id !== 'string' ||
      !/^asset-[a-f0-9]{24}$/.test(id) ||
      !['view', 'download'].includes(String(request.query.action)) ||
      Object.keys(request.query).some((k) => k !== 'action')
    ) {
      response.status(400).json({ error: { code: 'INVALID_RESOURCE', message: '资源请求无效。' } });
      return;
    }
    try {
      const resource = findRegisteredAsset(
        await (options.load ?? loadDocumentSources)(),
        id,
        permissions,
      );
      if (!resource) {
        response
          .status(404)
          .json({ error: { code: 'RESOURCE_UNAVAILABLE', message: '资料不存在或当前不可访问。' } });
        return;
      }
      const bytes = await readRegisteredAsset(resource);
      response
        .set({
          'Content-Type': resource.mimeType!,
          'X-Content-Type-Options': 'nosniff',
          'Content-Disposition': `${request.query.action === 'download' ? 'attachment' : 'inline'}; filename="resource.${resource.kind === 'pdf' ? 'pdf' : 'webp'}"; filename*=UTF-8''${encodeURIComponent(resource.filename!).replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16))}`,
          'Access-Control-Expose-Headers': 'Content-Disposition',
        })
        .send(bytes);
    } catch {
      response.status(503).json({
        error: { code: 'RESOURCE_UNAVAILABLE', message: '资料暂时不可用，请联系维护人员。' },
      });
    }
  });
  return router;
}
