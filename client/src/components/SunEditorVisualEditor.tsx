import {
  forwardRef, useEffect, useImperativeHandle, useRef, useState,
} from 'react';
import { useTranslation } from 'react-i18next';
import 'suneditor/css/editor';
import 'suneditor/css/contents';
import {
  CONTENT_EDITOR_VISUAL_MAX_CODE_UNITS, CONTENT_EDITOR_VISUAL_MAX_NODES,
} from '../../../contracts/content-editor';
import type { Media } from '../../../contracts/media';
import { Button, Dialog, Field, Notice } from './primitives';
import { contentMediaSource, createContentMediaSnippet } from '../lib/content-media-insertion';
import { destroySunEditor, suneditor, sunEditorOptions } from '../editor/suneditor-runtime';
import { countVisualHtmlNodes, sanitizeVisualHtml } from '../editor/suneditor-compatibility';
import { imageAlignmentFromClass, imageClassWithAlignment, isAllowedContentUrl, normalizeLinkRel } from '../editor/visual-html-policy';
import {
  exportVisualDocument, prepareVisualDocument, selectionNode, selectionPoint,
} from '../editor/visual-editor-document';
import type { VisualContentAiSelection } from '../editor/content-ai-selection';

export type SunEditorVisualEditorHandle = {
  flush: () => string;
  insertMedia: (media: Media) => boolean;
  replaceSelectedImage: (media: Media) => boolean;
  focus: () => void;
  captureAiSelection: () => VisualContentAiSelection | null;
  buildAiCandidate: (selection: VisualContentAiSelection, replacement: string) => string | null;
};

export const SunEditorVisualEditor = forwardRef<SunEditorVisualEditorHandle, {
  content: string;
  disabled?: boolean;
  onChange: (content: string) => void;
  onDirty: () => void;
  onRequestMedia: (mode: 'insert' | 'replace-image') => void;
}>(function SunEditorVisualEditor(input, ref) {
  const { t, i18n } = useTranslation('contentEditor');
  const hostRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<SunEditor.Instance | null>(null);
  const surfaceRef = useRef<HTMLElement | null>(null);
  const inputRef = useRef(input);
  inputRef.current = input;
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const embedsRef = useRef(new Map<string, string>());
  const acceptedRef = useRef({ html: '', raw: '', authored: input.content });
  const loadedContentRef = useRef(input.content);
  const selectedImageRef = useRef<HTMLImageElement | null>(null);
  const savedRangeRef = useRef<Range | null>(null);
  const [imageSelected, setImageSelected] = useState(false);
  const [limitRejected, setLimitRejected] = useState(false);
  const [failure, setFailure] = useState(false);
  const [linkDraft, setLinkDraft] = useState<{ url: string; title: string; newWindow: boolean } | null>(null);
  const [linkInvalid, setLinkInvalid] = useState(false);

  function cancelTimer() {
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = null;
  }

  function prepareImageControls() {
    surfaceRef.current?.querySelectorAll('img').forEach((image) => { image.tabIndex = 0; });
  }

  function captureChange(): boolean {
    const surface = surfaceRef.current;
    if (!surface || inputRef.current.disabled) return false;
    prepareImageControls();
    const html = exportVisualDocument(surface.innerHTML, embedsRef.current);
    const before = acceptedRef.current;
    if (html === before.html) return false;
    if (html.length > CONTENT_EDITOR_VISUAL_MAX_CODE_UNITS
      || countVisualHtmlNodes(html) > CONTENT_EDITOR_VISUAL_MAX_NODES) {
      surface.innerHTML = before.raw;
      setLimitRejected(true);
      return false;
    }
    acceptedRef.current = { html, raw: surface.innerHTML, authored: html };
    setLimitRejected(false);
    inputRef.current.onDirty();
    cancelTimer();
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      inputRef.current.onChange(acceptedRef.current.authored);
    }, 300);
    return true;
  }

  function flush(): string {
    captureChange();
    cancelTimer();
    const html = acceptedRef.current.authored;
    if (html !== inputRef.current.content) inputRef.current.onChange(html);
    return html;
  }

  function synchronizeReadonly() {
    const disabled = Boolean(inputRef.current.disabled);
    editorRef.current?.$.ui.readOnly(disabled);
    surfaceRef.current?.setAttribute('contenteditable', disabled ? 'false' : 'true');
    surfaceRef.current?.setAttribute('aria-readonly', String(disabled));
  }

  function loadContent(content: string) {
    const editor = editorRef.current;
    const surface = surfaceRef.current;
    if (!editor || !surface) return;
    cancelTimer();
    embedsRef.current.clear();
    editor.$.html.set(prepareVisualDocument(content, embedsRef.current));
    editor.$.history.reset();
    loadedContentRef.current = content;
    acceptedRef.current = {
      html: exportVisualDocument(surface.innerHTML, embedsRef.current),
      raw: surface.innerHTML, authored: content,
    };
    selectedImageRef.current = null;
    savedRangeRef.current = null;
    setImageSelected(false);
    prepareImageControls();
    synchronizeReadonly();
  }

  useEffect(() => {
    const host = hostRef.current!;
    const target = document.createElement('div');
    host.append(target);
    let disposed = false;
    let initialized = false;
    const editor = suneditor.create(target, {
      ...sunEditorOptions(i18n.resolvedLanguage), value: '',
      events: {
        onChange: () => { if (initialized && !disposed) captureChange(); },
      },
    });
    if (!editor.$) {
      setFailure(true);
      target.remove();
      return;
    }
    editorRef.current = editor;
    const surface = editor.$.frameContext.get('wysiwyg') as HTMLElement;
    surfaceRef.current = surface;
    surface.classList.add('studio-visual-editor-surface');
    surface.setAttribute('role', 'textbox');
    surface.setAttribute('aria-label', t('contentLabel'));
    surface.setAttribute('aria-multiline', 'true');
    const content = inputRef.current.content === loadedContentRef.current
      ? acceptedRef.current.authored : inputRef.current.content;
    loadContent(content);
    if (content !== inputRef.current.content) inputRef.current.onChange(content);
    initialized = true;

    const rememberSelection = () => {
      const selection = document.getSelection();
      if (selection?.rangeCount) {
        const range = selection.getRangeAt(0);
        if (surface.contains(range.commonAncestorContainer)) savedRangeRef.current = range.cloneRange();
      }
    };
    const click = (event: Event) => {
      const target = event.target instanceof Element ? event.target : null;
      if (inputRef.current.disabled && target?.closest('a')
        && (!(event instanceof KeyboardEvent) || event.key === 'Enter')) {
        event.preventDefault();
        event.stopPropagation();
      }
      if (inputRef.current.disabled) { event.stopImmediatePropagation(); return; }
      const imageKey = target instanceof HTMLImageElement
        && event instanceof KeyboardEvent && ['Enter', ' '].includes(event.key);
      if (event.type === 'click' || imageKey) {
        selectedImageRef.current?.removeAttribute('data-studio-selected');
        selectedImageRef.current = target instanceof HTMLImageElement ? target : null;
        selectedImageRef.current?.setAttribute('data-studio-selected', '');
        if (selectedImageRef.current) {
          event.preventDefault(); event.stopImmediatePropagation();
          const range = document.createRange();
          range.selectNode(selectedImageRef.current);
          surface.focus();
          editor.$.selection.setRange(range);
          savedRangeRef.current = range.cloneRange();
        }
        setImageSelected(Boolean(selectedImageRef.current));
      }
    };
    const inputEvent = () => { captureChange(); };
    const paste = (event: ClipboardEvent) => {
      event.preventDefault();
      event.stopImmediatePropagation();
      if (inputRef.current.disabled || !event.clipboardData) return;
      const raw = event.clipboardData.getData('text/html');
      const plain = event.clipboardData.getData('text/plain');
      const escaped = document.createElement('div');
      escaped.textContent = plain;
      const html = raw || escaped.innerHTML.replace(/\n/gu, '<br>');
      if (html.length > CONTENT_EDITOR_VISUAL_MAX_CODE_UNITS
        || countVisualHtmlNodes(html) > CONTENT_EDITOR_VISUAL_MAX_NODES) {
        setLimitRejected(true);
        return;
      }
      editor.$.html.insert(prepareVisualDocument(html, embedsRef.current));
      captureChange();
    };
    surface.addEventListener('input', inputEvent);
    surface.addEventListener('click', click, true);
    surface.addEventListener('auxclick', click, true);
    surface.addEventListener('keydown', click, true);
    surface.addEventListener('paste', paste, true);
    // The Media library owns file uploads. Native drops must not create data URLs.
    const drop = (event: DragEvent) => {
      if (event.dataTransfer?.files.length) { event.preventDefault(); event.stopImmediatePropagation(); }
    };
    surface.addEventListener('drop', drop, true);
    document.addEventListener('selectionchange', rememberSelection);
    // Toolbar commands may not emit input, and SunEditor's onChange is delayed.
    // Mark them dirty before a save or source-mode switch can use stale content.
    const observer = new MutationObserver(() => {
      if (initialized && !disposed) captureChange();
    });
    observer.observe(surface, {
      childList: true, subtree: true, characterData: true, attributes: true,
      attributeFilter: ['style', 'class', 'href', 'src', 'alt', 'title', 'target', 'rel',
        'srcset', 'sizes', 'width', 'height', 'colspan', 'rowspan', 'align'],
    });
    return () => {
      disposed = true;
      observer.disconnect();
      cancelTimer();
      document.removeEventListener('selectionchange', rememberSelection);
      surface.removeEventListener('input', inputEvent);
      surface.removeEventListener('click', click, true);
      surface.removeEventListener('auxclick', click, true);
      surface.removeEventListener('keydown', click, true);
      surface.removeEventListener('paste', paste, true);
      surface.removeEventListener('drop', drop, true);
      editorRef.current = null;
      surfaceRef.current = null;
      host.replaceChildren();
      destroySunEditor(editor);
    };
  }, [i18n.resolvedLanguage]);

  useEffect(() => { synchronizeReadonly(); }, [input.disabled]);
  useEffect(() => {
    if (input.content !== loadedContentRef.current && input.content !== acceptedRef.current.authored) {
      loadContent(input.content);
    }
  }, [input.content]);

  function restoreSelection() {
    const surface = surfaceRef.current;
    if (!surface) return;
    surface.focus();
    if (savedRangeRef.current && surface.contains(savedRangeRef.current.commonAncestorContainer)) {
      editorRef.current?.$.selection.setRange(savedRangeRef.current);
    }
  }

  function insertMedia(media: Media): boolean {
    const editor = editorRef.current;
    if (!editor || inputRef.current.disabled) return false;
    restoreSelection();
    editor.$.html.insert(prepareVisualDocument(
      createContentMediaSnippet(media, 'html'), embedsRef.current,
    ));
    const changed = captureChange();
    flush();
    return changed;
  }

  function replaceSelectedImage(media: Media): boolean {
    const image = selectedImageRef.current;
    if (inputRef.current.disabled || media.kind !== 'image' || !image || !surfaceRef.current?.contains(image)) return false;
    image.src = contentMediaSource(media);
    image.alt = media.alt;
    image.removeAttribute('srcset');
    image.removeAttribute('sizes');
    for (const name of ['width', 'height'] as const) {
      if (media[name] === null) image.removeAttribute(name);
      else image.setAttribute(name, String(media[name]));
    }
    image.loading = 'lazy';
    image.decoding = 'async';
    const changed = captureChange();
    editorRef.current?.$.history.push(false);
    flush();
    return changed;
  }

  function captureAiSelection(): VisualContentAiSelection | null {
    const root = surfaceRef.current;
    const range = savedRangeRef.current;
    if (!root || !range || range.collapsed || !root.contains(range.commonAncestorContainer)) return null;
    const selected = document.createElement('div');
    selected.append(range.cloneContents());
    const selectedContent = exportVisualDocument(selected.innerHTML, embedsRef.current);
    if (!selectedContent.trim()) return null;
    const before = range.cloneRange(); before.selectNodeContents(root); before.setEnd(range.startContainer, range.startOffset);
    const after = range.cloneRange(); after.selectNodeContents(root); after.setStart(range.endContainer, range.endOffset);
    return {
      kind: 'visual', baseContent: flush(), baseHtml: root.innerHTML,
      selectedContent,
      selectionKind: selected.querySelector('p,h1,h2,h3,h4,h5,h6,li,table,div,blockquote,pre') ? 'block' : 'inline',
      contextBefore: Array.from(before.toString()).slice(-2_000).join(''),
      contextAfter: Array.from(after.toString()).slice(0, 2_000).join(''),
      start: selectionPoint(root, range.startContainer, range.startOffset),
      end: selectionPoint(root, range.endContainer, range.endOffset),
    };
  }

  function buildAiCandidate(selection: VisualContentAiSelection, replacement: string): string | null {
    const root = surfaceRef.current;
    if (!root || flush() !== selection.baseContent || root.innerHTML !== selection.baseHtml) return null;
    try {
      const copy = root.cloneNode(true) as HTMLElement;
      const range = document.createRange();
      range.setStart(selectionNode(copy, selection.start), selection.start.offset);
      range.setEnd(selectionNode(copy, selection.end), selection.end.offset);
      range.deleteContents();
      if (selection.selectionKind === 'inline') range.insertNode(document.createTextNode(replacement));
      else {
        const template = document.createElement('template');
        template.innerHTML = prepareVisualDocument(sanitizeVisualHtml(replacement), embedsRef.current);
        range.insertNode(template.content);
      }
      return exportVisualDocument(copy.innerHTML, embedsRef.current);
    } catch { return null; }
  }

  useImperativeHandle(ref, () => ({
    flush, insertMedia, replaceSelectedImage, captureAiSelection, buildAiCandidate,
    focus: () => restoreSelection(),
  }));

  if (failure) throw new Error('The visual editor could not initialize.');
  return (
    <div className="studio-visual-editor">
      <div className="studio-visual-media-tools" role="group" aria-label={t('toolbarLabel')}>
        <Button type="button" size="sm" disabled={input.disabled} onClick={() => input.onRequestMedia('insert')}>{t('insertMedia')}</Button>
        {imageSelected ? <>
          <Button type="button" size="sm" disabled={input.disabled} onClick={() => input.onRequestMedia('replace-image')}>{t('replaceImage')}</Button>
          <Button type="button" size="sm" disabled={input.disabled} onClick={() => {
            const anchor = selectedImageRef.current?.closest('a');
            setLinkInvalid(false);
            setLinkDraft({ url: anchor?.getAttribute('href') ?? '', title: anchor?.title ?? '', newWindow: anchor?.target === '_blank' });
          }}>{t('imageLink.edit')}</Button>
          <Button type="button" size="sm" disabled={input.disabled || !selectedImageRef.current?.closest('a')} onClick={() => {
            const anchor = selectedImageRef.current?.closest('a');
            if (!anchor) return;
            anchor.replaceWith(...anchor.childNodes);
            captureChange(); editorRef.current?.$.history.push(false);
          }}>{t('imageLink.remove')}</Button>
          <div role="group" aria-label={t('imageAlignment.toolbarLabel')}>
            {(['none', 'left', 'center', 'right'] as const).map((alignment) => (
              <Button type="button" size="sm" key={alignment} disabled={input.disabled}
                aria-label={t(`imageAlignment.${alignment}`)}
                aria-pressed={(imageAlignmentFromClass(selectedImageRef.current?.className) ?? 'none') === alignment}
                onClick={() => {
                  const image = selectedImageRef.current;
                  if (!image) return;
                  image.className = imageClassWithAlignment(image.className, alignment) ?? '';
                  captureChange(); editorRef.current?.$.history.push(false);
                }}>{t(`imageAlignment.${alignment}`)}</Button>
            ))}
          </div>
        </> : null}
      </div>
      {limitRejected ? <Notice tone="warning">{t('limitRejected')}</Notice> : null}
      <div className="studio-visual-editor-content" ref={hostRef} />
      <Dialog open={linkDraft !== null} title={t('linkDialog.title')}
        description={t('linkDialog.description')} onClose={() => setLinkDraft(null)}
        actions={<>
          <Button type="button" variant="ghost" onClick={() => setLinkDraft(null)}>{t('linkDialog.cancel')}</Button>
          <Button type="button" variant="primary" onClick={() => {
            const image = selectedImageRef.current;
            if (!image || !linkDraft || inputRef.current.disabled) return;
            if (!isAllowedContentUrl(linkDraft.url, 'link')) { setLinkInvalid(true); return; }
            const anchor = image.closest('a') ?? document.createElement('a');
            anchor.setAttribute('href', linkDraft.url);
            if (linkDraft.newWindow) {
              anchor.target = '_blank'; anchor.rel = normalizeLinkRel(null, '_blank')!;
            } else { anchor.removeAttribute('target'); anchor.removeAttribute('rel'); }
            if (linkDraft.title.trim()) anchor.title = linkDraft.title.trim();
            else anchor.removeAttribute('title');
            if (!anchor.contains(image)) { image.replaceWith(anchor); anchor.append(image); }
            captureChange(); editorRef.current?.$.history.push(false);
            setLinkDraft(null);
          }}>{t('linkDialog.apply')}</Button>
        </>}
      >
        {linkDraft ? <>
          <Field label={t('linkDialog.url')}>{(control) => <input {...control} value={linkDraft.url} onChange={(event) => setLinkDraft({ ...linkDraft, url: event.target.value })} />}</Field>
          <Field label={t('linkDialog.titleLabel')}>{(control) => <input {...control} value={linkDraft.title} onChange={(event) => setLinkDraft({ ...linkDraft, title: event.target.value })} />}</Field>
          <label><input type="checkbox" checked={linkDraft.newWindow} onChange={(event) => setLinkDraft({ ...linkDraft, newWindow: event.target.checked })} />{t('linkDialog.newWindow')}</label>
          {linkInvalid ? <Notice tone="error">{t('linkDialog.invalid')}</Notice> : null}
        </> : null}
      </Dialog>
    </div>
  );
});
