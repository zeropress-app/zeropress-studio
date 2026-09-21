export const analytics = {
  title: '방문 통계',
  kicker: '개요',
  connection: '연결 설정',
  configure: '설정 열기',
  period: '기간',
  periods: {
    '30m': '최근 30분',
    '6h': '최근 6시간',
    '12h': '최근 12시간',
    '24h': '최근 24시간',
    '3d': '최근 3일',
    '7d': '최근 7일',
    '14d': '최근 2주',
    '21d': '최근 21일',
    '30d': '최근 30일',
  },
  pageviews: '페이지뷰',
  visits: '방문 수',
  trend: '일별 방문 추이',
  chartMetric: '차트 지표',
  chartLabel: '일별 {{metric}}',
  dailyValues: '일별 수치 보기',
  date: '날짜',
  url: 'URL',
  source: '유입 경로',
  topPaths: '인기 URL',
  topReferrers: '유입 사이트',
  direct: '직접 방문 / 알 수 없음',
  updated: '마지막 조회: {{time}}',
  loading: '방문 통계를 불러오는 중…',
  loadError: '방문 통계를 불러오지 못했습니다',
  retry: '다시 시도',
  notConnected: '방문 통계가 연결되지 않았습니다',
  noData: {
    title: '기록된 방문이 없습니다',
    description:
      '선택한 사이트와 기간에 페이지뷰가 없습니다. 공개 사이트에서 Web Analytics가 데이터를 수집하고 있는지 확인하세요.',
  },
  sampling:
    'Cloudflare 통계에는 샘플링에 따른 추정값이 포함될 수 있습니다. 방문 수는 외부 사이트나 직접 링크를 통한 유입 횟수이며, 고유 방문자 수가 아닙니다.',
  settings: {
    title: '방문 통계 설정',
    kicker: '사이트 설정',
    description:
      '공개 사이트에서 수집 중인 Cloudflare Web Analytics 통계를 연결합니다.',
    enabled: '방문 통계 사용',
    dashboardUrl: 'Web Analytics URL',
    dashboardUrlHint:
      'Cloudflare에서 분석할 사이트를 선택한 뒤, 브라우저 주소를 붙여넣으세요.',
    dashboardUrlInvalid:
      '사이트 하나를 선택한 Cloudflare Web Analytics 주소를 붙여넣으세요.',
    selectSite: 'Cloudflare에서 사이트 선택',
    manualIds: 'ID 직접 입력',
    account_id: 'Account ID',
    site_tag: 'Site Tag',
    token: 'API Token',
    tokenHint: '사이트와 같은 Cloudflare 계정에서 토큰을 만든 뒤 붙여넣으세요.',
    createToken: 'Cloudflare에서 API Token 만들기',
    tokenStored: '토큰이 저장되어 있습니다. 빈칸으로 두면 유지됩니다.',
    removeToken: '저장된 토큰 삭제',
    test: '연결 확인',
    testing: '연결 확인 중…',
    data_found: 'API 연결이 정상이며 방문 데이터를 확인했습니다.',
    no_data:
      'API 조회는 성공했지만 최근 24시간의 방문 데이터가 없습니다. Site Tag와 공개 사이트의 수집 설정을 확인하세요.',
    saved: '방문 통계 설정을 저장했습니다.',
    save: '방문 통계 설정 저장',
    validation:
      '연결 정보를 확인하고, 방문 통계를 사용하려면 토큰을 입력하세요.',
    conflict: '다른 세션에서 설정이 변경되었습니다',
    conflictDescription: '현재 설정을 다시 불러온 뒤 저장하세요.',
  },
  errors: {
    notConfigured:
      '사이트의 방문 현황을 보려면 Cloudflare Web Analytics를 연결하세요.',
    siteMissing: '먼저 일반 설정에서 공개 사이트 URL을 지정하세요.',
    tokenMissing:
      'API Token을 추가하거나, 방문 통계를 끈 뒤 저장된 토큰을 삭제하세요.',
    authentication:
      'Cloudflare에서 접근을 거부했습니다. 계정과 토큰의 Analytics 읽기 권한을 확인하세요.',
    limited:
      '통계 조회 한도를 초과했습니다. 기간을 줄이거나 나중에 다시 시도하세요.',
    unavailable:
      '현재 Cloudflare Web Analytics를 사용할 수 없습니다. 나중에 다시 시도하세요.',
    invalid: '통계 응답을 읽을 수 없습니다. 나중에 다시 시도하세요.',
    forbidden: '관리자만 방문 통계에 접근할 수 있습니다.',
    timeout: '통계 조회 시간이 초과되었습니다. 다시 시도하세요.',
    network:
      'Studio에 연결하지 못했습니다. 연결 상태를 확인하고 다시 시도하세요.',
    unexpected: '방문 통계를 불러오거나 저장하지 못했습니다. 다시 시도하세요.',
  },
};
