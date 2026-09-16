// @vitest-environment jsdom

import { describe, expect, it } from 'vitest';
import {
  parseWxrCoreImportFile,
  WxrCoreParseError,
} from './wxr-core-parser';

function wxr(channel: string, version = '1.2'): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"
  xmlns:content="http://purl.org/rss/1.0/modules/content/"
  xmlns:dc="http://purl.org/dc/elements/1.1/"
  xmlns:excerpt="http://wordpress.org/export/1.2/excerpt/"
  xmlns:wp="http://wordpress.org/export/1.2/">
  <channel>
    <title>테스트 블로그</title>
    <description>테스트 사이트 설명</description>
    <link>https://blog.example/subsite</link>
    <language>ko-KR</language>
    <wp:base_blog_url>https://blog.example/subsite</wp:base_blog_url>
    <wp:wxr_version>${version}</wp:wxr_version>
    ${channel}
  </channel>
</rss>`;
}

function sourceFileFromBytes(bytes: Uint8Array, chunkSize = bytes.length): File {
  return {
    name: 'export.xml',
    size: bytes.byteLength,
    stream() {
      return new ReadableStream<Uint8Array>({
        start(controller) {
          for (let offset = 0; offset < bytes.length; offset += chunkSize) {
            controller.enqueue(bytes.slice(offset, offset + chunkSize));
          }
          controller.close();
        },
      });
    },
  } as File;
}

function sourceFile(source: string, chunkSize = source.length): File {
  return sourceFileFromBytes(new TextEncoder().encode(source), chunkSize);
}

const CORE_WXR = wxr(`
  <wp:author>
    <wp:author_id>7</wp:author_id>
    <wp:author_login><![CDATA[Lael-Rukius]]></wp:author_login>
    <wp:author_display_name><![CDATA[HYEONG HWAN, MUN]]></wp:author_display_name>
  </wp:author>
  <wp:category>
    <wp:category_nicename>news</wp:category_nicename>
    <wp:cat_name>News</wp:cat_name>
    <wp:category_description>Latest news</wp:category_description>
  </wp:category>
  <wp:tag>
    <wp:tag_slug>important</wp:tag_slug>
    <wp:tag_name>Important</wp:tag_name>
    <wp:tag_description></wp:tag_description>
  </wp:tag>
  <item>
    <title>Hero image</title>
    <wp:post_id>90</wp:post_id>
    <wp:post_type>attachment</wp:post_type>
    <wp:status>inherit</wp:status>
    <wp:attachment_url>https://blog.example/wp-content/uploads/hero.jpg</wp:attachment_url>
    <wp:postmeta><wp:meta_key>_wp_attachment_image_alt</wp:meta_key><wp:meta_value><![CDATA[Hero alt]]></wp:meta_value></wp:postmeta>
    <wp:postmeta><wp:meta_key>_wp_attachment_metadata</wp:meta_key><wp:meta_value><![CDATA[a:6:{s:5:"width";i:1018;s:6:"height";i:724;}]]></wp:meta_value></wp:postmeta>
  </item>
  <item>
    <title><![CDATA[첫 글]]></title>
    <dc:creator><![CDATA[Lael-Rukius]]></dc:creator>
    <content:encoded><![CDATA[<p>안녕하세요 🌱</p>]]></content:encoded>
    <excerpt:encoded><![CDATA[첫 요약]]></excerpt:encoded>
    <category domain="post_tag" nicename="important">Important</category>
    <category domain="category" nicename="news">News</category>
    <wp:post_id>11</wp:post_id>
    <wp:post_date>2026-07-01 10:02:03</wp:post_date>
    <wp:post_date_gmt>2026-07-01 01:02:03</wp:post_date_gmt>
    <wp:post_modified_gmt>2026-07-02 01:02:03</wp:post_modified_gmt>
    <wp:post_name>first.post</wp:post_name>
    <wp:post_parent>0</wp:post_parent>
    <wp:post_type>post</wp:post_type>
    <wp:status>publish</wp:status>
    <wp:comment_status>open</wp:comment_status>
    <wp:postmeta><wp:meta_key>_thumbnail_id</wp:meta_key><wp:meta_value>90</wp:meta_value></wp:postmeta>
    <wp:comment>
      <wp:comment_id>99</wp:comment_id>
      <wp:comment_author><![CDATA[Reader]]></wp:comment_author>
      <wp:comment_author_email>reader@example.com</wp:comment_author_email>
      <wp:comment_date_gmt>2026-07-03 01:02:03</wp:comment_date_gmt>
      <wp:comment_content><![CDATA[Imported reply]]></wp:comment_content>
      <wp:comment_approved>1</wp:comment_approved>
      <wp:comment_type>comment</wp:comment_type>
      <wp:comment_parent>0</wp:comment_parent>
      <wp:commentmeta><wp:meta_key>plugin-private</wp:meta_key><wp:meta_value>ignored</wp:meta_value></wp:commentmeta>
    </wp:comment>
  </item>
  <item>
    <title>Child</title><content:encoded><![CDATA[<p>Child</p>]]></content:encoded>
    <wp:post_id>22</wp:post_id><wp:post_parent>21</wp:post_parent>
    <wp:post_date_gmt>2026-07-01 00:00:00</wp:post_date_gmt>
    <wp:post_modified_gmt>2026-07-01 00:00:00</wp:post_modified_gmt>
    <wp:post_name>child</wp:post_name><wp:post_type>page</wp:post_type>
    <wp:status>publish</wp:status><wp:comment_status>closed</wp:comment_status>
  </item>
  <item>
    <title>Parent</title><content:encoded><![CDATA[<p>Parent</p>]]></content:encoded>
    <wp:post_id>21</wp:post_id><wp:post_parent>0</wp:post_parent>
    <wp:post_date_gmt>2026-06-01 00:00:00</wp:post_date_gmt>
    <wp:post_modified_gmt>2026-06-01 00:00:00</wp:post_modified_gmt>
    <wp:post_name>parent</wp:post_name><wp:post_type>page</wp:post_type>
    <wp:status>draft</wp:status><wp:comment_status>open</wp:comment_status>
  </item>
  <item>
    <title>Plugin record</title>
    <content:encoded><![CDATA[plugin-only-data]]></content:encoded>
    <wp:post_id>101</wp:post_id><wp:post_type>product</wp:post_type>
  </item>`);

describe('Studio WXR core streaming parser', () => {
  it('preserves core relationships across UTF-8, tag, and CDATA chunk boundaries', async () => {
    const plan = await parseWxrCoreImportFile(sourceFile(CORE_WXR, 7));
    expect(plan.source).toEqual({
      site_title: '테스트 블로그',
      site_url: 'https://blog.example/subsite',
      site_settings: {
        title: '테스트 블로그',
        description: '테스트 사이트 설명',
        url: {
          source: 'https://blog.example/subsite',
          origin: 'https://blog.example',
        },
        locale: 'ko-KR',
        timezone: '+09:00',
      },
      permalinks: {
        output_style: null,
        posts: null,
        pages: null,
      },
      media_strategy: 'external',
      media_from: null,
    });
    expect(plan.rows.authors).toEqual([{
      id: 'Lael-Rukius',
      display_name: 'HYEONG HWAN, MUN',
    }]);
    expect(plan.rows.media).toEqual([{
      external_id: 90,
      kind: 'image',
      filename: 'hero.jpg',
      mime_type: 'image/jpeg',
      location: {
        type: 'external',
        url: 'https://blog.example/wp-content/uploads/hero.jpg',
      },
      size_bytes: null,
      width: 1018,
      height: 724,
      duration_ms: null,
      alt: 'Hero alt',
    }]);
    expect(plan.rows.posts).toEqual([expect.objectContaining({
      public_id: 11,
      slug: 'first.post',
      content: '<p>안녕하세요 🌱</p>',
      author_id: 'Lael-Rukius',
      category_slugs: ['news'],
      tag_slugs: ['important'],
      featured_image_location: {
        type: 'external',
        url: 'https://blog.example/wp-content/uploads/hero.jpg',
      },
      allow_comments: true,
      published_at_iso: '2026-07-01T01:02:03Z',
    })]);
    expect(plan.rows.pages.map((page) => [page.public_id, page.parent_public_id]))
      .toEqual([[21, null], [22, 21]]);
    expect(plan.rows.comments).toEqual([{
      public_id: 99,
      target_type: 'post',
      target_public_id: 11,
      parent_public_id: null,
      author_name: 'Reader',
      author_email: 'reader@example.com',
      content_text: 'Imported reply',
      status: 'approved',
      created_at_iso: '2026-07-03T01:02:03Z',
    }]);
    expect(JSON.stringify(plan)).not.toContain('ignored');
    expect(JSON.stringify(plan)).not.toContain('plugin-only-data');
    expect(plan.warnings).toContainEqual({
      code: 'unsupported_items_skipped',
      count: 1,
      affected: ['product'],
    });
  });

  it('derives missing WXR excerpts from SEO metadata but not body text', async () => {
    const withSeoDescription = CORE_WXR.replace(
      '<excerpt:encoded><![CDATA[첫 요약]]></excerpt:encoded>',
      `<excerpt:encoded><![CDATA[]]></excerpt:encoded>
      <wp:postmeta><wp:meta_key>_yoast_wpseo_metadesc</wp:meta_key><wp:meta_value><![CDATA[SEO&nbsp;요약]]></wp:meta_value></wp:postmeta>`,
    );
    const seoPlan = await parseWxrCoreImportFile(sourceFile(withSeoDescription));
    expect(seoPlan.rows.posts[0]?.excerpt).toBe('SEO 요약');

    const withBodyFallback = CORE_WXR.replace(
      '<excerpt:encoded><![CDATA[첫 요약]]></excerpt:encoded>',
      '<excerpt:encoded><![CDATA[]]></excerpt:encoded>',
    ).replace(
      '<content:encoded><![CDATA[<p>안녕하세요 🌱</p>]]></content:encoded>',
      '<content:encoded><![CDATA[<p>본문&nbsp;요약</p><script>hidden()</script><p>계속</p>]]></content:encoded>',
    );
    const bodyPlan = await parseWxrCoreImportFile(sourceFile(withBodyFallback));
    expect(bodyPlan.rows.posts[0]?.excerpt).toBe('');
  });

  it('infers CLI-compatible Post, hierarchical Page, and output-style permalink settings', async () => {
    const source = wxr(`
      <item><title>First post</title><link>https://blog.example/subsite/post/101</link>
        <content:encoded></content:encoded><wp:post_id>101</wp:post_id>
        <wp:post_date>2026-07-01 09:00:00</wp:post_date>
        <wp:post_date_gmt>2026-07-01 00:00:00</wp:post_date_gmt>
        <wp:post_modified_gmt>2026-07-01 00:00:00</wp:post_modified_gmt>
        <wp:post_name>first-post</wp:post_name><wp:post_parent>0</wp:post_parent>
        <wp:post_type>post</wp:post_type><wp:status>publish</wp:status>
        <wp:comment_status>closed</wp:comment_status></item>
      <item><title>Second post</title><link>https://blog.example/subsite/post/102</link>
        <content:encoded></content:encoded><wp:post_id>102</wp:post_id>
        <wp:post_date>2026-07-02 09:00:00</wp:post_date>
        <wp:post_date_gmt>2026-07-02 00:00:00</wp:post_date_gmt>
        <wp:post_modified_gmt>2026-07-02 00:00:00</wp:post_modified_gmt>
        <wp:post_name>second-post</wp:post_name><wp:post_parent>0</wp:post_parent>
        <wp:post_type>post</wp:post_type><wp:status>publish</wp:status>
        <wp:comment_status>closed</wp:comment_status></item>
      <item><title>Parent</title><link>https://blog.example/subsite/parent/</link>
        <content:encoded></content:encoded><wp:post_id>201</wp:post_id>
        <wp:post_date>2026-07-01 09:00:00</wp:post_date>
        <wp:post_date_gmt>2026-07-01 00:00:00</wp:post_date_gmt>
        <wp:post_modified_gmt>2026-07-01 00:00:00</wp:post_modified_gmt>
        <wp:post_name>parent</wp:post_name><wp:post_parent>0</wp:post_parent>
        <wp:post_type>page</wp:post_type><wp:status>publish</wp:status>
        <wp:comment_status>closed</wp:comment_status></item>
      <item><title>Child</title><link>https://blog.example/subsite/parent/child/</link>
        <content:encoded></content:encoded><wp:post_id>202</wp:post_id>
        <wp:post_date>2026-07-01 09:00:00</wp:post_date>
        <wp:post_date_gmt>2026-07-01 00:00:00</wp:post_date_gmt>
        <wp:post_modified_gmt>2026-07-01 00:00:00</wp:post_modified_gmt>
        <wp:post_name>child</wp:post_name><wp:post_parent>201</wp:post_parent>
        <wp:post_type>page</wp:post_type><wp:status>publish</wp:status>
        <wp:comment_status>closed</wp:comment_status></item>
    `);

    const plan = await parseWxrCoreImportFile(sourceFile(source, 5));

    expect(plan.source.permalinks).toEqual({
      output_style: 'html-extension',
      posts: '/post/:public_id/',
      pages: '/:slug/',
    });
  });

  it('requires same-origin consensus and ignores non-published permalink evidence', async () => {
    const source = wxr(`
      <item><title>One</title><link>https://other.example/posts/one/</link>
        <content:encoded></content:encoded><wp:post_id>1</wp:post_id>
        <wp:post_date>2026-01-01 00:00:00</wp:post_date>
        <wp:post_date_gmt>2026-01-01 00:00:00</wp:post_date_gmt>
        <wp:post_modified_gmt>2026-01-01 00:00:00</wp:post_modified_gmt>
        <wp:post_name>one</wp:post_name><wp:post_type>post</wp:post_type>
        <wp:status>publish</wp:status><wp:comment_status>closed</wp:comment_status></item>
      <item><title>Draft</title><link>https://blog.example/subsite/posts/draft/</link>
        <content:encoded></content:encoded><wp:post_id>2</wp:post_id>
        <wp:post_date>2026-01-01 00:00:00</wp:post_date>
        <wp:post_date_gmt>2026-01-01 00:00:00</wp:post_date_gmt>
        <wp:post_modified_gmt>2026-01-01 00:00:00</wp:post_modified_gmt>
        <wp:post_name>draft</wp:post_name><wp:post_type>post</wp:post_type>
        <wp:status>draft</wp:status><wp:comment_status>closed</wp:comment_status></item>
    `);

    const plan = await parseWxrCoreImportFile(sourceFile(source));

    expect(plan.source.permalinks).toEqual({
      output_style: null,
      posts: null,
      pages: null,
    });
  });

  it('does not guess a timezone or locale when WXR metadata is ambiguous or invalid', async () => {
    const item = (id: number, local: string, gmt: string) => `<item>
      <title>Post ${id}</title><content:encoded></content:encoded>
      <wp:post_id>${id}</wp:post_id><wp:post_parent>0</wp:post_parent>
      <wp:post_date>${local}</wp:post_date>
      <wp:post_date_gmt>${gmt}</wp:post_date_gmt>
      <wp:post_modified_gmt>${gmt}</wp:post_modified_gmt>
      <wp:post_name>post-${id}</wp:post_name><wp:post_type>post</wp:post_type>
      <wp:status>publish</wp:status><wp:comment_status>closed</wp:comment_status>
    </item>`;
    const source = wxr(`
      ${item(1, '2026-01-01 07:00:00', '2026-01-01 12:00:00')}
      ${item(2, '2026-07-01 08:00:00', '2026-07-01 12:00:00')}
    `).replace('<language>ko-KR</language>', '<language>not_a_locale</language>');

    const plan = await parseWxrCoreImportFile(sourceFile(source, 3));

    expect(plan.source.site_settings.locale).toBeNull();
    expect(plan.source.site_settings.timezone).toBeNull();
    expect(plan.warnings).toEqual(expect.arrayContaining([
      {
        code: 'locale_inference_skipped',
        count: 1,
        affected: ['site:locale'],
      },
      {
        code: 'timezone_inference_ambiguous',
        count: 2,
        affected: ['-05:00', '-04:00'],
      },
    ]));
  });

  it('distinguishes an explicitly empty site description from a missing field', async () => {
    const explicitEmpty = await parseWxrCoreImportFile(sourceFile(
      CORE_WXR.replace(
        '<description>테스트 사이트 설명</description>',
        '<description></description>',
      ),
    ));
    const missing = await parseWxrCoreImportFile(sourceFile(
      CORE_WXR.replace('<description>테스트 사이트 설명</description>', ''),
    ));

    expect(explicitEmpty.source.site_settings.description).toBe('');
    expect(missing.source.site_settings.description).toBeNull();
  });

  it('normalizes Unicode line separators in imported content', async () => {
    const source = wxr(`
      <item>
        <title>Unicode separators</title>
        <content:encoded><![CDATA[Before\u2028Middle\u2029After]]></content:encoded>
        <wp:post_id>987</wp:post_id>
        <wp:post_date_gmt>2026-07-01 01:02:03</wp:post_date_gmt>
        <wp:post_modified_gmt>2026-07-02 01:02:03</wp:post_modified_gmt>
        <wp:post_name>unicode-separators</wp:post_name>
        <wp:post_type>post</wp:post_type>
        <wp:status>publish</wp:status>
        <wp:comment_status>closed</wp:comment_status>
      </item>`);

    const plan = await parseWxrCoreImportFile(sourceFile(source, 1));

    expect(plan.rows.posts).toEqual([expect.objectContaining({
      public_id: 987,
      content: '<p>Before<br>Middle<br>After</p>',
      editor_mode: 'visual',
      editor_profile: 'tiptap-v1',
      status: 'published',
    })]);
  });

  it('materializes classic WordPress paragraphs and soft breaks before visual classification', async () => {
    const source = wxr(`
      <item>
        <title>Classic breaks</title>
        <content:encoded><![CDATA[<p>Paragraph first
Paragraph second</p>
Bare first
Bare second]]></content:encoded>
        <wp:post_id>988</wp:post_id>
        <wp:post_date_gmt>2026-07-01 01:02:03</wp:post_date_gmt>
        <wp:post_modified_gmt>2026-07-02 01:02:03</wp:post_modified_gmt>
        <wp:post_name>classic-breaks</wp:post_name>
        <wp:post_type>post</wp:post_type>
        <wp:status>publish</wp:status>
        <wp:comment_status>closed</wp:comment_status>
      </item>`);

    const plan = await parseWxrCoreImportFile(sourceFile(source, 1));

    expect(plan.rows.posts).toEqual([expect.objectContaining({
      public_id: 988,
      content: [
        '<p>Paragraph first<br>Paragraph second</p>',
        '<p>Bare first<br>Bare second</p>',
      ].join('\n'),
      editor_mode: 'visual',
      editor_profile: 'tiptap-v1',
    })]);
  });

  it('canonicalizes only safe HTML and preserves review or blocked HTML in source mode', async () => {
    const item = (input: { id: number; title: string; content: string }) => `
      <item>
        <title>${input.title}</title>
        <content:encoded><![CDATA[${input.content}]]></content:encoded>
        <wp:post_id>${input.id}</wp:post_id>
        <wp:post_date_gmt>2026-07-01 01:02:03</wp:post_date_gmt>
        <wp:post_modified_gmt>2026-07-02 01:02:03</wp:post_modified_gmt>
        <wp:post_name>post-${input.id}</wp:post_name>
        <wp:post_type>post</wp:post_type>
        <wp:status>publish</wp:status>
        <wp:comment_status>closed</wp:comment_status>
      </item>`;
    const compatible = '<pre>CPU: <a href="https://example.com/cpu">Intel Xeon</a></pre>';
    const incompatible = '<picture><source srcset="/wide.png"><img src="/small.png" alt="Small"></picture>';
    const reviewRequired = '<p style="color:red">Review presentation</p>';
    const plan = await parseWxrCoreImportFile(sourceFile(wxr(`
      ${item({ id: 301, title: 'Visual content', content: compatible })}
      ${item({ id: 302, title: 'Source content', content: incompatible })}
      ${item({ id: 303, title: 'Review content', content: reviewRequired })}
    `), 9));

    expect(plan.rows.posts).toEqual([
      expect.objectContaining({
        public_id: 301,
        content: compatible,
        editor_mode: 'visual',
        editor_profile: 'tiptap-v1',
      }),
      expect.objectContaining({
        public_id: 302,
        content: incompatible,
        editor_mode: 'source',
        editor_profile: null,
      }),
      expect.objectContaining({
        public_id: 303,
        content: reviewRequired,
        editor_mode: 'source',
        editor_profile: null,
      }),
    ]);
    expect(plan.editor_compatibility).toEqual({
      visual: 1,
      source: 2,
      source_fallbacks: [
        {
          reason: 'contract_data_lost',
          count: 1,
          affected: ['Source content'],
        },
        {
          reason: 'unsupported_attributes_removed',
          count: 1,
          affected: ['Review content'],
        },
      ],
    });
    expect(plan.warnings).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ code: expect.stringContaining('editor') }),
    ]));
  });

  it('discards malformed UTF-8 bytes without replacing them', async () => {
    const source = wxr(`
      <item>
        <title>Malformed UTF-8</title>
        <content:encoded><![CDATA[Keep\uFFFDBefore~After]]></content:encoded>
        <wp:post_id>988</wp:post_id>
        <wp:post_date_gmt>2026-07-01 01:02:03</wp:post_date_gmt>
        <wp:post_modified_gmt>2026-07-02 01:02:03</wp:post_modified_gmt>
        <wp:post_name>malformed-utf8</wp:post_name>
        <wp:post_type>post</wp:post_type>
        <wp:status>publish</wp:status>
        <wp:comment_status>closed</wp:comment_status>
      </item>`);
    const bytes = new TextEncoder().encode(source);
    const markerOffset = bytes.indexOf('~'.charCodeAt(0));
    if (markerOffset < 0) throw new Error('Malformed UTF-8 test marker was not found.');

    const damagedBytes = new Uint8Array(bytes.length + 1);
    damagedBytes.set(bytes.subarray(0, markerOffset));
    damagedBytes.set([0xc3, 0x28], markerOffset);
    damagedBytes.set(bytes.subarray(markerOffset + 1), markerOffset + 2);

    const plan = await parseWxrCoreImportFile(sourceFileFromBytes(damagedBytes, 1));

    expect(plan.rows.posts).toEqual([expect.objectContaining({
      public_id: 988,
      content: '<p>Keep\uFFFDBefore(After</p>',
      editor_mode: 'visual',
      editor_profile: 'tiptap-v1',
      status: 'published',
    })]);
  });

  it('orders Post/Page replies, normalizes invalid parents, and skips unsupported comments', async () => {
    const comment = (input: {
      id: number;
      parent?: number;
      approval?: string;
      type?: string;
      email?: string;
    }) => `<wp:comment>
      <wp:comment_id>${input.id}</wp:comment_id>
      <wp:comment_author>Reader ${input.id}</wp:comment_author>
      <wp:comment_author_email>${input.email ?? 'reader@example.com'}</wp:comment_author_email>
      <wp:comment_date_gmt>2026-07-03 01:02:03</wp:comment_date_gmt>
      <wp:comment_content>Comment ${input.id}</wp:comment_content>
      <wp:comment_approved>${input.approval ?? '1'}</wp:comment_approved>
      <wp:comment_type>${input.type ?? ''}</wp:comment_type>
      <wp:comment_parent>${input.parent ?? 0}</wp:comment_parent>
    </wp:comment>`;
    const source = wxr(`
      <item><title>Post</title><content:encoded></content:encoded>
        <wp:post_id>11</wp:post_id><wp:post_parent>0</wp:post_parent>
        <wp:post_date_gmt>2026-01-01 00:00:00</wp:post_date_gmt>
        <wp:post_modified_gmt>2026-01-01 00:00:00</wp:post_modified_gmt>
        <wp:post_name>post</wp:post_name><wp:post_type>post</wp:post_type>
        <wp:status>publish</wp:status><wp:comment_status>open</wp:comment_status>
        ${comment({ id: 102, parent: 101 })}
        ${comment({ id: 101, email: 'invalid-address' })}
        ${comment({ id: 103, parent: 999 })}
        ${comment({ id: 104, approval: 'spam' })}
        ${comment({ id: 105, type: 'pingback' })}
        ${comment({ id: 106, parent: 107 })}
        ${comment({ id: 107, parent: 106 })}
      </item>
      <item><title>Page</title><content:encoded></content:encoded>
        <wp:post_id>11</wp:post_id><wp:post_parent>0</wp:post_parent>
        <wp:post_date_gmt>2026-01-01 00:00:00</wp:post_date_gmt>
        <wp:post_modified_gmt>2026-01-01 00:00:00</wp:post_modified_gmt>
        <wp:post_name>page</wp:post_name><wp:post_type>page</wp:post_type>
        <wp:status>publish</wp:status><wp:comment_status>open</wp:comment_status>
        ${comment({ id: 201, parent: 101 })}
      </item>`);
    const plan = await parseWxrCoreImportFile(sourceFile(source, 5));
    expect(plan.rows.comments.map((row) => [
      row.public_id,
      row.target_type,
      row.parent_public_id,
      row.author_email,
    ])).toEqual([
      [101, 'post', null, ''],
      [102, 'post', 101, 'reader@example.com'],
      [103, 'post', null, 'reader@example.com'],
      [106, 'post', null, 'reader@example.com'],
      [107, 'post', 106, 'reader@example.com'],
      [201, 'page', null, 'reader@example.com'],
    ]);
    expect(plan.warnings).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'invalid_comment_emails_discarded', count: 1 }),
      expect.objectContaining({ code: 'invalid_comment_parents', count: 3 }),
      expect.objectContaining({ code: 'unsupported_comment_statuses_skipped', count: 1 }),
      expect.objectContaining({ code: 'unsupported_comment_types_skipped', count: 1 }),
    ]));
  });

  it('bounds WXR comment source text and conditionally compacts oversized whitespace', async () => {
    const comment = (id: number, content: string) => `<wp:comment>
      <wp:comment_id>${id}</wp:comment_id>
      <wp:comment_author>Reader ${id}</wp:comment_author>
      <wp:comment_author_email>reader@example.com</wp:comment_author_email>
      <wp:comment_date_gmt>2026-07-03 01:02:03</wp:comment_date_gmt>
      <wp:comment_content><![CDATA[${content}]]></wp:comment_content>
      <wp:comment_approved>1</wp:comment_approved>
      <wp:comment_type>comment</wp:comment_type>
      <wp:comment_parent>0</wp:comment_parent>
    </wp:comment>`;
    const source = wxr(`
      <item><title>Post</title><content:encoded></content:encoded>
        <wp:post_id>11</wp:post_id><wp:post_parent>0</wp:post_parent>
        <wp:post_date_gmt>2026-01-01 00:00:00</wp:post_date_gmt>
        <wp:post_modified_gmt>2026-01-01 00:00:00</wp:post_modified_gmt>
        <wp:post_name>post</wp:post_name><wp:post_type>post</wp:post_type>
        <wp:status>publish</wp:status><wp:comment_status>open</wp:comment_status>
        ${comment(300, 'Keep   spacing\n\nbetween lines')}
        ${comment(301, `A${' '.repeat(6_000)}B\n\n\nC`)}
        ${comment(302, 'x '.repeat(3_000))}
        ${comment(303, `A${' '.repeat(20_000)}B`)}
      </item>`);

    const plan = await parseWxrCoreImportFile(sourceFile(source, 7));

    expect(plan.rows.comments).toEqual([
      expect.objectContaining({
        public_id: 300,
        content_text: 'Keep   spacing\n\nbetween lines',
      }),
      expect.objectContaining({
        public_id: 301,
        content_text: 'A B\nC',
      }),
    ]);
    expect(plan.warnings).toEqual(expect.arrayContaining([
      {
        code: 'compacted_comment_whitespace',
        count: 1,
        affected: ['comment 301'],
      },
      {
        code: 'content_limits_skipped',
        count: 2,
        affected: ['comment 302', 'comment 303'],
      },
    ]));
  });

  it('builds deterministic typed Menu trees and bounds malformed graph branches', async () => {
    const menuItem = (input: {
      id: number;
      menu?: 'main' | 'footer';
      parent?: number;
      order?: number;
      title?: string;
      type?: string;
      object?: string;
      objectId?: string;
      url?: string;
      status?: string;
      target?: string;
    }) => `<item>
      <title>${input.title ?? `Item ${input.id}`}</title>
      <category domain="nav_menu" nicename="${input.menu ?? 'main'}">${input.menu === 'footer' ? 'Footer' : 'Main'}</category>
      <wp:post_id>${input.id}</wp:post_id>
      <wp:post_type>nav_menu_item</wp:post_type>
      <wp:status>${input.status ?? 'publish'}</wp:status>
      <wp:menu_order>${input.order ?? input.id}</wp:menu_order>
      <wp:postmeta><wp:meta_key>_menu_item_menu_item_parent</wp:meta_key><wp:meta_value>${input.parent ?? 0}</wp:meta_value></wp:postmeta>
      <wp:postmeta><wp:meta_key>_menu_item_type</wp:meta_key><wp:meta_value>${input.type ?? 'custom'}</wp:meta_value></wp:postmeta>
      <wp:postmeta><wp:meta_key>_menu_item_object</wp:meta_key><wp:meta_value>${input.object ?? 'custom'}</wp:meta_value></wp:postmeta>
      <wp:postmeta><wp:meta_key>_menu_item_object_id</wp:meta_key><wp:meta_value>${input.objectId ?? input.id}</wp:meta_value></wp:postmeta>
      <wp:postmeta><wp:meta_key>_menu_item_target</wp:meta_key><wp:meta_value>${input.target ?? ''}</wp:meta_value></wp:postmeta>
      <wp:postmeta><wp:meta_key>_menu_item_url</wp:meta_key><wp:meta_value>${input.url ?? ''}</wp:meta_value></wp:postmeta>
    </item>`;
    const deepItems = Array.from({ length: 11 }, (_, index) => menuItem({
      id: 400 + index,
      parent: index === 0 ? 0 : 399 + index,
      order: 20 + index,
      url: `#depth-${index + 1}`,
    })).join('');
    const source = wxr(`
      <wp:category><wp:term_id>7</wp:term_id><wp:category_nicename>news</wp:category_nicename><wp:cat_name>News</wp:cat_name><wp:category_description></wp:category_description></wp:category>
      <wp:tag><wp:term_id>8</wp:term_id><wp:tag_slug>release</wp:tag_slug><wp:tag_name>Release</wp:tag_name><wp:tag_description></wp:tag_description></wp:tag>
      <wp:term><wp:term_id>70</wp:term_id><wp:term_slug>main</wp:term_slug><wp:term_name>Main Navigation</wp:term_name><wp:term_taxonomy>nav_menu</wp:term_taxonomy></wp:term>
      <wp:term><wp:term_id>71</wp:term_id><wp:term_slug>footer</wp:term_slug><wp:term_name>Footer Links</wp:term_name><wp:term_taxonomy>nav_menu</wp:term_taxonomy></wp:term>
      <item><title>Post title</title><content:encoded></content:encoded>
        <wp:post_id>11</wp:post_id><wp:post_parent>0</wp:post_parent>
        <wp:post_date_gmt>2026-01-01 00:00:00</wp:post_date_gmt><wp:post_modified_gmt>2026-01-01 00:00:00</wp:post_modified_gmt>
        <wp:post_name>post</wp:post_name><wp:post_type>post</wp:post_type><wp:status>publish</wp:status><wp:comment_status>closed</wp:comment_status>
      </item>
      <item><title>Page title</title><content:encoded></content:encoded>
        <wp:post_id>21</wp:post_id><wp:post_parent>0</wp:post_parent>
        <wp:post_date_gmt>2026-01-01 00:00:00</wp:post_date_gmt><wp:post_modified_gmt>2026-01-01 00:00:00</wp:post_modified_gmt>
        <wp:post_name>page</wp:post_name><wp:post_type>page</wp:post_type><wp:status>publish</wp:status><wp:comment_status>closed</wp:comment_status>
      </item>
      ${menuItem({ id: 301, order: 1, title: '', type: 'post_type', object: 'post', objectId: '11' })}
      ${menuItem({ id: 302, parent: 301, order: 2, type: 'post_type', object: 'page', objectId: '21' })}
      ${menuItem({ id: 303, parent: 999, order: 3, title: 'Contact', url: 'https://blog.example/subsite/contact/?from=menu#top' })}
      ${menuItem({ id: 304, order: 4, title: '', type: 'taxonomy', object: 'category', objectId: '7' })}
      ${menuItem({ id: 305, order: 5, title: '', type: 'taxonomy', object: 'post_tag', objectId: '8' })}
      ${menuItem({ id: 306, parent: 307, order: 6, url: '#cycle-a' })}
      ${menuItem({ id: 307, parent: 306, order: 7, url: '#cycle-b' })}
      ${menuItem({ id: 308, parent: 306, order: 8, url: '#cycle-child' })}
      ${menuItem({ id: 309, order: 9, status: 'draft', url: '#draft' })}
      ${deepItems}
      ${menuItem({ id: 500, menu: 'footer', order: 1, title: 'External', url: 'https://external.example/docs', target: '_blank' })}
    `);
    const plan = await parseWxrCoreImportFile(sourceFile(source, 9));
    expect(plan.rows.menus.map((menu) => [menu.menu_id, menu.name]))
      .toEqual([['footer', 'Footer Links'], ['primary', 'Main Navigation']]);
    const primary = plan.rows.menus.find((menu) => menu.menu_id === 'primary')!;
    expect(primary.items[0]).toMatchObject({
      id: '0000000000000000000000000000012d',
      title: 'Post title',
      link: { kind: 'post', public_id: 11 },
      children: [{
        id: '0000000000000000000000000000012e',
        link: { kind: 'page', public_id: 21 },
      }],
    });
    expect(primary.items).toEqual(expect.arrayContaining([
      expect.objectContaining({
        title: 'Contact',
        link: { kind: 'custom', url: '/contact/?from=menu#top' },
      }),
      expect.objectContaining({
        title: 'News', link: { kind: 'category', slug: 'news' },
      }),
      expect.objectContaining({
        title: 'Release', link: { kind: 'tag', slug: 'release' },
      }),
    ]));
    let current = primary.items.find((item) => item.id.endsWith('0190'))!;
    for (let depth = 1; depth < 10; depth += 1) current = current.children[0]!;
    expect(current.children).toEqual([]);
    expect(plan.warnings).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'orphan_menu_parents', count: 1 }),
      expect.objectContaining({ code: 'discarded_cyclic_menu_items', count: 3 }),
      expect.objectContaining({ code: 'discarded_deep_menu_items', count: 1 }),
      expect.objectContaining({ code: 'skipped_menu_items', count: 1 }),
    ]));
  });

  it('rejects ambiguous Navigation Menu term identities', async () => {
    const source = wxr(`
      <wp:term><wp:term_id>70</wp:term_id><wp:term_slug>main menu</wp:term_slug><wp:term_name>Main</wp:term_name><wp:term_taxonomy>nav_menu</wp:term_taxonomy></wp:term>
      <wp:term><wp:term_id>71</wp:term_id><wp:term_slug>main-menu</wp:term_slug><wp:term_name>Main</wp:term_name><wp:term_taxonomy>nav_menu</wp:term_taxonomy></wp:term>
    `);
    await expect(parseWxrCoreImportFile(sourceFile(source)))
      .rejects.toMatchObject({ code: 'INVALID_WXR' });
  });

  it('promotes invalid and missing Page parents while rejecting cycles', async () => {
    const orphan = await parseWxrCoreImportFile(sourceFile(wxr(`
      <item><title>Orphan</title><content:encoded></content:encoded>
      <wp:post_id>31</wp:post_id><wp:post_parent>not-an-id</wp:post_parent>
      <wp:post_date_gmt>2026-01-01 00:00:00</wp:post_date_gmt>
      <wp:post_modified_gmt>2026-01-01 00:00:00</wp:post_modified_gmt>
      <wp:post_name>orphan</wp:post_name><wp:post_type>page</wp:post_type>
      <wp:status>publish</wp:status><wp:comment_status>closed</wp:comment_status></item>`), 1));
    expect(orphan.rows.pages[0]?.parent_public_id).toBeNull();
    expect(orphan.warnings).toContainEqual(expect.objectContaining({
      code: 'orphan_page_parents', count: 1,
    }));

    const cycle = wxr(`
      <item><title>A</title><content:encoded></content:encoded><wp:post_id>1</wp:post_id><wp:post_parent>2</wp:post_parent><wp:post_date_gmt>2026-01-01 00:00:00</wp:post_date_gmt><wp:post_modified_gmt>2026-01-01 00:00:00</wp:post_modified_gmt><wp:post_name>a</wp:post_name><wp:post_type>page</wp:post_type><wp:status>publish</wp:status><wp:comment_status>closed</wp:comment_status></item>
      <item><title>B</title><content:encoded></content:encoded><wp:post_id>2</wp:post_id><wp:post_parent>1</wp:post_parent><wp:post_date_gmt>2026-01-01 00:00:00</wp:post_date_gmt><wp:post_modified_gmt>2026-01-01 00:00:00</wp:post_modified_gmt><wp:post_name>b</wp:post_name><wp:post_type>page</wp:post_type><wp:status>publish</wp:status><wp:comment_status>closed</wp:comment_status></item>`);
    await expect(parseWxrCoreImportFile(sourceFile(cycle)))
      .rejects.toMatchObject({ code: 'PAGE_CYCLE' });
  });

  it('imports general attachments and creates host-independent R2 body references', async () => {
    const source = wxr(`
      <item><title>Hero</title><wp:post_id>90</wp:post_id>
        <wp:post_type>attachment</wp:post_type><wp:status>inherit</wp:status>
        <wp:post_mime_type>image/png</wp:post_mime_type>
        <wp:attachment_url>https://blog.example/wp-content/uploads/2026/07/hero.png</wp:attachment_url>
        <wp:postmeta><wp:meta_key>_wp_attached_file</wp:meta_key><wp:meta_value>2026/07/hero.png</wp:meta_value></wp:postmeta>
        <wp:postmeta><wp:meta_key>_wp_attachment_metadata</wp:meta_key><wp:meta_value><![CDATA[a:3:{s:5:"width";i:800;s:6:"height";i:600;s:8:"filesize";i:12345;}]]></wp:meta_value></wp:postmeta>
      </item>
      <item><title>Manual</title><wp:post_id>91</wp:post_id>
        <wp:post_type>attachment</wp:post_type><wp:status>inherit</wp:status>
        <wp:post_mime_type>application/pdf</wp:post_mime_type>
        <wp:attachment_url>https://blog.example/wp-content/uploads/2026/07/manual.pdf</wp:attachment_url>
        <wp:postmeta><wp:meta_key>_wp_attached_file</wp:meta_key><wp:meta_value>2026/07/manual.pdf</wp:meta_value></wp:postmeta>
      </item>
      <item><title>Assets</title><dc:creator>writer</dc:creator>
        <content:encoded><![CDATA[<img src="https://blog.example/wp-content/uploads/2026/07/hero-300x225.png"><a href="https://blog.example/wp-content/uploads/2026/07/manual.pdf">PDF</a>]]></content:encoded>
        <wp:post_id>11</wp:post_id><wp:post_date_gmt>2026-07-01 00:00:00</wp:post_date_gmt>
        <wp:post_modified_gmt>2026-07-01 00:00:00</wp:post_modified_gmt>
        <wp:post_name>assets</wp:post_name><wp:post_type>post</wp:post_type>
        <wp:status>publish</wp:status><wp:comment_status>closed</wp:comment_status>
        <wp:postmeta><wp:meta_key>_thumbnail_id</wp:meta_key><wp:meta_value>90</wp:meta_value></wp:postmeta>
      </item>`);
    const plan = await parseWxrCoreImportFile(sourceFile(source, 11), {
      mediaStrategy: 'r2',
    });
    expect(plan.source).toMatchObject({
      media_strategy: 'r2',
      media_from: 'https://blog.example/wp-content/uploads/',
    });
    expect(plan.rows.media).toEqual([
      expect.objectContaining({
        external_id: 90,
        kind: 'image',
        location: { type: 'r2', key: 'imported/2026/07/hero.png' },
        size_bytes: 12345,
        width: 800,
        height: 600,
      }),
      expect.objectContaining({
        external_id: 91,
        kind: 'document',
        mime_type: 'application/pdf',
        location: { type: 'r2', key: 'imported/2026/07/manual.pdf' },
        width: null,
        height: null,
      }),
    ]);
    expect(plan.rows.posts[0]).toMatchObject({
      featured_image_location: {
        type: 'r2',
        key: 'imported/2026/07/hero.png',
      },
    });
    expect(plan.rows.posts[0]?.content).toContain(
      '/__zeropress_media__/imported/2026/07/hero-300x225.png',
    );
    expect(plan.rows.posts[0]?.content).toContain(
      '/__zeropress_media__/imported/2026/07/manual.pdf',
    );
  });

  it('uses the lowest WordPress attachment ID for a duplicated Media location', async () => {
    const source = wxr(`
      <item><title>Later identity</title><wp:post_id>91</wp:post_id>
        <wp:post_type>attachment</wp:post_type><wp:status>inherit</wp:status>
        <wp:post_mime_type>image/png</wp:post_mime_type>
        <wp:attachment_url>https://blog.example/wp-content/uploads/shared.png</wp:attachment_url>
      </item>
      <item><title>Canonical identity</title><wp:post_id>90</wp:post_id>
        <wp:post_type>attachment</wp:post_type><wp:status>inherit</wp:status>
        <wp:post_mime_type>image/png</wp:post_mime_type>
        <wp:attachment_url>https://blog.example/wp-content/uploads/shared.png</wp:attachment_url>
      </item>`);
    const plan = await parseWxrCoreImportFile(sourceFile(source));
    expect(plan.rows.media).toHaveLength(1);
    expect(plan.rows.media[0]).toMatchObject({
      external_id: 90,
      location: {
        type: 'external',
        url: 'https://blog.example/wp-content/uploads/shared.png',
      },
    });
  });

  it('rejects malformed, dangerous, and non-1.2 documents', async () => {
    const cases = [
      { source: '<rss version="2.0"><channel>', code: 'INVALID_XML' },
      { source: '<!DOCTYPE rss><rss version="2.0"><channel /></rss>', code: 'INVALID_WXR' },
      { source: wxr('<item />', '1.1'), code: 'UNSUPPORTED_VERSION' },
    ];
    for (const item of cases) {
      try {
        await parseWxrCoreImportFile(sourceFile(item.source));
        throw new Error('Expected parsing to fail.');
      } catch (error) {
        expect(error).toBeInstanceOf(WxrCoreParseError);
        expect((error as WxrCoreParseError).code).toBe(item.code);
      }
    }
    await expect(parseWxrCoreImportFile(sourceFile(CORE_WXR), {
      mediaStrategy: 'r2',
      mediaFrom: 'https://blog.example/wp-content/uploads/../private/',
    })).rejects.toMatchObject({ code: 'MEDIA_PREFIX_INVALID' });
    const customStorage = CORE_WXR.replaceAll(
      'https://blog.example/wp-content/uploads/',
      'https://assets.example/files/',
    );
    await expect(parseWxrCoreImportFile(sourceFile(customStorage), {
      mediaStrategy: 'r2',
    })).rejects.toMatchObject({ code: 'MEDIA_PREFIX_REQUIRED' });
  });
});
