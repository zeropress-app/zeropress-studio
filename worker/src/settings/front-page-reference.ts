import { readRoutingSettings } from './routing-settings-repository';

export async function isConfiguredFrontPage(input: {
  db: D1Database;
  pageId: string;
}): Promise<boolean> {
  const document = await readRoutingSettings({ db: input.db });
  return document.settings.front_page.type === 'page'
    && document.settings.front_page.page_id === input.pageId;
}
