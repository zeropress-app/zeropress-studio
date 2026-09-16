export const preferences = {
  documentTitle: 'Studio 환경설정 · ZeroPress Studio',
  kicker: '개인 환경',
  title: 'Studio 환경설정',
  description: '이 브라우저에서 사용할 Studio 환경을 설정하세요.',
  language: {
    title: '인터페이스 언어',
    description: 'Studio 관리 화면에 사용할 언어를 선택합니다.',
    label: 'Studio 인터페이스 언어',
    hint: '이 브라우저에만 적용됩니다. 공개 사이트의 언어는 바뀌지 않습니다.',
    managed: {
      title: '이 Studio에서 언어를 관리합니다',
      description: '관리자가 현재 활성화한 인터페이스 언어는 {{language}} 하나입니다.',
    },
  },
} as const;
