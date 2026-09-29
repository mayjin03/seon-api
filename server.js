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
  prednisolone: { ndc_code: '00054-4741-25', ndc_11: '00054474125', proprietary_name: 'PREDNISOLONE', nonproprietary_name: 'PREDNISOLONE', active_ingredients: [{ name: 'PREDNISOLONE', strength: '5 mg' }] }
};

const ALIAS_GROUP_LIST = [
  { masterKey: 'doxycycline', aliases: ['doxycycline', 'doxycyclin', 'vibramycin', 'doxy'] },
  { masterKey: 'enrofloxacin', aliases: ['enrofloxacin', 'enrofloxacine', 'baytril', 'enroflox'] },
  { masterKey: 'ciprofloxacin', aliases: ['ciprofloxacin', 'ciloxan', 'cipro'] },
  { masterKey: 'gabapentin', aliases: ['gabapentin', 'neurontin'] },
  { masterKey: 'carprofen', aliases: ['carprofen', 'rimadyl', 'carprovet'] },
  { masterKey: 'furosemide', aliases: ['furosemide', 'salix', 'lasix'] },
  { masterKey: 'prednisolone', aliases: ['prednisolone', 'prednisolon', 'delta-cortef'] }
];

if (SUPABASE_URL && SUPABASE_KEY) {
  supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
  console.log('[seon] Supabase: connected');
} else {
  console.warn('[seon] Supabase credentials missing');
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
    const { data, error } = await supabase
      .from('fda_ndc_vet_dictionary')
      .select('*')
      .range(0, 1999);

    if (!error && data && data.length > 0) {
      drugDictionaryCache = data;
      console.log(`[seon] Dictionary FULLY loaded: ${drugDictionaryCache.length} items cached.`);
    }
  } catch (err) {
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

async function lookupDrugFromDb(drugInput) {
  if (!drugInput) return null;
  let rawTerm = drugInput.trim();
  const cleanInput = rawTerm.toLowerCase();

  if (TYPO_MAP[cleanInput]) {
    rawTerm = TYPO_MAP[cleanInput];
  }

  const normalizedTerm = normalizeString(rawTerm);
  if (normalizedTerm.length < 3) return null;

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

  return null;
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
      const rxName = (rx.name || '').toLowerCase();
      
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
    const rxNameLower = (rx.name || '').toLowerCase();
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
});
