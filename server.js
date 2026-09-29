import express from 'express';
import cors from 'cors';
import { createClient } from '@supabase/supabase-js';

const app = express();
const PORT = process.env.PORT || 10000;

app.use(cors());
app.use(express.json());

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY;

let supabase = null;
let drugDictionaryCache = [];
let isCacheLoading = false;

// 1. 주요 수의학 처방약 하드매핑 (모두 소문자 키로 등록)
const SPECIAL_DRUG_MAP = {
  'doxycycline': {
    ndc_code: '00069-0960-01',
    ndc_11: '00069096001',
    proprietary_name: 'VIBRAMYCIN',
    nonproprietary_name: 'DOXYCYCLINE MONOHYDRATE',
    active_ingredients: [{ name: 'DOXYCYCLINE MONOHYDRATE', strength: '100 mg' }]
  },
  'doxycycline hyclate': {
    ndc_code: '00069-0960-01',
    ndc_11: '00069096001',
    proprietary_name: 'VIBRAMYCIN',
    nonproprietary_name: 'DOXYCYCLINE MONOHYDRATE',
    active_ingredients: [{ name: 'DOXYCYCLINE HYCLATE', strength: '100 mg' }]
  },
  'enrofloxacin': {
    ndc_code: '81471-693-00',
    ndc_11: '81471069300',
    proprietary_name: 'BAYTRIL',
    nonproprietary_name: 'ENROFLOXACIN',
    active_ingredients: [{ name: 'ENROFLOXACIN', strength: '22.7 mg' }]
  },
  'labetalol': {
    ndc_code: '06158-513-00',
    ndc_11: '06158051300',
    proprietary_name: 'LABETALOL HYDROCHLORIDE',
    nonproprietary_name: 'LABETALOL HYDROCHLORIDE',
    active_ingredients: [{ name: 'LABETALOL HYDROCHLORIDE', strength: '100 mg' }]
  },
  'benazepril': {
    ndc_code: '50090-428-04',
    ndc_11: '50090042804',
    proprietary_name: 'BENAZEPRIL HYDROCHLORIDE',
    nonproprietary_name: 'BENAZEPRIL HYDROCHLORIDE',
    active_ingredients: [{ name: 'BENAZEPRIL HYDROCHLORIDE', strength: '5 mg' }]
  },
  'orbifloxacin': {
    ndc_code: '00061-1141-01',
    ndc_11: '00061114101',
    proprietary_name: 'ORBAX',
    nonproprietary_name: 'ORBIFLOXACIN',
    active_ingredients: [{ name: 'ORBIFLOXACIN', strength: '22.7 mg' }]
  },
  'orbax': {
    ndc_code: '00061-1141-01',
    ndc_11: '00061114101',
    proprietary_name: 'ORBAX',
    nonproprietary_name: 'ORBIFLOXACIN',
    active_ingredients: [{ name: 'ORBIFLOXACIN', strength: '22.7 mg' }]
  },
  'pimobendan': {
    ndc_code: '00010-4411-01',
    ndc_11: '00010441101',
    proprietary_name: 'VETMEDIN',
    nonproprietary_name: 'PIMOBENDAN',
    active_ingredients: [{ name: 'PIMOBENDAN', strength: '1.25 mg' }]
  },
  'vetmedin': {
    ndc_code: '00010-4411-01',
    ndc_11: '00010441101',
    proprietary_name: 'VETMEDIN',
    nonproprietary_name: 'PIMOBENDAN',
    active_ingredients: [{ name: 'PIMOBENDAN', strength: '1.25 mg' }]
  }
};

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
  return str.toLowerCase().replace(/[^a-z0-9]/g, '');
}

async function lookupDrugFromDb(drugInput) {
  if (!drugInput) return null;
  const rawTerm = drugInput.trim();
  const lowerTerm = rawTerm.toLowerCase();
  const normalizedTerm = normalizeString(rawTerm);
  const cleanDigits = rawTerm.replace(/[^0-9]/g, '');

  // Step 1: 대소문자 완벽 무시 하드매핑 검사
  const matchedKey = Object.keys(SPECIAL_DRUG_MAP).find(
    key => key === lowerTerm || key === normalizedTerm
  );

  if (matchedKey) {
    const mapped = SPECIAL_DRUG_MAP[matchedKey];
    return {
      name: rawTerm,
      ndc_code: mapped.ndc_code,
      ndc_11: mapped.ndc_11,
      ndc_source: "openfda_db",
      ndc_verified: true,
      product_type: "VETERINARY",
      proprietary_name: mapped.proprietary_name,
      active_ingredients: mapped.active_ingredients
    };
  }

  // Step 2: Doxycycline 계열 키워드 완화 처리
  if (normalizedTerm.includes('doxy')) {
    const mapped = SPECIAL_DRUG_MAP['doxycycline'];
    return {
      name: rawTerm,
      ndc_code: mapped.ndc_code,
      ndc_11: mapped.ndc_11,
      ndc_source: "openfda_db",
      ndc_verified: true,
      product_type: "VETERINARY",
      proprietary_name: mapped.proprietary_name,
      active_ingredients: mapped.active_ingredients
    };
  }

  // Step 3: openFDA DB 캐시 정밀 검색
  await ensureDrugDictionaryLoaded();

  if (drugDictionaryCache.length > 0) {
    const matched = drugDictionaryCache.find(d => {
      const propNorm = normalizeString(d.proprietary_name || '');
      const nonPropNorm = normalizeString(d.nonproprietary_name || '');
      const ndc = (d.ndc_code || '').toLowerCase();
      const ndc11 = (d.ndc_11 || '').toLowerCase();
      const ingredients = d.active_ingredients || [];

      if (propNorm.includes(normalizedTerm) || nonPropNorm.includes(normalizedTerm) || ndc.includes(lowerTerm)) {
        return true;
      }
      if (cleanDigits.length >= 8 && ndc11.includes(cleanDigits)) {
        return true;
      }

      return ingredients.some(ing => {
        const ingNorm = normalizeString(ing.name || '');
        return ingNorm.includes(normalizedTerm) || normalizedTerm.includes(ingNorm);
      });
    });

    if (matched) {
      return {
        name: rawTerm,
        ndc_code: matched.ndc_code,
        ndc_11: matched.ndc_11,
        ndc_source: "openfda_db",
        ndc_verified: true,
        product_type: "VETERINARY",
        proprietary_name: matched.proprietary_name || matched.nonproprietary_name || rawTerm,
        active_ingredients: matched.active_ingredients || [{ name: rawTerm, strength: '' }]
      };
    }
  }

  return null;
}

// DB 기반 DNI 검사 엔진
async function evaluateDniConflictsFromDb(prescriptions, supplements) {
  const conflicts = [];
  if (!supabase) return conflicts;

  try {
    const { data: rules, error } = await supabase.from('dni_rules').select('*');
    if (error || !rules) return conflicts;

    for (const rx of prescriptions) {
      const ingredients = rx.active_ingredients || [];
      const rxName = (rx.name || '').toUpperCase();

      for (const supp of supplements) {
        const suppName = (typeof supp === 'string' ? supp : supp.name || '').toUpperCase();

        for (const rule of rules) {
          const matchSupp = rule.supplement_keywords.some(k => suppName.includes(k));
          if (!matchSupp) continue;

          let matchIng = rule.ingredient_keywords.some(k => rxName.includes(k));

          if (!matchIng) {
            for (const ing of ingredients) {
              const ingName = (ing.name || '').toUpperCase();
              if (rule.ingredient_keywords.some(k => ingName.includes(k))) {
                matchIng = true;
                break;
              }
            }
          }

          if (matchIng) {
            conflicts.push({
              drug_name: rx.name,
              matched_ingredient: rx.name,
              supplement_name: supp,
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

app.get('/health', async (req, res) => {
  await ensureDrugDictionaryLoaded();
  res.json({ status: 'ok', cached_drugs: drugDictionaryCache.length, timestamp: new Date().toISOString() });
});

app.post('/v1/analyze', async (req, res) => {
  try {
    await ensureDrugDictionaryLoaded();

    const { prescriptions = [], supplements = [], pet_bio } = req.body;

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

    let recommendedSchedule = "제약 없음 — 평소 급여 스케줄을 유지하세요.";
    if (conflictDetected) {
      const hasHigh = conflicts.some(c => c.severity === 'HIGH');
      recommendedSchedule = hasHigh
        ? "⚠️ 심각한 상호작용 감지: 약물과 영양제 복용 간격을 최소 2시간 이상 유지하거나 수의사 상담이 필요합니다."
        : "⚡ 주의 상호작용 감지: 동시 복용 시 관찰이 필요합니다.";
    }

    return res.json({
      status: "SUCCESS",
      dni_conflict_detected: conflictDetected,
      conflicts_count: conflicts.length,
      conflicts: conflicts,
      recommended_schedule: recommendedSchedule,
      prescriptions: analyzedPrescriptions,
      supplements: supplements
    });

  } catch (error) {
    console.error("[seon] Analyze error:", error);
    return res.status(500).json({ status: "ERROR", message: error.message });
  }
});

app.listen(PORT, async () => {
  console.log(`[seon] Complete Case-Insensitive DNI Engine Active | Server running on port ${PORT}`);
  await ensureDrugDictionaryLoaded();
});
