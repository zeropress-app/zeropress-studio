import zxcvbn from 'zxcvbn';

export function estimateZxcvbnScore(
  password: string,
  userInputs: string[],
): number {
  return zxcvbn(password, userInputs).score;
}
