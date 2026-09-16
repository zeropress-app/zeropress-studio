import { Hono, type Context } from 'hono';
import {
  cloudflareAccessSettingsSuccessSchema,
} from '../../../contracts/cloudflare-access';
import { requireStudioCapability } from '../auth/authorization';
import type { ResolveUserSession } from '../auth/session-repository';
import type { StudioHonoEnvironment } from '../types';
import {
  verifyCloudflareAccessAssertion,
  type VerifyCloudflareAccessAssertion,
} from './assertion-verifier';
import {
  readCloudflareAccessSettings,
} from './settings-repository';
import {
  materializeCloudflareAccessSettingsDocument,
  verifyCurrentCloudflareAccessRequest,
} from './settings-document';

export type CloudflareAccessRouteDependencies = {
  resolveSession?: ResolveUserSession;
  readSettings?: typeof readCloudflareAccessSettings;
  verifyAssertion?: VerifyCloudflareAccessAssertion;
  now?: () => Date;
};

export function createCloudflareAccessRoutes(
  dependencies: CloudflareAccessRouteDependencies = {},
) {
  const routes = new Hono<StudioHonoEnvironment>();
  const readSettings = dependencies.readSettings ?? readCloudflareAccessSettings;
  const verifyAssertion = dependencies.verifyAssertion
    ?? verifyCloudflareAccessAssertion;
  const currentTime = dependencies.now ?? (() => new Date());

  async function requireManager(c: Context<StudioHonoEnvironment>) {
    return requireStudioCapability({
      context: c,
      capability: 'settings.manage',
      resolveSession: dependencies.resolveSession,
    });
  }

  routes.get('/', async (c) => {
    const session = await requireManager(c);
    if (session instanceof Response) return session;
    const stored = await readSettings({ db: c.env.DB });
    const verification = await verifyCurrentCloudflareAccessRequest({
      context: c,
      stored,
      verifyAssertion,
      now: currentTime(),
    });
    return c.json(cloudflareAccessSettingsSuccessSchema.parse({
      success: true,
      data: materializeCloudflareAccessSettingsDocument(
        stored,
        verification,
      ),
    }));
  });

  return routes;
}
