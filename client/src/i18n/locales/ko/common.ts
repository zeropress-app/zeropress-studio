export const common = {
  language: {
    label: '언어',
    english: 'English',
    korean: '한국어',
  },
  /**
   * Appearance preference. system follows the OS and is the default; it is an explicit choice, not
   * an unset value.
   */
  theme: {
    label: '화면 밝기',
    system: '시스템',
    light: '라이트',
    dark: '다크',
    useLight: '라이트 화면 사용',
    useDark: '다크 화면 사용',
  },
  /**
   * Notice-category announcement for assistive technology so meaning does not depend on color.
   * Describes the category, not the content, and must not repeat the title.
   */
  notice: {
    info: '안내:',
    success: '완료:',
    warning: '주의:',
    error: '오류:',
  },
  toast: {
    regionLabel: '알림',
    close: '알림 닫기',
  },
  workerConfiguration: {
    kind: {
      plainVariable: '일반 변수',
      workerSecret: 'Secret',
      resourceBinding: 'Binding',
    },
    storageGuidance: 'Secret으로 표시된 값은 Cloudflare의 일반 변수(plaintext)가 아니라 Secret으로 저장하세요. 일반 변수로 표시된 값만 Variables에 저장합니다.',
  },
  mfa: {
    authenticatorTitle: '인증 앱 연결',
    authenticatorDescription: '인증 앱으로 QR 코드를 스캔하거나 설정 키를 직접 입력하세요.',
    qrAlt: '인증 앱 설정 QR 코드',
    qrUnavailable: 'QR 코드를 생성하지 못했습니다. 수동 설정 키를 사용해 주세요.',
    manualKey: '수동 설정 키',
    manualKeyHint: '이 키는 향후 인증 코드를 생성할 수 있으므로 비공개로 보관하세요.',
    totpCode: '현재 인증 앱의 6자리 코드',
  },
} as const;
