import { Fragment } from 'react';
import type { ContentSearchMatch } from '../../../contracts/content-search';

export function ContentSearchMatchContext(input: {
  match: ContentSearchMatch;
  label: string;
}) {
  const segments: Array<{
    text: string;
    highlighted: boolean;
    key: string;
  }> = [];
  let cursor = 0;
  for (const [index, range] of input.match.highlights.entries()) {
    if (range.start > cursor) {
      segments.push({
        text: input.match.text.slice(cursor, range.start),
        highlighted: false,
        key: `plain-${index}`,
      });
    }
    segments.push({
      text: input.match.text.slice(range.start, range.end),
      highlighted: true,
      key: `mark-${index}`,
    });
    cursor = range.end;
  }
  if (cursor < input.match.text.length) {
    segments.push({
      text: input.match.text.slice(cursor),
      highlighted: false,
      key: 'plain-final',
    });
  }

  return (
    <p className="content-list-search-match" aria-label={input.label}>
      {segments.map((segment) => (
        <Fragment key={segment.key}>
          {segment.highlighted
            ? <mark>{segment.text}</mark>
            : segment.text}
        </Fragment>
      ))}
    </p>
  );
}
