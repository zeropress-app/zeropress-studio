export const publishing = {
  loading: '발행 상태를 확인하는 중…',
  loadError: 'GitHub 연결을 불러오지 못했습니다',
  retry: '다시 확인',
  settings: {
    title: '사이트 발행',
    kicker: '사이트 설정',
    description: '사이트 빌드에 사용하는 Preview Data 파일을 연결합니다.',
    enabled: 'GitHub 발행 사용',
    fileUrl: 'GitHub 파일 URL',
    fileUrlHint:
      '사이트 빌드에 사용하는 기존 Preview Data JSON 파일의 GitHub 주소를 붙여넣으세요.',
    owner: '저장소 소유자',
    repo: '저장소',
    branch: '브랜치',
    path: '파일 경로',
    manual: '대상 직접 입력',
    token: 'GitHub Token',
    tokenHint:
      '대상 저장소를 선택하고 Contents: Read and write 권한을 허용하세요.',
    tokenStored: '토큰이 저장되어 있습니다. 빈칸으로 두면 유지됩니다.',
    createToken: 'GitHub 토큰 생성',
    removeToken: '저장된 토큰 삭제',
    test: '연결 확인',
    testing: '연결 확인 중…',
    testSuccess:
      '브랜치와 JSON 파일을 조회했습니다. 발행하려면 쓰기 권한이 있어야 하며 브랜치 규칙을 충족해야 합니다.',
    save: '발행 설정 저장',
    saved: '발행 설정을 저장했습니다.',
    validation: '발행 대상과 토큰을 확인해 주세요.',
  },
  panel: {
    title: 'GitHub 발행',
    description:
      '최신 사이트 데이터를 커밋합니다. 이후 배포는 저장소에 연결된 빌드 서비스가 진행합니다.',
    notConfigured: '발행 설정에서 대상 파일과 GitHub 토큰을 저장해 주세요.',
    disabled: 'GitHub 발행이 꺼져 있습니다',
    enableHint:
      '저장된 연결을 사용하려면 발행 설정에서 ‘GitHub 발행 사용’을 켜고 저장해 주세요.',
    target: '대상 파일',
    latest: '파일의 최근 커밋',
    settings: '발행 설정',
    publish: 'GitHub에 발행',
    publishing: '발행 중…',
    failed: 'GitHub 요청에 실패했습니다',
    unknown: '반영 여부 확인 필요',
  },
  confirmation: {
    title: 'GitHub에 발행할까요?',
    description:
      '최신 사이트 데이터를 아래 파일에 반영합니다. 연결된 사이트 배포가 시작될 수 있습니다.',
    cancel: '취소',
  },
  outcome: {
    committed: 'GitHub 반영 완료',
    confirmed: 'GitHub 반영을 확인했습니다.',
    unchanged: '발행할 변경 사항이 없습니다.',
  },
  leaving: {
    title: '발행 중입니다',
    description:
      '이 페이지를 떠나도 GitHub에 이미 전송한 커밋은 취소되지 않습니다.',
    stay: '머무르기',
    leave: '페이지 나가기',
  },
  errors: {
    notConfigured: '발행 설정을 확인하고 ‘GitHub 발행 사용’을 켜 주세요.',
    tokenMissing: 'GitHub 토큰을 입력하거나 저장된 토큰을 유지해 주세요.',
    urlInvalid:
      '/blob/과 .json 파일 경로가 포함된 github.com 파일 URL을 입력하세요.',
    urlAmbiguous:
      '이 URL에 해당하는 브랜치와 파일이 여러 개입니다. 브랜치와 파일 경로를 직접 입력해 주세요.',
    authentication:
      'GitHub에서 토큰을 거부했습니다. 토큰이 유효한지, 만료되지 않았는지 확인해 주세요.',
    permission:
      '토큰으로 저장소에 접근하거나 파일을 수정할 수 없습니다. 대상 저장소, 권한, 조직의 승인 여부를 확인해 주세요.',
    notFound:
      '브랜치 또는 파일을 찾지 못했습니다. 발행 대상과 비공개 저장소 접근 권한을 확인해 주세요.',
    targetInvalid:
      '브랜치에 있는 기존 .json 일반 파일을 선택하세요. 태그, 커밋 ID, 디렉터리, 심볼릭 링크는 사용할 수 없습니다.',
    branchRestricted:
      'GitHub 브랜치 규칙에 의해 커밋이 거부되었습니다. 이 토큰으로 직접 발행할 수 있는 브랜치를 선택해 주세요.',
    conflict:
      '발행 중 대상 파일이 변경되었습니다. 최근 커밋을 확인한 뒤 다시 발행해 주세요.',
    settingsConflict:
      '연결 설정이 변경되었습니다. 다시 불러온 뒤 진행해 주세요.',
    limited: 'GitHub 요청 한도에 도달했습니다. 잠시 후 다시 시도해 주세요.',
    unavailable:
      '현재 GitHub에 연결할 수 없습니다. 잠시 후 다시 시도해 주세요.',
    invalid: 'GitHub 응답을 처리하지 못했습니다.',
    unknown:
      '반영 여부를 확인하지 못했습니다. 다시 발행하기 전에 GitHub에서 파일의 최근 커밋을 확인해 주세요.',
    forbidden: '사이트 발행을 관리할 권한이 없습니다.',
    timeout: 'GitHub 요청 시간이 초과되었습니다.',
    network: 'Studio에 연결하지 못했습니다. 네트워크 연결을 확인해 주세요.',
    edge: 'Preview Data를 준비하지 못했습니다. 사이트 설정에서 Edge 연동 상태를 확인한 뒤 다시 시도해 주세요.',
    unexpected:
      '사이트 데이터 생성 또는 발행에 실패했습니다. 사이트 설정과 Worker 로그를 확인해 주세요.',
  },
} as const;
