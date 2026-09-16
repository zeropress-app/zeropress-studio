import { Callout } from '../components/primitives';

export function OperationsUnavailable(input: {
  title: string;
  children: string;
}) {
  return (
    <Callout tone="info" title={input.title}>
      {input.children}
    </Callout>
  );
}
