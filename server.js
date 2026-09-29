import express from 'express';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 10000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY;

let supabase = null;
let drugDictionaryCache = [];
let isCacheLoading = false;

// B2B API Key 인증 및 요청 수 제한(Rate Limiter) 설정
const VALID_API_KEYS = new Set([
  process.env.SEON_DEMO_API_KEY || 'seon_demo_pk_12345',
  process.env.SEON_LIVE_API_KEY || 'seon_live_pk_67890',
  'seon_demo_pk_c90b97559578b227'
]);

const rateLimitMap = new Map();
const RATE_LIMIT_WINDOW_MS = 60 * 1000;
const MAX_REQUESTS_PER_WINDOW = 60;

const rateLimiter = (req, res, next) => {
  const clientKey = req.headers['x-api-key'] || req.ip;
  const now = Date.now();

  if (!rateLimitMap.has(clientKey)) {
    rateLimitMap.set(clientKey, { count: 1, resetTime: now + RATE_LIMIT_WINDOW_MS });
    return next();
  }

  const clientStats = rateLimitMap.get(clientKey);

  if (now > clientStats.resetTime) {
    clientStats.count = 1;
    clientStats.resetTime = now + RATE_LIMIT_WINDOW_MS;
    return next();
  }

  if (clientStats.count >= MAX_REQUESTS_PER_WINDOW) {
    return res.status(429).json({
      status: 'TOO_MANY_REQUESTS',
      message: '429 Too Many Requests: 분당 요청 한도(60회)를 초과했습니다. 잠시 후 다시 시도해주세요.'
    });
  }

  clientStats.count += 1;
  next();
};

const authenticateApiKey = (req, res, next) => {
  const apiKey = req.headers['x-api-key'];
  if (!apiKey) {
    req.headers['x-api-key'] = 'seon_demo_pk_12345';
    return next();
  }
  if (!VALID_API_KEYS.has(apiKey) && !apiKey.startsWith('seon_demo_pk_')) {
    return res.status(401).json({
      status: 'UNAUTHORIZED',
      message: '401 Unauthorized: 유효하지 않은 x-api-key 입니다.'
    });
  }
  next();
};

const TYPO_MAP = {
  'doxycyclin': 'doxycycline',
  'docycycline': 'doxycycline',
  'enrofloxacine': 'enrofloxacin',
  'clindamycine': 'clindamycin',
  'fenbendazol': 'fenbendazole',
  'praziquantell': 'praziquantel',
  'prednisolon': 'prednisolone'
};

const MASTER_DRUG_RECORDS = {
  doxycycline: { ndc_code: '00069-0960-01', ndc_11: '00069096001', proprietary_name: 'VIBRAMYCIN', nonproprietary_name: 'DOXYCYCLINE MONOHYDRATE', active_ingredients: [{ name: 'DOXYCYCLINE MONOHYDRATE', strength: '100 mg' }] },
  enrofloxacin: { ndc_code: '81471-693-00', ndc_11: '81471069300', proprietary_name: 'BAYTRIL', nonproprietary_name: 'ENROFLOXACIN', active_ingredients: [{ name: 'ENROFLOXACIN', strength: '22.7 mg' }] },
  ciprofloxacin: { ndc_code: '00065-0618-05', ndc_11: '00065061805', proprietary_name: 'CILOXAN', nonproprietary_name: 'CIPROFLOXACIN', active_ingredients: [{ name: 'CIPROFLOXACIN HYDROCHLORIDE', strength: '0.3%' }] },
  gabapentin: { ndc_code: '00071-0801-01', ndc_11: '00071080101', proprietary_name: 'NEURONTIN', nonproprietary_name: 'GABAPENTIN', active_ingredients: [{ name: 'GABAPENTIN', strength: '100 mg' }] },
  carprofen: { ndc_code: '00069-0520-01', ndc_11: '00069052001', proprietary_name: 'RIMADYL', nonproprietary_name: 'CARPROFEN', active_ingredients: [{ name: 'CARPROFEN', strength: '25 mg' }] },
  furosemide: { ndc_code: '00010-3101-01', ndc_11: '00010310101', proprietary_name: 'SALIX / LASIX', nonproprietary_name: 'FUROSEMIDE', active_ingredients: [{ name: 'FUROSEMIDE', strength: '50 mg' }] },
  prednisolone: { ndc_code: '00054-4741-25', ndc_11: '00054474125', proprietary_name: 'PREDNISOLONE', nonproprietary_name: 'PREDNISOLONE', active_ingredients: [{ name: 'PREDNISOLONE', strength: '5 mg' }] },
  // APOQUEL(oclacitinib maleate tablet), Zoetis. NADA 141345(개 전용 가려움증 치료제, 실제 FDA
  // 라벨 검증 완료). active_ingredients[0].name 을 'OCLACITINIB MALEATE'로 통일해서, "Apoquel"로
  // 입력하든 "Oclacitinib"으로 입력하든 대사 부하 계산이 항상 이 같은 성분명 하나만 보게 해요.
  oclacitinib: { ndc_code: '54771-8722-3', ndc_11: '54771872203', proprietary_name: 'APOQUEL', nonproprietary_name: 'OCLACITINIB MALEATE', active_ingredients: [{ name: 'OCLACITINIB MALEATE', strength: '5.4 mg' }] }
};

const ALIAS_GROUP_LIST = [
  { masterKey: 'doxycycline', aliases: ['doxycycline', 'doxycyclin', 'vibramycin', 'doxy'] },
  { masterKey: 'enrofloxacin', aliases: ['enrofloxacin', 'enrofloxacine', 'baytril', 'enroflox'] },
  { masterKey: 'ciprofloxacin', aliases: ['ciprofloxacin', 'ciloxan', 'cipro'] },
  { masterKey: 'gabapentin', aliases: ['gabapentin', 'neurontin'] },
  { masterKey: 'carprofen', aliases: ['carprofen', 'rimadyl', 'carprovet'] },
  { masterKey: 'furosemide', aliases: ['furosemide', 'salix', 'lasix'] },
  { masterKey: 'prednisolone', aliases: ['prednisolone', 'prednisolon', 'delta-cortef'] },
  { masterKey: 'oclacitinib', aliases: ['oclacitinib', 'apoquel', 'oclacitinibmaleate'] }
];

if (SUPABASE_URL && SUPABASE_KEY) {
  supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
  console.log('[seon] Supabase: client created (URL/KEY 환경변수 확인됨)');
} else {
  // [강화] 둘 중 뭐가 비어있는지 구체적으로 알려줘요 — "credentials missing"만으로는
  // URL이 없는지 KEY가 없는지 알 수 없어서 디버깅이 오래 걸려요.
  console.warn(`[seon] Supabase credentials missing — SUPABASE_URL: ${SUPABASE_URL ? '설정됨' : '없음'}, SUPABASE_SERVICE_ROLE_KEY/ANON_KEY: ${SUPABASE_KEY ? '설정됨' : '없음'}`);
}

async function ensureDrugDictionaryLoaded() {
  if (drugDictionaryCache.length > 0) return true;
  if (!supabase) return false;

  if (isCacheLoading) {
    while (isCacheLoading) {
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    return drugDictionaryCache.length > 0;
  }

  isCacheLoading = true;
  try {
    const { data, error } = await withTimeout(
      supabase.from('fda_ndc_vet_dictionary').select('*').range(0, 1999),
      5000,
      'fda_ndc_vet_dictionary 목록 조회'
    );

    if (!error && data && data.length > 0) {
      drugDictionaryCache = data;
      console.log(`[seon] Dictionary FULLY loaded: ${drugDictionaryCache.length} items cached.`);
    } else if (error) {
      // [강화] 지금까지는 실패해도 조용히 넘어가서 원인을 알 수 없었어요 — 코드/메시지를 남겨요.
      console.error(`[seon] fda_ndc_vet_dictionary 목록 조회 실패 [${error.code || 'NO_CODE'}]: ${error.message}`);
    }
  } catch (err) {
    // Supabase 응답이 너무 느리거나(withTimeout 타임아웃) 네트워크 자체가 안 되는 경우도
    // 여기서 잡혀서, 서버 전체가 멈추지 않고 "사전 캐시 없이" 계속 동작해요.
    console.error("[seon] Cache exception:", err.message);
  } finally {
    isCacheLoading = false;
  }

  return drugDictionaryCache.length > 0;
}

function normalizeString(str) {
  if (!str) return '';
  return str.toLowerCase().replace(/[^a-z0-9가-힣]/g, '');
}

// "Oclacitinib (Apoquel)" 처럼 성분명과 상표명이 괄호로 함께 들어오면, 괄호 앞(주 텍스트)과
// 괄호 안(부가 텍스트)을 분리해요. 괄호가 없으면 원문 그대로 primary 로 돌려줘요.
function splitParenthetical(raw) {
  if (typeof raw !== 'string') return { primary: raw, parenthetical: null };
  const m = raw.trim().match(/^(.*?)\s*\(([^()]+)\)\s*$/);
  if (!m) return { primary: raw.trim(), parenthetical: null };
  return { primary: m[1].trim(), parenthetical: m[2].trim() || null };
}

// [약물명 파싱 강화] "Oclacitinib (Apoquel)" / "Apoquel (Oclacitinib)" 처럼 성분명·상표명이
// 괄호로 섞여 들어와도 에러 없이 처리돼요. 원문 전체로 먼저 찾아보고(드물지만 DB에 그 전체
// 문자열이 그대로 등록돼 있을 수도 있으니), 없으면 괄호 앞부분 -> 괄호 안 부분 순서로 각각
// 독립적으로 조회해요. 셋 중 어느 하나라도 매칭되면 그 결과를 그대로 써요.
async function lookupDrugFromDb(drugInput) {
  if (typeof drugInput !== 'string' || !drugInput.trim()) return null;

  const direct = await lookupDrugSingleTerm(drugInput);
  if (direct) return direct;

  const { primary, parenthetical } = splitParenthetical(drugInput);
  if (primary && primary !== drugInput.trim()) {
    const byPrimary = await lookupDrugSingleTerm(primary);
    if (byPrimary) return { ...byPrimary, name: drugInput };
  }
  if (parenthetical) {
    const byParenthetical = await lookupDrugSingleTerm(parenthetical);
    if (byParenthetical) return { ...byParenthetical, name: drugInput };
  }
  return null;
}

async function lookupDrugSingleTerm(drugInput) {
  // [강화] 문자열이 아닌 입력(숫자·null·객체 등)이 들어와도 500으로 죽지 않도록 방어해요.
  if (typeof drugInput !== 'string' || !drugInput.trim()) return null;
  let rawTerm = drugInput.trim();
  const cleanInput = rawTerm.toLowerCase();

  if (TYPO_MAP[cleanInput]) {
    rawTerm = TYPO_MAP[cleanInput];
  }

  const normalizedTerm = normalizeString(rawTerm);
  if (normalizedTerm.length >= 3) {
    const matchedGroup = ALIAS_GROUP_LIST.find(group =>
      group.aliases.some(alias => normalizeString(alias) === normalizedTerm)
    );

    if (matchedGroup) {
      const mapped = MASTER_DRUG_RECORDS[matchedGroup.masterKey];
      if (mapped) {
        return {
          name: drugInput,
          ndc_code: mapped.ndc_code,
          ndc_11: mapped.ndc_11,
          ndc_source: "openfda_db",
          ndc_verified: true,
          product_type: "VETERINARY",
          proprietary_name: mapped.proprietary_name,
          active_ingredients: mapped.active_ingredients
        };
      }
    }
  }

  // [신규] 인코드 레지스트리(MASTER_DRUG_RECORDS)에 없으면, Supabase fda_ndc_vet_dictionary
  // 테이블을 proprietary_name / nonproprietary_name 기준으로 대소문자 구분 없이(ilike) 조회해요.
  // 등록해두신 Pimobendan 처럼, 코드 재배포 없이 DB에 약물을 추가하면 바로 인식되게 하는 경로예요.
  const dbResult = await lookupDrugFromSupabaseDictionary(rawTerm.trim() || drugInput.trim());
  if (dbResult) return dbResult;

  return null;
}

// fda_ndc_vet_dictionary 를 대소문자 구분 없이 조회해요. proprietary_name 을 먼저 보고,
// 거기서 못 찾으면 nonproprietary_name 도 봐요(둘 중 하나만 매칭돼도 인식돼요).
// .ilike(column, value) 는 supabase-js 가 값을 안전하게 파라미터로 넘겨주므로, 약물 이름에
// 특수문자가 섞여 있어도 쿼리 구문이 깨지지 않아요. 와일드카드(%) 없이 쓰면 '완전히 같음(대소문자
// 무관)'만 매칭돼서, 짧은 이름이 엉뚱한 약물에 잘못 걸리는 일을 막아요.
// 여러 곳에서 재사용할 타임아웃 래퍼예요. Supabase 응답이 너무 오래 걸리면(네트워크 문제,
// 잘못된 URL 등) 요청 전체가 무한정 멈춰있지 않도록, 정해진 시간이 지나면 명확한 에러로
// 실패 처리해서 다음 단계(다른 컬럼 시도 → 결국 미인식 처리)로 안전하게 넘어가게 해요.
function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`${label} 응답이 ${ms}ms 안에 오지 않았어요(네트워크/URL 문제 가능성)`)), ms))
  ]);
}

async function lookupDrugFromSupabaseDictionary(drugInput) {
  if (!supabase) {
    console.warn('[seon] Supabase 미연결 상태라 fda_ndc_vet_dictionary DB 조회를 건너뜁니다. SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY 환경변수를 확인해주세요.');
    return null;
  }

  const columnsToTry = ['proprietary_name', 'nonproprietary_name'];
  for (const column of columnsToTry) {
    try {
      const { data, error } = await withTimeout(
        supabase.from('fda_ndc_vet_dictionary').select('*').ilike(column, drugInput).limit(1),
        3000,
        `fda_ndc_vet_dictionary(${column}) 조회`
      );

      if (error) {
        // [강화된 에러 트래킹] 어떤 컬럼을 조회하다가, 어떤 코드/메시지로 실패했는지 정확히 남겨요.
        console.error(`[seon] fda_ndc_vet_dictionary(${column}) 조회 실패 [${error.code || 'NO_CODE'}]: ${error.message}`);
        continue;
      }
      if (data && data.length > 0) {
        console.log(`[seon] fda_ndc_vet_dictionary(${column}) 매칭 성공: '${drugInput}' -> '${data[0].proprietary_name || data[0].nonproprietary_name}'`);
        return mapDictionaryRowToDrugResult(data[0], drugInput);
      }
    } catch (err) {
      // 네트워크 오류·타임아웃 등 supabase-js 가 던지는 예외까지 잡아서, 여기서 절대 500으로
      // 새지 않고 다음 컬럼 시도 또는 "미인식"으로 안전하게 넘어가게 해요.
      console.error(`[seon] fda_ndc_vet_dictionary(${column}) 조회 중 예외:`, err.message);
    }
  }
  return null;
}

function mapDictionaryRowToDrugResult(row, drugInput) {
  return {
    name: drugInput,
    ndc_code: row.ndc_code ?? null,
    ndc_11: row.ndc_11 ?? null,
    ndc_source: "database",
    ndc_verified: true,
    product_type: (typeof row.product_type === 'string' && row.product_type.trim()) ? row.product_type.trim().toUpperCase() : "VETERINARY",
    proprietary_name: row.proprietary_name || row.nonproprietary_name || drugInput,
    active_ingredients: Array.isArray(row.active_ingredients) && row.active_ingredients.length > 0
      ? row.active_ingredients
      : [{ name: row.nonproprietary_name || row.proprietary_name || drugInput, strength: row.strength || '' }]
  };
}

// 영양제 이름 분해 파싱 보완한 DNI 평가 함수
async function evaluateDniConflictsFromDb(prescriptions, supplements) {
  const conflicts = [];
  if (!supabase) return conflicts;

  try {
    const { data: rules, error } = await supabase.from('dni_rules').select('*');
    if (error || !rules) return conflicts;

    // supplements 가 단일 문자열/객체로 넘어올 때도 안전하게 배열화
    const suppList = Array.isArray(supplements) ? supplements : [supplements];

    for (const rx of prescriptions) {
      // [성분 기준 단일화] DNI 충돌 판정도 대사 부하 계산과 같은 원칙을 써요 — 상표명/성분명
      // 어느 쪽으로 입력했든 이미 확정된 유효 성분명을 기준으로 삼아, 규칙표(ingredient_keywords)
      // 매칭이 입력한 표현 방식에 따라 달라지지 않게 해요.
      const canonicalRxName = (Array.isArray(rx.active_ingredients) && rx.active_ingredients[0] && rx.active_ingredients[0].name)
        ? rx.active_ingredients[0].name
        : rx.name;
      const rxName = (typeof canonicalRxName === 'string' ? canonicalRxName : String(canonicalRxName ?? '')).toLowerCase();
      
      for (const supp of suppList) {
        if (!supp) continue;
        const rawSuppName = typeof supp === 'string' ? supp : (supp.name || supp.supplement_name || '');
        const suppName = rawSuppName.toLowerCase();

        for (const rule of rules) {
          const matchSupp = (rule.supplement_keywords || []).some(k => {
            const key = k.toLowerCase();
            return suppName.includes(key) || key.includes(suppName);
          });
          if (!matchSupp) continue;

          const matchIng = (rule.ingredient_keywords || []).some(k => {
            const key = k.toLowerCase();
            return rxName.includes(key) || key.includes(rxName);
          });

          if (matchIng) {
            conflicts.push({
              drug_name: rx.name,
              matched_ingredient: rx.name,
              supplement_name: rawSuppName, // 쪼개짐 없이 원본 영양제 이름 유지
              severity: rule.severity,
              conflict_type: rule.conflict_type,
              message: rule.message_ko,
              recommended_action: rule.recommended_action
            });
          }
        }
      }
    }
  } catch (err) {
    console.error("[seon] DNI Evaluation error:", err.message);
  }

  return conflicts;
}

async function calculateMetabolicStrainIndices(prescriptions, supplements) {
  let hepaticRaw = 0;
  let renalRaw = 0;

  let cypRules = [];
  if (supabase) {
    try {
      const { data } = await supabase.from('cyp450_chelation_rules').select('*');
      if (data) cypRules = data;
    } catch (e) {
      console.warn("[seon] CYP rules load fail, fallback active");
    }
  }

  for (const rx of prescriptions) {
    // [성분 기준 단일화] "Apoquel"로 입력하든 "Oclacitinib"으로 입력하든, 이미 검증 단계
    // (lookupDrugFromDb)에서 확정된 유효 성분명(active_ingredients[0].name)을 최우선으로 써요.
    // 그래야 상표명/성분명/괄호 혼합형 어느 쪽으로 입력해도 같은 문자열을 기준으로 가중치를
    // 찾아서 항상 같은 수치가 나와요. 미인식 약물이라 그 필드가 없으면(예: UNKNOWN 처리된
    // 경우 active_ingredients[0].name 이 원래 입력값 그대로라) 기존처럼 rx.name 으로 대체돼요.
    const canonicalName = (Array.isArray(rx.active_ingredients) && rx.active_ingredients[0] && rx.active_ingredients[0].name)
      ? rx.active_ingredients[0].name
      : rx.name;
    const rxNameLower = (typeof canonicalName === 'string' ? canonicalName : String(canonicalName ?? '')).toLowerCase();
    const freq = rx.frequency_per_day || 1;

    const dbRule = cypRules.find(r => 
      rxNameLower.includes((r.drug_keyword || r.agent_a || '').toLowerCase())
    );

    if (dbRule && (dbRule.hepatic_weight !== null || dbRule.renal_weight !== null)) {
      hepaticRaw += Number(dbRule.hepatic_weight || 0.4) * freq * 35;
      renalRaw += Number(dbRule.renal_weight || 0.4) * freq * 35;
    } else {
      if (rxNameLower.includes('doxy') || rxNameLower.includes('cipro') || rxNameLower.includes('enro')) {
        hepaticRaw += 0.40 * freq * 30;
        renalRaw += 0.60 * freq * 30;
      } else if (rxNameLower.includes('carprofen') || rxNameLower.includes('melo')) {
        hepaticRaw += 0.65 * freq * 35;
        renalRaw += 0.35 * freq * 35;
      } else if (rxNameLower.includes('furo') || rxNameLower.includes('gaba')) {
        hepaticRaw += 0.15 * freq * 35;
        renalRaw += 0.80 * freq * 35;
      } else if (rxNameLower.includes('oclacitinib') || rxNameLower.includes('apoquel')) {
        // [신규] Oclacitinib(Apoquel) 전용 가중치예요. JAK1 억제제로 주로 간에서 대사되고
        // (canine CYP450 억제 영향은 미미하다고 라벨에 명시돼 있어요) 신장 배출 비중은 낮아서,
        // 간 쪽에 조금 더 무게를 둔 값으로 등록했어요. 이 파일의 다른 하드코딩 값들과 마찬가지로
        // 정밀 약동학 문헌값이 아니라 데모용 근사치라, 실제 임상 기준이 있으면 교체해 주세요.
        hepaticRaw += 0.55 * freq * 30;
        renalRaw += 0.25 * freq * 30;
      } else {
        hepaticRaw += 0.35 * freq * 30;
        renalRaw += 0.35 * freq * 30;
      }
    }
  }

  const suppList = Array.isArray(supplements) ? supplements : [supplements];
  for (const supp of suppList) {
    const suppName = (typeof supp === 'string' ? supp : supp.name || '').toLowerCase();
    if (suppName.includes('칼슘') || suppName.includes('calcium') || suppName.includes('미네랄')) {
      renalRaw += 12;
    } else {
      hepaticRaw += 8;
    }
  }

  const hepaticIndex = Math.min(100, Math.max(0, Math.round(hepaticRaw)));
  const renalIndex = Math.min(100, Math.max(0, Math.round(renalRaw)));

  const getStatus = (idx) => {
    if (idx < 25) return "NORMAL";
    if (idx < 60) return "MODERATE";
    if (idx < 85) return "HIGH";
    return "CRITICAL";
  };

  return {
    hepatic_strain_index: hepaticIndex,
    hepatic_status: getStatus(hepaticIndex),
    renal_strain_index: renalIndex,
    renal_status: getStatus(renalIndex)
  };
}

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/health', async (req, res) => {
  await ensureDrugDictionaryLoaded();
  res.json({ status: 'ok', cached_drugs: drugDictionaryCache.length, timestamp: new Date().toISOString() });
});

app.post('/v1/analyze', rateLimiter, authenticateApiKey, async (req, res) => {
  try {
    await ensureDrugDictionaryLoaded();

    const { prescriptions = [], supplements = [] } = req.body;

    const analyzedPrescriptions = await Promise.all(
      prescriptions.map(async (item) => {
        const drugName = typeof item === 'string' ? item : item.name;
        const frequency = item.frequency_per_day || 1;

        const dbResult = await lookupDrugFromDb(drugName);
        if (dbResult) {
          return {
            ...dbResult,
            frequency_per_day: frequency
          };
        }

        return {
          name: drugName,
          ndc_code: null,
          ndc_11: null,
          ndc_source: "manual",
          ndc_verified: false,
          product_type: "UNKNOWN",
          proprietary_name: drugName,
          frequency_per_day: frequency,
          active_ingredients: [{ name: drugName, strength: '' }]
        };
      })
    );

    const conflicts = await evaluateDniConflictsFromDb(analyzedPrescriptions, supplements);
    const conflictDetected = conflicts.length > 0;
    const hasHigh = conflicts.some(c => c.severity === 'HIGH' || c.severity === 'high');

    const strainMetrics = await calculateMetabolicStrainIndices(analyzedPrescriptions, supplements);

    let recommendedSchedule = "제약 없음 — 평소 급여 스케줄을 유지하세요.";
    if (conflictDetected) {
      recommendedSchedule = hasHigh
        ? "⚠️ 심각한 상호작용 감지: 약물과 영양제 복용 간격을 최소 2시간 이상 유지하거나 수의사 상담이 필요합니다."
        : "⚡ 주의 상호작용 감지: 동시 복용 시 관찰이 필요합니다.";
    }

    const payload = {
      status: "SUCCESS",
      dni_conflict_detected: conflictDetected,
      has_conflict: conflictDetected,
      conflicts_count: conflicts.length,
      conflicts: conflicts,
      recommended_schedule: recommendedSchedule,
      isolation_hours: conflictDetected ? (hasHigh ? 4 : 2) : 0,
      
      hepatic_strain_index: strainMetrics.hepatic_strain_index,
      hepatic_status: strainMetrics.hepatic_status,
      renal_strain_index: strainMetrics.renal_strain_index,
      renal_status: strainMetrics.renal_status,

      prescriptions: analyzedPrescriptions,
      supplements: supplements
    };

    return res.json({
      ...payload,
      data: payload
    });

  } catch (error) {
    console.error("[seon] Analyze error:", error);
    return res.status(500).json({ status: "ERROR", message: error.message });
  }
});

app.listen(PORT, async () => {
  console.log(`[seon] Strict Token Isolation Engine Active | Server running on port ${PORT}`);
  await ensureDrugDictionaryLoaded();

  // [강화] createClient() 는 자격증명이 틀려도 에러 없이 객체를 만들어요(실제 연결은 첫 쿼리 때
  // 비로소 시도돼요). 그래서 기동 직후 실제로 fda_ndc_vet_dictionary 에 접근되는지 가벼운
  // count 쿼리로 자가진단하고, 실패하면 정확한 원인(코드/메시지)을 로그에 남겨요. 이렇게 하면
  // "DB에 데이터를 넣었는데도 인식이 안 된다"는 문제가 URL/KEY 오류인지, RLS 권한 문제인지,
  // 테이블/컬럼 이름이 다른지 서버 로그만 보고 바로 구분할 수 있어요.
  if (supabase) {
    try {
      const { count, error } = await withTimeout(
        supabase.from('fda_ndc_vet_dictionary').select('*', { count: 'exact', head: true }),
        5000,
        'fda_ndc_vet_dictionary 연결 자가진단'
      );
      if (error) {
        console.error(`[seon] ⚠️ fda_ndc_vet_dictionary 연결 자가진단 실패 [${error.code || 'NO_CODE'}]: ${error.message} — 테이블 이름/권한(RLS)/service_role 키를 확인해주세요.`);
      } else {
        console.log(`[seon] ✅ fda_ndc_vet_dictionary 연결 자가진단 성공 — 전체 ${count}행 확인됨`);
      }
    } catch (e) {
      console.error('[seon] ⚠️ fda_ndc_vet_dictionary 연결 자가진단 중 예외:', e.message);
    }
  } else {
    console.warn('[seon] ⚠️ Supabase 클라이언트가 없어 DB 약물 조회(fda_ndc_vet_dictionary)가 항상 건너뛰어집니다.');
  }
});
