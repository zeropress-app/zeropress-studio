import type { CurrentPostContentSnapshot } from '../../../contracts/post-autosaves';
import type { CurrentPageContentSnapshot } from '../../../contracts/page-autosaves';
import { RevisionSourceComparison } from './RevisionSourceComparison';
import { DataTable } from './primitives';

export type NormalizedContentSnapshot =
  | CurrentPostContentSnapshot
  | CurrentPageContentSnapshot;

export type ContentSnapshotComparisonCopy = {
  comparison: string;
  metadataSame: string;
  content: string;
  contentSame: string;
  contentChanged: string;
  diffLabel: string;
  diffLoading: string;
  diffUnavailable: string;
  diffRetry: string;
  leftSource: string;
  rightSource: string;
  none: string;
  yes: string;
  no: string;
  fields: {
    title: string;
    slug: string;
    documentType: string;
    editorMode: string;
    excerpt: string;
    status: string;
    discoverability: string;
    allowComments: string;
    featuredImage: string;
    author: string;
    categories: string;
    tags: string;
    parent: string;
  };
};

type ComparisonField = {
  key: string;
  label: string;
  left: string;
  right: string;
  changed: boolean;
};

function snapshotFields(
  snapshot: NormalizedContentSnapshot,
  copy: ContentSnapshotComparisonCopy,
): Array<{
  key: string;
  label: string;
  value: string;
  comparisonValue?: string;
}> {
  const common = [
    { key: 'title', label: copy.fields.title, value: snapshot.draft.title },
    { key: 'slug', label: copy.fields.slug, value: snapshot.draft.slug },
    {
      key: 'document_type',
      label: copy.fields.documentType,
      value: snapshot.draft.document_type,
    },
    {
      key: 'editor_mode',
      label: copy.fields.editorMode,
      value: snapshot.draft.editor_mode,
    },
    { key: 'excerpt', label: copy.fields.excerpt, value: snapshot.draft.excerpt },
    { key: 'status', label: copy.fields.status, value: snapshot.draft.status },
    {
      key: 'discoverability',
      label: copy.fields.discoverability,
      value: snapshot.draft.discoverability,
    },
    {
      key: 'allow_comments',
      label: copy.fields.allowComments,
      value: snapshot.draft.allow_comments ? copy.yes : copy.no,
    },
    {
      key: 'featured_image',
      label: copy.fields.featuredImage,
      value: snapshot.references.featured_image?.filename ?? copy.none,
      comparisonValue: snapshot.draft.featured_image_id ?? '',
    },
  ];
  if (snapshot.content_type === 'post') {
    return [...common,
      {
        key: 'author',
        label: copy.fields.author,
        value: snapshot.references.author?.display_name ?? copy.none,
        comparisonValue: snapshot.draft.author_id,
      },
      {
        key: 'categories',
        label: copy.fields.categories,
        value: snapshot.references.categories.map((item) => item.name)
          .join(', ') || copy.none,
        comparisonValue: snapshot.draft.category_ids.join('\0'),
      },
      {
        key: 'tags',
        label: copy.fields.tags,
        value: snapshot.references.tags.map((item) => item.name)
          .join(', ') || copy.none,
        comparisonValue: snapshot.draft.tag_ids.join('\0'),
      },
    ];
  }
  return [...common, {
    key: 'parent',
    label: copy.fields.parent,
    value: snapshot.references.parent?.path ?? copy.none,
    comparisonValue: snapshot.draft.parent_id ?? '',
  }];
}

function comparisonFields(
  left: NormalizedContentSnapshot,
  right: NormalizedContentSnapshot,
  copy: ContentSnapshotComparisonCopy,
): ComparisonField[] {
  const rightValues = new Map(snapshotFields(right, copy).map((field) => (
    [field.key, field]
  )));
  return snapshotFields(left, copy).map((field) => {
    const rightField = rightValues.get(field.key);
    const leftComparison = field.comparisonValue ?? field.value;
    const rightComparison = rightField?.comparisonValue
      ?? rightField?.value
      ?? copy.none;
    return {
      key: field.key,
      label: field.label,
      left: field.value,
      right: rightField?.value ?? copy.none,
      changed: leftComparison !== rightComparison,
    };
  });
}

/**
 * Read-only comparison shared by saved revisions and recovery autosaves.
 * The caller owns every action; rendering this component never mutates either
 * snapshot or the canonical editor state.
 */
export function ContentSnapshotComparison(input: {
  left: NormalizedContentSnapshot;
  right: NormalizedContentSnapshot;
  leftLabel: string;
  rightLabel: string;
  comparisonKey: string;
  copy: ContentSnapshotComparisonCopy;
}) {
  const changedFields = comparisonFields(
    input.left,
    input.right,
    input.copy,
  ).filter((field) => field.changed);
  const contentChanged = input.left.draft.content !== input.right.draft.content;

  return (
    <div className="content-revision-comparison">
      <h3 className="content-revision-subheading">
        {input.copy.comparison}
      </h3>
      {changedFields.length === 0 ? (
        <p className="content-revision-state">
          {input.copy.metadataSame}
        </p>
      ) : (
        <DataTable caption={input.copy.comparison} minWidthPx={480}>
          <thead>
            <tr>
              <th scope="col" />
              <th scope="col">{input.leftLabel}</th>
              <th scope="col">{input.rightLabel}</th>
            </tr>
          </thead>
          <tbody>
            {changedFields.map((field) => (
              <tr key={field.key}>
                <th scope="row">{field.label}</th>
                <td>{field.left || input.copy.none}</td>
                <td>{field.right || input.copy.none}</td>
              </tr>
            ))}
          </tbody>
        </DataTable>
      )}
      <h3 className="content-revision-subheading">
        {input.copy.content}
      </h3>
      <p className="content-revision-state">
        {contentChanged
          ? input.copy.contentChanged
          : input.copy.contentSame}
      </p>
      <RevisionSourceComparison
        key={input.comparisonKey}
        copy={input.copy}
        original={input.left.draft.content}
        modified={input.right.draft.content}
        originalDocumentType={input.left.draft.document_type}
        modifiedDocumentType={input.right.draft.document_type}
        originalEditorMode={input.left.draft.editor_mode}
        modifiedEditorMode={input.right.draft.editor_mode}
        originalEditorProfile={input.left.draft.editor_profile}
        modifiedEditorProfile={input.right.draft.editor_profile}
      />
    </div>
  );
}
