export const common = {
  language: {
    label: 'Language',
    english: 'English',
    korean: '한국어',
  },
  /**
   * Appearance. `system` follows the operating system and is the default, so it
   * is a choice rather than the absence of one.
   */
  theme: {
    label: 'Appearance',
    system: 'System',
    light: 'Light',
    dark: 'Dark',
    useLight: 'Use light appearance',
    useDark: 'Use dark appearance',
  },
  /**
   * Notice tone announcements. These are read by assistive technology so a
   * notice does not rely on color alone. They label the kind of message, not
   * its content, so they must never repeat the notice title.
   */
  notice: {
    info: 'Information:',
    success: 'Success:',
    warning: 'Warning:',
    error: 'Error:',
  },
  toast: {
    regionLabel: 'Notifications',
    close: 'Close notification',
  },
  workerConfiguration: {
    kind: {
      plainVariable: 'Plain variable',
      workerSecret: 'Secret',
      resourceBinding: 'Binding',
    },
    storageGuidance: 'Store values labeled Secret in Cloudflare Secrets, not plaintext Variables. Store values labeled Plain variable in Variables.',
  },
  mfa: {
    authenticatorTitle: 'Connect an authenticator app',
    authenticatorDescription: 'Scan the QR code with an authenticator app, or enter the setup key manually.',
    qrAlt: 'Authenticator setup QR code',
    qrUnavailable: 'The QR code could not be generated. Use the manual setup key.',
    manualKey: 'Manual setup key',
    manualKeyHint: 'Keep this key private. It grants access to future verification codes.',
    totpCode: 'Current 6-digit authenticator code',
  },
} as const;
