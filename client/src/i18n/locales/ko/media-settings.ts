export const mediaSettings = {
  documentTitle: '미디어 설정 — ZeroPress Studio',
  kicker: '미디어 전송',
  title: '미디어 설정',
  description: '사이트의 이미지와 파일을 제공할 주소를 설정하세요.',
  loading: '미디어 설정을 불러오는 중…',
  loadError: '미디어 설정을 불러오지 못했습니다',
  section: {
    title: '미디어 전송',
    description: '공개 전송 주소를 설정합니다. 파일 업로드와 관리는 미디어 화면에서 진행하세요.',
  },
  fields: {
    origin: {
      label: '미디어 주소',
      description: '경로를 제외한 HTTP(S) 주소를 입력하세요. 비워 두면 /uploads/image.png 같은 사이트 기준 경로를 사용합니다.',
      placeholder: 'https://media.example.com',
    },
    mode: {
      label: '전송 모드',
      none: '표준 미디어 URL',
      mediaDomain: 'ZeroPress 미디어 도메인',
      description: 'ZeroPress 이미지 변형을 지원하는 서비스를 사용할 때만 ZeroPress 미디어 도메인을 선택하세요.',
    },
  },
  state: {
    saved: '미디어 설정을 저장했습니다.',
    dirty: '저장하지 않은 변경사항이 있습니다.',
    clean: '모든 변경사항을 저장했습니다.',
  },
  actions: { retry: '다시 시도', reset: '변경 취소', save: '설정 저장', saving: '저장 중…' },
  errors: {
    validation: '올바른 미디어 origin과 호환되는 전송 모드를 입력하세요.',
    conflictTitle: '다른 세션에서 미디어 설정이 변경되었습니다',
    conflictDescription: '최신 값을 불러온 후 저장하세요.',
    forbidden: '이 계정은 미디어 설정을 관리할 수 없습니다.',
    timeout: '미디어 설정 요청 시간이 초과되었습니다.',
    network: 'Studio에 연결할 수 없습니다.',
    invalidResponse: 'Studio가 예상하지 못한 미디어 설정 응답을 반환했습니다.',
    api: 'Studio가 미디어 설정을 저장하지 못했습니다.',
  },
  discard: {
    kicker: '저장하지 않은 변경사항',
    title: '저장하지 않고 나갈까요?',
    description: '이 페이지에서 변경한 내용이 폐기됩니다.',
    stay: '계속 편집',
    leave: '폐기하고 나가기',
  },
} as const;
