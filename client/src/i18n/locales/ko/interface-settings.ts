export const interfaceSettings = {
  documentTitle: 'Studio 인터페이스 — ZeroPress Studio',
  kicker: 'STUDIO 관리',
  title: 'Studio 인터페이스',
  description: 'Studio에서 사용할 언어를 선택하세요. 공개 사이트의 언어와는 별개입니다.',
  loading: {
    title: '인터페이스 설정을 불러오는 중',
    description: '사용 가능한 언어와 기본 언어를 불러옵니다.',
  },
  loadError: {
    title: '인터페이스 설정을 불러올 수 없습니다',
    description: '현재 조직 언어 정책은 변경되지 않았습니다.',
  },
  fields: {
    defaultLocale: {
      title: '기본 언어',
      description: '저장된 선택과 브라우저 언어를 사용할 수 없을 때 적용합니다.',
      label: '기본 언어',
    },
    enabledLocales: {
      title: '사용 가능한 언어',
      description: '사용자가 선택할 수 있는 언어입니다. 기본 언어는 활성 상태로 유지하세요.',
      legend: '활성화된 Studio 인터페이스 언어',
      defaultBadge: '기본값',
    },
  },
  state: {
    saved: 'Studio 인터페이스 설정을 저장했습니다.',
    validation: '언어를 하나 이상 활성화하고 기본 언어를 활성 상태로 유지해 주세요.',
    lastSaved: '마지막 저장 {{date}}',
  },
  conflict: {
    title: '다른 곳에서 인터페이스 설정이 변경되었습니다',
    description: '다시 변경하기 전에 최신 설정을 불러와 주세요.',
    reload: '최신 설정 불러오기',
  },
  errors: {
    forbidden: '현재 계정은 Studio 인터페이스 설정을 관리할 수 없습니다.',
    timeout: '요청 시간이 초과되었습니다. 저장된 설정은 변경되지 않았습니다.',
    network: 'Studio가 설정 API에 연결하지 못했습니다.',
    invalidResponse: 'Studio가 올바르지 않은 인터페이스 설정 응답을 받았습니다.',
    api: '인터페이스 설정을 저장하지 못했습니다.',
  },
  actions: {
    save: '인터페이스 설정 저장',
  },
} as const;
