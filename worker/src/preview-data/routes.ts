import { Hono, type Context } from 'hono';
import {
  previewDataSuccessSchema,
  previewDataSummarySuccessSchema,
} from '../../../contracts/preview-data';
import { requireStudioCapability } from '../auth/authorization';
import type { ResolveUserSession } from '../auth/session-repository';
import type { StudioHonoEnvironment } from '../types';
import {
  preparePreviewDataExport,
  type PreviewDataPreparationDependencies,
} from './prepare';
import { readPreviewDataSummary } from './summary';
import { previewDataHash } from '../publishing/metadata';

type PreviewDataRouteDependencies = PreviewDataPreparationDependencies & {
  resolveSession?: ResolveUserSession;
  readSummary?: typeof readPreviewDataSummary;
};

export function createPreviewDataRoutes(
  dependencies: PreviewDataRouteDependencies = {},
) {
  const routes = new Hono<StudioHonoEnvironment>();
  const readSummary = dependencies.readSummary ?? readPreviewDataSummary;

  async function requirePublisher(c: Context<StudioHonoEnvironment>) {
    return requireStudioCapability({
      context: c,
      capability: 'publish.manage',
      resolveSession: dependencies.resolveSession,
    });
  }

  routes.get('/summary', async (c) => {
    const session = await requirePublisher(c);
    if (session instanceof Response) return session;
    const summary = await readSummary({ db: c.env.DB });
    c.header('Cache-Control', 'no-store');
    return c.json(
      previewDataSummarySuccessSchema.parse({
        success: true,
        data: summary,
      }),
    );
  });

  routes.get('/', async (c) => {
    const session = await requirePublisher(c);
    if (session instanceof Response) return session;
    const document = await preparePreviewDataExport(c, dependencies);
    if (document instanceof Response) return document;
    c.header('Cache-Control', 'no-store');
    return c.json(
      previewDataSuccessSchema.parse({
        success: true,
        data: {
          ...document,
          data_hash: await previewDataHash(document.preview_data),
        },
      }),
    );
  });

  return routes;
}
