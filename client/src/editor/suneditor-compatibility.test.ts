// @vitest-environment jsdom

import { describe, expect, it } from 'vitest';
import {
  CONTENT_EDITOR_VISUAL_MAX_CODE_UNITS,
  CONTENT_EDITOR_VISUAL_MAX_NODES,
} from '../../../contracts/content-editor';
import {
  canonicalizeSunEditorHtml,
  classifySunEditorHtml,
  equivalentVisualHtml,
  prepareNetworkInertSunEditorHtml,
} from './suneditor-compatibility';
import {
  isAllowedContentUrl,
  normalizeLinkRel,
  normalizeLinkTarget,
} from './visual-html-policy';

describe('SunEditor visual HTML profile', () => {
  it('round-trips the reviewed WordPress and native media structures', () => {
    const source = [
      '<a href="https://example.com/full" target="_blank"><img src="/media/photo.png" alt="Photo" width="640" height="360"></a>',
      '<pre class="spec">CPU: <a href="https://example.com/cpu">Intel Xeon</a></pre>',
      '<table><tr><th align="left">Name</th><th>Type</th></tr><tr><td colspan="2">Value</td></tr></table>',
      '<figure class="hero"><img src="https://media.example/hero.jpg" alt="Hero"><figcaption>Caption</figcaption></figure>',
      '<iframe src="https://player.example/embed/1" width="560" height="315" allowfullscreen title="Player"></iframe>',
      '<video controls poster="/media/poster.jpg" preload="metadata"><source src="/media/movie.mp4" type="video/mp4"><track src="/media/captions.vtt" kind="captions" srclang="en" default></video>',
      '<audio controls><source src="/media/audio.mp3" type="audio/mpeg"></audio>',
    ].join('');

    const result = classifySunEditorHtml(source);

    expect(result.compatible, JSON.stringify(result)).toBe(true);
    if (!result.compatible) return;
    expect(result.canonicalHtml).toContain(
      '<a href="https://example.com/full" target="_blank" rel="noopener noreferrer"',
    );
    expect(result.canonicalHtml).toContain('<pre class="spec">CPU: ');
    expect(result.canonicalHtml).toContain('<table');
    expect(result.canonicalHtml).toContain('<figure class="hero">');
    expect(result.canonicalHtml).toContain('<iframe');
    expect(result.canonicalHtml).toContain('<video');
    expect(result.canonicalHtml).toContain('<audio');
    expect(classifySunEditorHtml(result.canonicalHtml)).toMatchObject({
      compatible: true,
      canonicalHtml: result.canonicalHtml,
      normalized: false,
    });
  });

  it('reports the visual representation of an image paragraph', () => {
    const result = classifySunEditorHtml('<p><img src="/photo.png" alt="Photo"></p>');
    expect(result, JSON.stringify(result)).toMatchObject({
      compatible: true,
    });
    if (result.classification === 'blocked') return;
    expect(result.canonicalHtml).toContain('<img');
    // This assertion records whether the profile can preserve WordPress\'s
    // harmless paragraph wrapper around a standalone image.
    expect(result.canonicalHtml).toContain('<p>');
  });

  it('preserves WordPress image alignment classes as visual content', () => {
    for (const alignment of [
      'alignnone',
      'alignleft',
      'aligncenter',
      'alignright',
    ]) {
      const result = classifySunEditorHtml(
        `<img class="wp-image-7 ${alignment}" src="/photo.png" alt="Photo">`,
      );
      expect(result, JSON.stringify(result)).toMatchObject({
        compatible: true,
      });
      if (result.classification === 'blocked') continue;
      expect(result.canonicalHtml).toContain(
        `class="wp-image-7 ${alignment}"`,
      );
    }
  });

  it('keeps browser parsing network-inert while restoring resource URLs', () => {
    const source = [
      '<div id="__zeropress_inert_resource_0__"></div>',
      '<p><img id="hero-image" src="https://assets.example/photo.jpg" srcset="https://assets.example/photo-2x.jpg 2x" alt="Photo"></p>',
      '<iframe src="https://embed.example/player/1" title="Player"></iframe>',
      '<video src="https://assets.example/movie.mp4" poster="https://assets.example/poster.jpg" controls></video>',
      '<span style="color:#f00; background-image:url(https://styles.example/tracker.png)">Styled</span>',
      '<link rel="stylesheet" href="https://styles.example/content.css">',
      '<object data="https://objects.example/file.bin"></object>',
      '<style>@import url(https://styles.example/import.css)</style>',
    ].join('');
    const prepared = prepareNetworkInertSunEditorHtml(source);
    expect(prepared.html).not.toContain('https://assets.example/');
    expect(prepared.html).not.toContain('https://embed.example/');
    expect(prepared.html).not.toContain('https://styles.example/');
    expect(prepared.html).not.toContain('https://objects.example/');
    expect(prepared.html).toContain('data:image/gif;base64,');

    const result = classifySunEditorHtml(source);
    expect(result, JSON.stringify(result)).toMatchObject({
      classification: 'review_required',
      reasons: [
        'unsupported_elements_removed',
        'unsupported_attributes_removed',
      ],
    });
    if (result.classification === 'blocked') return;
    expect(result.canonicalHtml).toContain('https://assets.example/photo.jpg');
    expect(result.canonicalHtml).toContain('id="__zeropress_inert_resource_0__"');
    expect(result.canonicalHtml).toContain('id="hero-image"');
    expect(result.canonicalHtml).toContain('https://assets.example/photo-2x.jpg 2x');
    expect(result.canonicalHtml).toContain('https://embed.example/player/1');
    expect(result.canonicalHtml).toContain('https://assets.example/movie.mp4');
    expect(result.canonicalHtml).toContain('https://assets.example/poster.jpg');
    expect(result.canonicalHtml).toContain('color: rgb(255,0,0)');
    expect(result.canonicalHtml).not.toContain('background-image');
    expect(result.canonicalHtml).not.toContain(
      'id="__zeropress_inert_resource_1__"',
    );
    expect(result.canonicalHtml).not.toContain('data:image/gif;base64,');
  });

  it('removes executable markup, event/style attributes, and unsafe URLs', () => {
    const canonical = canonicalizeSunEditorHtml([
      '<p class="safe" style="color:red" onclick="attack()">Text ',
      '<a href="javascript:attack()" target="evil">link</a>',
      '<img src="data:text/html,attack" onerror="attack()" alt="Image">',
      '</p><script>attack()</script><style>.attack{display:block}</style>',
    ].join(''));

    expect(canonical).toContain('class="safe"');
    expect(canonical).not.toMatch(/style=|onclick=|onerror=/u);
    expect(canonical).not.toMatch(/javascript:|data:/u);
    expect(canonical).not.toMatch(/<script|<style/u);
  });

  it('uses contract URL and new-window rel policy', () => {
    expect(isAllowedContentUrl('/docs/start', 'link')).toBe(true);
    expect(isAllowedContentUrl('https://example.com/path', 'media')).toBe(true);
    expect(isAllowedContentUrl('mailto:author@example.com', 'link')).toBe(true);
    expect(isAllowedContentUrl('tel:+821012345678', 'link')).toBe(true);
    expect(isAllowedContentUrl('mailto:author@example.com', 'media')).toBe(false);
    expect(isAllowedContentUrl('//example.com/path', 'link')).toBe(false);
    expect(isAllowedContentUrl('javascript:alert(1)', 'link')).toBe(false);
    expect(isAllowedContentUrl('https://user:secret@example.com', 'media')).toBe(false);
    expect(normalizeLinkTarget('_BLANK')).toBe('_blank');
    expect(normalizeLinkRel('ugc unsafe noopener', '_blank'))
      .toBe('ugc noopener noreferrer');
  });

  it('treats required new-window rel tokens as a safe additive normalization', () => {
    const result = classifySunEditorHtml(
      '<p><a href="https://example.com" target="_blank" rel="noopener">Example</a></p>',
    );

    expect(result).toMatchObject({
      classification: 'safe',
      compatible: true,
      reasons: [],
    });
    expect(result.canonicalHtml).toContain(
      'target="_blank" rel="noopener noreferrer"',
    );
  });

  it('preserves the bounded paragraph alignment and text color contract', () => {
    const source = [
      '<h2 style="text-align: RIGHT"><span style="color: RGB(255, 0, 0)">Heading</span></h2>',
      '<p style="text-align: justify"><span style="color: #C2410C">Body</span></p>',
    ].join('');
    const result = classifySunEditorHtml(source);

    expect(result).toMatchObject({
      classification: 'safe',
      compatible: true,
      reasons: [],
    });
    if (result.classification === 'blocked') return;
    expect(result.canonicalHtml).toContain('text-align: right');
    expect(result.canonicalHtml).toContain('color: rgb(255,0,0)');
    expect(result.canonicalHtml).toContain('text-align: justify');
    expect(result.canonicalHtml).toContain('color: rgb(194,65,12)');
  });

  it('requires review when only unsupported presentation markup is removed', () => {
    const result = classifySunEditorHtml(
      '<p style="text-align:center; margin-left: 2rem"><span style="color:#f00; background-color:#000">Text</span></p><!-- editorial note -->',
    );

    expect(result).toMatchObject({
      classification: 'review_required',
      compatible: false,
      normalized: true,
      reasons: [
        'unsupported_elements_removed',
        'unsupported_attributes_removed',
      ],
    });
    if (result.classification === 'blocked') return;
    expect(result.canonicalHtml).toContain('text-align: center');
    expect(result.canonicalHtml).toContain('color: rgb(255,0,0)');
    expect(result.canonicalHtml).not.toMatch(/margin-left|background-color/u);
  });

  it('classifies empty HTML canonically and enforces both visual limits', () => {
    expect(canonicalizeSunEditorHtml('<p></p>')).toBe('');
    expect(classifySunEditorHtml('<p></p>')).toMatchObject({
      classification: 'safe',
      compatible: true,
      canonicalHtml: '',
    });

    expect(classifySunEditorHtml(
      'x'.repeat(CONTENT_EDITOR_VISUAL_MAX_CODE_UNITS + 1),
    )).toMatchObject({
      classification: 'blocked',
      compatible: false,
      reasons: ['source_too_large'],
    });

    const paragraphCount = Math.ceil(CONTENT_EDITOR_VISUAL_MAX_NODES / 2);
    expect(classifySunEditorHtml('<p>x</p>'.repeat(paragraphCount))).toMatchObject({
      classification: 'blocked',
      compatible: false,
      reasons: expect.arrayContaining(['node_limit_exceeded']),
    });
  });
});

describe('equivalent visual HTML', () => {
  it('ignores attribute order, supported CSS serialization and block indentation', () => {
    const original = '<p><span style="color: rgb(0, 0, 255);">Text</span></p><img src="/image.png" alt="Photo" width="30" height="20">';
    const result = classifySunEditorHtml(original);
    expect(result.classification).toBe('safe');
    expect(equivalentVisualHtml(original, result.canonicalHtml!)).toBe(true);
    expect(equivalentVisualHtml('<ol><li><p>Item</p></li></ol>', '<ol>\n  <li>\n    <p>Item</p>\n  </li>\n</ol>')).toBe(true);
  });

  it.each([
    ['<p><b>Text</b></p>', '<p><strong>Text</strong></p>'],
    ['<p>Before <strong>bold</strong></p>', '<p>Before<strong>bold</strong></p>'],
    ['<a href="/a">A</a> <a href="/b">B</a>', '<a href="/a">A</a><a href="/b">B</a>'],
    ['<pre> a\n b</pre>', '<pre>a\nb</pre>'],
    ['<pre><div> <p>A</p> </div></pre>', '<pre><div><p>A</p></div></pre>'],
    ['<p><span>A</span>B</p>', '<p>A<span>B</span></p>'],
    ['<img src="/a" alt="Image">', '<img src="/b" alt="Image">'],
  ])('keeps meaningful structure, text and resource changes reviewable: %s', (before, after) => {
    expect(equivalentVisualHtml(before, after)).toBe(false);
  });
});
