// Synthetic, distributable WordPress patterns; never a private site export.
function content(id: number, type: 'post' | 'page', body: string, parent = 0) {
  return `<item><title>Fixture ${type} ${id}</title><dc:creator>fixture-author</dc:creator>
    <content:encoded><![CDATA[${body}]]></content:encoded>
    <wp:post_id>${id}</wp:post_id><wp:post_type>${type}</wp:post_type>
    <wp:post_name>fixture-${id}</wp:post_name><wp:post_parent>${parent}</wp:post_parent>
    <wp:post_date_gmt>2026-07-01 01:02:03</wp:post_date_gmt>
    <wp:post_modified_gmt>2026-07-02 01:02:03</wp:post_modified_gmt>
    <wp:status>publish</wp:status><wp:comment_status>open</wp:comment_status>
    <category domain="category" nicename="notes">Notes</category>
    <category domain="post_tag" nicename="beta">Beta</category>
    <wp:postmeta><wp:meta_key>_thumbnail_id</wp:meta_key><wp:meta_value>90</wp:meta_value></wp:postmeta>
    ${id === 11 ? `<wp:comment><wp:comment_id>99</wp:comment_id>
      <wp:comment_author>PRIVATE_COMMENT_AUTHOR</wp:comment_author>
      <wp:comment_author_email>private-comment@example.test</wp:comment_author_email>
      <wp:comment_date_gmt>2026-07-03 01:02:03</wp:comment_date_gmt>
      <wp:comment_content>PRIVATE_COMMENT_BODY</wp:comment_content>
      <wp:comment_approved>1</wp:comment_approved><wp:comment_parent>0</wp:comment_parent>
    </wp:comment>` : ''}
  </item>`;
}

export const incompatibleHtml = '<picture><source srcset="/wide.png"><img src="/small.png" alt="Small"></picture>';

export const publicBetaWxr = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/"
  xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:wp="http://wordpress.org/export/1.2/">
  <channel><title>공개 Beta fixture</title><link>https://fixture.example.test</link>
    <language>ko-KR</language><wp:wxr_version>1.2</wp:wxr_version>
    <wp:author><wp:author_login>fixture-author</wp:author_login>
      <wp:author_display_name>Fixture author</wp:author_display_name></wp:author>
    <wp:category><wp:category_nicename>notes</wp:category_nicename><wp:cat_name>Notes</wp:cat_name></wp:category>
    <wp:tag><wp:tag_slug>beta</wp:tag_slug><wp:tag_name>Beta</wp:tag_name></wp:tag>
    <wp:term><wp:term_id>70</wp:term_id><wp:term_slug>primary</wp:term_slug>
      <wp:term_name>Primary</wp:term_name><wp:term_taxonomy>nav_menu</wp:term_taxonomy></wp:term>
    <item><title>Hero image</title><wp:post_id>90</wp:post_id><wp:post_type>attachment</wp:post_type>
      <wp:status>inherit</wp:status><wp:attachment_url>https://fixture.example.test/uploads/hero.jpg</wp:attachment_url></item>
    ${content(11, 'post', '<p>한글 🌱 and English</p>')}
    ${content(12, 'post', incompatibleHtml)}
    ${content(22, 'page', '<p>Child page</p>', 21)}
    ${content(21, 'page', '<p>Parent page</p>')}
    <item><title>Fixture post link</title><category domain="nav_menu" nicename="primary">Primary</category>
      <wp:post_id>100</wp:post_id><wp:post_type>nav_menu_item</wp:post_type><wp:status>publish</wp:status>
      <wp:menu_order>1</wp:menu_order>
      <wp:postmeta><wp:meta_key>_menu_item_type</wp:meta_key><wp:meta_value>post_type</wp:meta_value></wp:postmeta>
      <wp:postmeta><wp:meta_key>_menu_item_object</wp:meta_key><wp:meta_value>post</wp:meta_value></wp:postmeta>
      <wp:postmeta><wp:meta_key>_menu_item_object_id</wp:meta_key><wp:meta_value>11</wp:meta_value></wp:postmeta>
    </item>
  </channel>
</rss>`;
