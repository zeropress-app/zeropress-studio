export type OperationsInitiator = {
  userId: string;
  userEmail: string;
};

export function operationsInitiatorMetadata(
  initiator: OperationsInitiator | null | undefined,
): Record<string, string> {
  return initiator
    ? {
        initiated_by_user_id: initiator.userId,
        initiated_by_user_email: initiator.userEmail,
      }
    : {};
}

export function parseStoredOperationsInitiator(input: {
  userId: unknown;
  userEmail: unknown;
}): OperationsInitiator | null {
  if (input.userId === null && input.userEmail === null) return null;
  if (
    typeof input.userId !== 'string'
    || !/^[0-9a-f]{32}$/u.test(input.userId)
    || typeof input.userEmail !== 'string'
    || input.userEmail.length < 3
    || input.userEmail.length > 254
    || input.userEmail !== input.userEmail.trim()
    || input.userEmail !== input.userEmail.toLowerCase()
  ) {
    throw new TypeError('The stored operations initiator is malformed.');
  }
  return {
    userId: input.userId,
    userEmail: input.userEmail,
  };
}
