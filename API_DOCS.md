# SEON Chrono-DNI™ API Reference (`v1/analyze`)

처방약과 영양제를 분석하여 DNI 킬레이트 충돌 및 간/신장 대사 부하 지수를 반환합니다.

### 응답 필드 규격 (Response Fields)

- `hepatic_strain_index` (number): 간 대사 부하 지수 (0% ~ 100%)
- `hepatic_status` (string): 간 대사 상태 (`NORMAL`, `MODERATE`, `HIGH`, `CRITICAL`)
- `renal_strain_index` (number): 신장 대사 부하 지수 (0% ~ 100%)
- `renal_status` (string): 신장 대사 상태 (`NORMAL`, `MODERATE`, `HIGH`, `CRITICAL`)
- `isolation_hours` (number): 추천 급여 간격 시간 (시간 단위)

### 대사 부하 구간 표기 기준

- **0% ~ 24% (`NORMAL`)**: 정상 (초록)
- **25% ~ 59% (`MODERATE`)**: 주의 - 모니터링 필요 (주황)
- **60% ~ 79% (`HIGH`)**: 경고 - 복용 격리 필요 (주황/빨강)
- **80% ~ 100% (`CRITICAL`)**: 심각 - 수의사 즉시 상담 권장 (빨강)
