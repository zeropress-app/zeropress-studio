import { Hono } from 'hono';
import { auditLogQuerySchema, auditLogListSuccessSchema, auditLogDetailSuccessSchema } from '../../../contracts/audit-logs';
import { requireStudioCapability } from '../auth/authorization';
import type { ResolveUserSession } from '../auth/session-repository';
import { errorResponse } from '../lib/http';
import { logOperationalFailure } from '../lib/operational-error';
import type { StudioHonoEnvironment } from '../types';
import { InvalidAuditCursor, listAuditLogs, readAuditLog } from './repository';
export function createAuditRoutes(dependencies: { resolveSession?: ResolveUserSession } = {}) {
  const routes = new Hono<StudioHonoEnvironment>();
  routes.use('*', async (c, next) => {
    c.header('Cache-Control', 'no-store');
    const authorized = await requireStudioCapability({ context: c, capability: 'audit.read', resolveSession: dependencies.resolveSession });
    if (authorized instanceof Response) return authorized;
    await next();
  });
  routes.get('/', async (c) => {
    const parsed = auditLogQuerySchema.safeParse(c.req.query());
    if (!parsed.success) return errorResponse(c, 400, 'VALIDATION_ERROR');
    try { return c.json(auditLogListSuccessSchema.parse({ success: true, data: await listAuditLogs(c.env.DB, parsed.data) })); }
    catch (error) {
      if (error instanceof InvalidAuditCursor) return errorResponse(c, 400, 'VALIDATION_ERROR');
      logOperationalFailure('AUDIT_READ_FAILED', { metadata: { resource: 'DB' } });
      return errorResponse(c, 503, 'SYSTEM_NOT_AVAILABLE');
    }
  });
  routes.get('/:id', async (c) => {
    try {
      const record = await readAuditLog(c.env.DB, c.req.param('id'));
      return record ? c.json(auditLogDetailSuccessSchema.parse({ success: true, data: record })) : errorResponse(c, 404, 'NOT_FOUND');
    } catch {
      logOperationalFailure('AUDIT_READ_FAILED', { metadata: { resource: 'DB' } });
      return errorResponse(c, 503, 'SYSTEM_NOT_AVAILABLE');
    }
  });
  return routes;
}
