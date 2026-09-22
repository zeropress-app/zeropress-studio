export const system = {
  documentTitle: '시스템 상태 · ZeroPress Studio',
  regionLabel: 'ZeroPress Studio 시스템 상태',
  brandLabel: 'ZeroPress Studio',
  loading: {
    eyebrow: '준비 중',
    title: 'Studio를 준비하고 있습니다',
    message: '잠시만 기다려 주세요.',
  },
  states: {
    installation: {
      eyebrow: '초기 설정',
      title: 'Studio를 설치할 준비가 되었습니다',
      message: '설치 토큰과 최초 관리자 계정을 입력하여 Studio를 설치해 주세요.',
    },
    installationConfiguration: {
      eyebrow: '설치 준비',
      title: '설치 설정을 완료하세요',
      message: '남은 Worker 설정을 완료하고 다시 배포한 뒤 설정을 확인하세요.',
      retry: '설정 다시 확인',
    },
    activationRequired: {
      eyebrow: '운영자 조치 필요',
      title: '설치가 완료되었습니다',
      message: '로그인하기 전에 남은 Worker 구성을 마무리해 주세요.',
      finalization: {
        title: 'Studio 로그인 활성화',
        description: '남은 작업을 순서대로 완료한 뒤 설정을 다시 확인해 주세요.',
        removeInstallToken: '이 비밀 값을 삭제하세요.',
        setOperationalMode: '값을 operational로 설정하세요.',
        redeploy: '변경된 구성으로 Worker를 다시 배포하세요.',
      },
      retry: '설정 다시 확인',
    },
    maintenance: {
      eyebrow: '점검 모드',
      title: 'Studio를 일시적으로 사용할 수 없습니다',
      visitorMessage: '점검 작업이 진행 중입니다. 나중에 다시 시도해 주세요.',
      setupMessage: '유지보수 및 복구를 열어 접근 설정을 완료하세요.',
      operatorMessage: '계획된 lifecycle 작업이 진행 중입니다. maintenance는 일반 로그인과 제품 API를 차단하고, 검토된 백업·복원·업그레이드·초기화·제거 작업을 허용합니다.',
      operationsLink: '유지보수 및 복구 열기',
    },
    recovery: {
      eyebrow: '복구 모드',
      title: '복구 중에는 Studio 접근이 제한됩니다',
      visitorMessage: '복구 작업이 진행 중입니다. 일반 Studio 접근이 복원된 뒤 다시 시도해 주세요.',
      setupMessage: '유지보수 및 복구를 열어 접근 설정을 완료하세요.',
      operatorMessage: '일반 로그인은 중지되어 있습니다. 허용된 운영자는 유지보수 및 복구에서 데이터베이스를 백업·복원하거나 관리자 접근을 복구할 수 있습니다.',
      operationsLink: '유지보수 및 복구 열기',
      retry: '복구 상태 다시 확인',
    },
    unavailable: {
      eyebrow: '시스템 사용 불가',
      title: 'Studio를 시작할 수 없습니다',
      message: '시스템 상태를 확인할 수 없습니다. 브라우저 연결과 Worker 설정을 확인한 후 다시 시도해 주세요.',
    },
    cloudflareAccess: {
      eyebrow: '보호된 접근',
      required: {
        title: 'Cloudflare Access를 통해 Studio를 여세요',
        message: '이 Studio는 검증된 Cloudflare Access 세션을 요구합니다. 보호된 주소로 접속한 뒤 다시 시도해 주세요.',
      },
      sessionExpired: {
        message: 'Cloudflare Access 세션이 더 이상 유효하지 않습니다. 이 페이지에 보관된 작업을 버리지 않고 다시 인증하려면 계속해 주세요.',
      },
      unavailable: {
        title: 'Cloudflare Access를 검증할 수 없습니다',
        message: 'Studio가 설정된 Access 애플리케이션을 검증하지 못했습니다. 다시 시도하거나, 이 Studio의 운영자라면 복구 절차를 사용해 주세요.',
      },
      continue: 'Cloudflare Access로 계속',
    },
    blocked: {
      SITE_MODE_MISSING: {
        eyebrow: '설정 필요',
        title: 'Studio 사이트 모드를 설정하세요',
        message: 'STUDIO_SITE_MODE를 initial, operational, maintenance, recovery 중 하나로 설정하고 Worker를 다시 배포하세요.',
        retry: '설정 다시 확인',
      },
      SITE_MODE_INVALID: {
        eyebrow: '설정 필요',
        title: 'Studio 사이트 모드를 수정하세요',
        message: 'STUDIO_SITE_MODE 값을 initial, operational, maintenance, recovery 중 하나와 정확히 일치시키고 Worker를 다시 배포하세요.',
        retry: '설정 다시 확인',
      },
      INSTALL_TOKEN_NOT_CONFIGURED: {
        title: '설치가 허용되지 않았습니다',
        message: '설치 화면을 열기 전에 STUDIO_INSTALL_TOKEN을 공백 없는 출력 가능 ASCII 32–256자의 Worker secret으로 설정해 주세요.',
      },
      AUTH_SECRET_NOT_CONFIGURED: {
        eyebrow: '설정 필요',
        title: 'Studio 인증 Secret을 설정하세요',
        message: 'STUDIO_AUTH_SECRET이 없거나 올바르지 않습니다. Cloudflare Secret을 수정하고 Worker를 다시 배포한 뒤 확인하세요.',
        retry: '설정 다시 확인',
      },
      DATABASE_UNMANAGED: {
        title: 'Studio가 관리하는 데이터베이스가 아닙니다',
        message: 'DB binding이 Studio 전용 데이터베이스를 가리키는지 확인해 주세요.',
      },
      DATABASE_UNAVAILABLE: {
        title: '데이터베이스를 사용할 수 없습니다',
        message: 'DB binding과 Cloudflare D1 서비스 상태를 확인해 주세요.',
      },
      DATABASE_SCHEMA_STATE_INVALID: {
        title: '데이터베이스 복구가 필요합니다',
        message: '데이터베이스 lifecycle 상태가 불완전하거나 올바르지 않습니다. 일반 접근을 계속 차단하고 지원되는 lifecycle 복구 절차를 사용한 뒤 진행해 주세요.',
      },
      DATABASE_UPGRADE_REQUIRED: {
        eyebrow: '데이터베이스 업데이트 필요',
        title: 'Studio 데이터베이스를 업데이트하세요',
        message: '현재 데이터베이스는 이전 Studio 버전에서 생성되었습니다. 일반 운영으로 돌아가기 전에 업데이트를 완료하세요.',
        retry: '상태 다시 확인',
        status: {
          title: '데이터베이스 스키마',
          versionRange: '버전 {{current}} → {{target}}',
          required: '업데이트 필요',
        },
        stepsLabel: '데이터베이스 업데이트 준비',
        steps: {
          maintenance: {
            title: '점검 모드로 전환',
            description: 'STUDIO_SITE_MODE를 maintenance로 설정하고 Worker를 다시 배포하세요.',
          },
          upgrade: {
            title: '백업 후 업데이트',
            description: '유지보수 및 복구에서 Studio 데이터베이스 백업을 생성·보관한 뒤 업데이트를 실행하세요.',
          },
        },
        recoveryNote: '관리자 확인을 완료할 수 없다면 recovery 모드에서 접근을 복구한 뒤 maintenance로 전환하세요.',
      },
      DATABASE_NEWER_THAN_CODE: {
        eyebrow: '데이터베이스 호환성',
        title: 'Studio 업데이트 필요',
        message: '현재 데이터베이스의 스키마 버전이 이 Worker의 지원 버전보다 높습니다. 호환되는 Worker를 배포해야 Studio를 사용할 수 있습니다.',
        retry: '배포 후 다시 확인',
        versions: {
          title: '버전 비교',
          studio: 'Studio 버전 (Worker)',
          database: '데이터베이스 스키마',
          worker: 'Worker 지원 스키마',
          unknown: '확인할 수 없음',
        },
        stepsLabel: '호환성 복구 순서',
        steps: {
          deploy: {
            title: '호환되는 Studio 버전 배포',
            description: 'Cloudflare에서 이 Worker의 Deployments를 확인하세요. 롤백했다면 데이터베이스 업그레이드 후 사용하던 배포로 돌아가거나, 현재 스키마를 지원하는 릴리즈를 배포하세요.',
          },
          binding: {
            title: '데이터베이스 연결 확인',
            description: '예상하지 못한 불일치라면 Worker의 DB 바인딩이 의도한 Studio 데이터베이스에 연결되어 있는지 확인하세요.',
          },
        },
      },
      DATABASE_UNSUPPORTED: {
        title: '더 이상 지원하지 않는 데이터베이스 스키마입니다',
        message: '지원되는 업그레이드 경로를 사용하거나 호환되는 데이터베이스 백업을 복원해 주세요.',
      },
    },
  },
  workerSecretSetup: {
    authentication: {
      requirement: '공백 없는 출력 가능 ASCII 32–256자를 사용하세요.',
      existingInstallation: '기존에 운영하던 Studio라면 기존 값을 복원하세요.',
      generate: '값 생성',
      copySuccess: '생성된 값을 복사했습니다.',
    },
    installation: {
      regionLabel: '설치 Worker 설정',
      storageGuidance: '각 Secret에는 고유한 값을 사용하고 Cloudflare의 일반 변수(plaintext)가 아닌 Secret으로 저장하세요.',
      siteMode: '설치 모드 initial이 활성화되어 있습니다.',
      siteModeChangeRequired: '설치 전에 값을 initial로 변경하세요.',
    },
    authSecret: {
      description: 'MFA 정보와 저장된 서비스 자격 증명을 보호합니다.',
    },
    installToken: {
      description: '설치 페이지 접근에 사용되는 토큰입니다.',
      retention: '설치가 완료될 때까지 이 값을 안전한 곳에 보관하세요. 설치 페이지에서 다시 입력해야 합니다.',
      copySuccess: 'STUDIO_INSTALL_TOKEN을 복사했습니다. 설치가 완료될 때까지 안전하게 보관하세요.',
    },
    states: {
      valid: '설정됨',
      missing: '설정되지 않음',
      invalid: '유효하지 않음',
      unknown: '확인 필요',
      changeRequired: '변경 필요',
    },
    generate: '{{name}} 생성',
    generateValue: '값 생성',
    regenerate: '새 값 다시 생성',
    valueLabel: '생성된 {{name}}',
    copy: '값 복사',
    copied: '복사됨',
    copySuccess: '생성된 {{name}} 값을 복사했습니다.',
    copyFailed: '값을 자동으로 복사하지 못했습니다. 직접 선택하여 복사해 주세요.',
    generationFailed: '이 브라우저에서 안전한 값을 생성할 수 없습니다. 설정 문서의 명령을 대신 사용해 주세요.',
    guide: '설정 문서 열기',
  },
  retry: '다시 확인',
  operatorNote: '일치하는 Worker 운영 로그에 자세한 복구 안내가 포함되어 있습니다.',
} as const;
