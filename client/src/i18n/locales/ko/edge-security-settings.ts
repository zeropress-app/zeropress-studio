export const edgeSecuritySettings = {
  documentTitle: 'Edge 보안 — ZeroPress Studio',
  kicker: '공개 요청 보안',
  title: 'Edge 보안',
  description: '댓글·구독·폼 제출의 요청 검증과 IP 주소 보관 기간을 설정하세요.',
  loading: {
    title: 'Edge 보안을 불러오는 중',
    description: 'Studio가 공유 Edge 런타임 정책을 읽고 있습니다.',
  },
  loadError: {
    title: 'Edge 보안을 불러올 수 없습니다',
    description: '올바른 설정을 불러올 때까지 Edge의 댓글·구독·폼 제출이 중지됩니다.',
    retry: '다시 시도',
  },
  verification: {
    title: '공개 write 검증',
    description: '각 기능에서 사용할 요청 검증 방법을 선택하세요.',
  },
  turnstile: {
    title: 'Cloudflare Turnstile',
    description: 'Turnstile을 사용할 때 방문자에게 제공하는 공개 키입니다.',
    secretTitle: 'Worker secret은 별도로 설정합니다',
    secretDescription: '같은 Turnstile 위젯의 Secret을 ZeroPress Edge Worker에 저장하세요. 일반 변수 대신 Secret으로 등록해야 합니다.',
  },
  retention: {
    title: 'IP 주소 보존',
    description: '저장된 IP 주소를 자동으로 삭제할 시점을 정합니다.',
  },
  fields: {
    commentMode: {
      label: '댓글 작성',
      description: '글과 페이지의 새 공개 댓글에 적용할 검증 방식입니다.',
    },
    newsletterMode: {
      label: '뉴스레터 구독',
      description: '새 공개 뉴스레터 구독 요청에 적용할 검증 방식입니다.',
    },
    formMode: {
      label: '폼 제출',
      description: '새 공개 Form 제출에 적용할 검증 방식입니다.',
    },
    modeOptions: {
      pow: 'Proof of Work',
      turnstile: 'Cloudflare Turnstile',
    },
    sitekey: {
      label: 'Turnstile sitekey',
      description: '세 write 기능이 모두 Proof of Work를 사용하면 비워둘 수 있습니다.',
      placeholder: '0x4AAAAAAA…',
      errorRequired: 'Turnstile을 사용하는 write 기능이 있으면 공개 Turnstile sitekey를 입력해 주세요.',
      errorLength: 'Turnstile sitekey는 256자 이하여야 합니다.',
    },
    retentionDays: {
      label: '보존 기간(일)',
      description: '1부터 365 사이의 정수를 선택합니다. 기본값은 30일입니다.',
      error: '1부터 365 사이의 정수를 입력해 주세요.',
    },
  },
  state: {
    saved: 'Edge 공개 요청 보안 설정을 저장했습니다.',
    dirty: '저장하지 않은 변경사항이 있습니다.',
    clean: '모든 변경사항이 저장되었습니다.',
    lastSaved: '마지막 저장: {{date}}',
  },
  actions: {
    reset: '변경사항 되돌리기',
    save: 'Edge 보안 저장',
    saving: '저장 중…',
  },
  errors: {
    conflictTitle: '다른 세션에서 Edge 보안이 변경되었습니다',
    conflictDescription: '현재 편집값은 이 화면에 유지됩니다. 최신 Edge 설정을 불러온 후 다시 저장해 주세요.',
    reload: '최신 값 불러오기',
    forbidden: '현재 계정은 Edge 보안을 관리할 수 없습니다.',
    validation: '검증 방식, sitekey와 보존 기간을 확인한 후 저장해 주세요.',
    timeout: 'Edge 보안 요청 시간이 초과되었습니다. 다시 시도해 주세요.',
    network: 'Studio에 연결할 수 없습니다. 연결 상태를 확인한 후 다시 시도해 주세요.',
    invalidResponse: 'Studio가 예상하지 못한 Edge 보안 응답을 반환했습니다.',
    api: 'Studio가 Edge 보안 요청을 완료하지 못했습니다. 기존 설정은 변경되지 않았습니다.',
  },
  discard: {
    kicker: '저장하지 않은 변경사항',
    title: '저장하지 않고 이동할까요?',
    description: 'Edge 보안에서 변경한 내용이 폐기됩니다.',
    stay: '계속 편집',
    leave: '폐기 후 이동',
  },
} as const;
