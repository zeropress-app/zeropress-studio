export const outputSettings = {
  documentTitle: '표시 및 출력 — ZeroPress Studio',
  kicker: '사이트 구성',
  title: '표시 및 출력',
  description: '콘텐츠 표시 방식과 사이트 기능, 검색 엔진 노출을 설정하세요.',
  loading: {
    title: '출력 설정을 불러오는 중',
    description: 'Studio가 현재 출력 구성을 읽고 있습니다.',
  },
  loadError: {
    title: '출력 설정을 불러올 수 없습니다',
    description: '기존 설정은 변경되지 않았습니다.',
    retry: '다시 시도',
  },
  pagination: {
    title: '목록 및 날짜 표시',
    description: '페이지마다 표시할 글 수와 날짜·시간 형식을 선택하세요.',
  },
  features: {
    title: '사이트 기능',
    description: '테마에서 지원하는 사이트 기능을 활성화하세요.',
    menuNotice: 'RSS 또는 아카이브를 비활성화해도 메뉴에 저장된 링크는 자동으로 제거되지 않습니다.',
  },
  footer: {
    title: '푸터',
    description: '사이트 하단의 문구와 출처 표시입니다. 실제 배치는 테마에 따라 달라집니다.',
  },
  visibility: {
    title: '검색 노출 및 사이트 정보',
    description: '검색 엔진 색인과 ZeroPress 정보 표시 여부를 선택하세요.',
  },
  fields: {
    postsPerPage: {
      label: '페이지당 글 수',
      description: '각 목록 페이지에 표시할 글 수입니다. 최소 1개입니다.',
      error: '1 이상의 정수를 입력해 주세요.',
    },
    dateStyle: {
      label: '날짜 형식',
      description: '날짜를 얼마나 자세하게 표시할지 선택하세요.',
    },
    timeStyle: {
      label: '시간 형식',
      description: '시간을 표시하지 않으려면 없음을 선택하세요.',
    },
    datetimePreview: {
      title: '날짜·시각 미리보기',
      basis: '이 브라우저의 언어와 시간대로 표시한 예시입니다. 실제 표기는 테마에 따라 달라질 수 있습니다.',
      omitted: '날짜와 시간 형식을 선택하지 않았습니다. 테마에서 시각 표시를 생략할 수 있습니다.',
    },
    styles: {
      none: '없음',
      short: '짧게',
      medium: '보통',
      long: '길게',
      full: '전체',
    },
    search: {
      label: '정적 검색 활성화',
      description: '검색 기능을 지원하는 테마가 필요합니다.',
    },
    feed: {
      label: 'RSS 피드 생성',
      description: '일반 설정에서 사이트 URL을 먼저 지정하세요.',
    },
    archive: {
      label: '시간순 아카이브 생성',
      description: '아카이브 템플릿을 제공하는 테마가 필요합니다.',
    },
    footerCopyright: {
      label: '저작권 또는 법적 고지 문구 (선택)',
      description: '비워 두면 테마에서 표시 내용을 결정합니다.',
    },
    footerAttribution: {
      label: 'ZeroPress 출처 표시 허용',
      description: '테마가 제공하는 ZeroPress 출처 문구를 표시할 수 있습니다.',
    },
    indexing: {
      label: '검색 엔진 색인 허용',
      description: '사이트를 검색 결과에 노출할 준비가 되면 활성화하세요. 접근을 제한하는 설정은 아닙니다.',
    },
    generator: {
      label: 'ZeroPress 제작 도구 정보 표시',
      description: '페이지에 ZeroPress로 제작되었음을 알리는 메타 태그를 추가합니다.',
    },
  },
  state: {
    saved: '표시 및 출력 설정을 저장했습니다.',
    dirty: '저장하지 않은 변경사항이 있습니다.',
    clean: '모든 변경사항이 저장되었습니다.',
    defaults: '처음 저장하기 전까지 기본값을 사용합니다.',
    lastSaved: '마지막 저장: {{date}}',
  },
  actions: {
    reset: '변경사항 되돌리기',
    save: '설정 저장',
    saving: '저장 중…',
  },
  errors: {
    conflictTitle: '다른 세션에서 출력 설정이 변경되었습니다',
    conflictDescription: '현재 편집값은 이 화면에 유지됩니다. 최신 저장값을 불러온 후 다시 편집하고 저장해 주세요.',
    reload: '최신 값 불러오기',
    forbidden: '현재 계정은 사이트 설정을 관리할 수 없습니다.',
    validation: '강조 표시된 항목을 확인한 후 저장해 주세요.',
    timeout: '설정 요청 시간이 초과되었습니다. 다시 시도해 주세요.',
    network: 'Studio에 연결할 수 없습니다. 연결 상태를 확인한 후 다시 시도해 주세요.',
    invalidResponse: 'Studio가 예상하지 못한 출력 설정 응답을 반환했습니다.',
    api: 'Studio가 출력 설정을 저장하지 못했습니다. 현재 편집값은 이 화면에 유지됩니다.',
  },
  discard: {
    kicker: '저장하지 않은 변경사항',
    title: '저장하지 않고 이동할까요?',
    description: '이 페이지에서 변경한 내용이 폐기됩니다.',
    stay: '계속 편집',
    leave: '폐기 후 이동',
  },
} as const;
