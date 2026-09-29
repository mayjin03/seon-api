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

if (SUPABASE_URL && SUPABASE_KEY) {
  supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
  console.log('[seon] Supabase: connected');
} else {
  console.warn('[seon] Supabase credentials missing');
}

// 997개 수의용 사전 전수 메모리 로드 (페이지네이션 0~1999)
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
    } else if (error) {
      console.error("[seon] Supabase loading error:", error.message);
    }
  } catch (err) {
    console.error("[seon] Cache exception:", err.message);
  } finally {
    isCacheLoading = false;
  }

  return drugDictionaryCache.length > 0;
}

// 알파벳/숫자 정규화
function normalizeString(str) {
  if (!str) return '';
  return str.toLowerCase().replace(/[^a-z0-9]/g, '');
}

// 토큰화 & 염(Salt) 호환 유연 매칭 Lookup 함수
async function lookupDrugFromDb(drugInput) {
  if (!drugInput) return null;
  const rawTerm = drugInput.trim();
  const lowerTerm = rawTerm.toLowerCase();
  const normalizedTerm = normalizeString(rawTerm);
  const cleanDigits = rawTerm.replace(/[^0-9]/g, '');

  // 의미 있는 3글자 이상 단어 토큰 추출 (예: 'doxycycline hyclate' -> ['doxycycline', 'hyclate'])
  const inputTokens = lowerTerm.split(/\s+/).map(t => normalizeString(t)).filter(t => t.length >= 3);

  await ensureDrugDictionaryLoaded();

  if (drugDictionaryCache.length > 0) {
    const matched = drugDictionaryCache.find(d => {
      const propNorm = normalizeString(d.proprietary_name || '');
      const nonPropNorm = normalizeString(d.nonproprietary_name || '');
      const ndc = (d.ndc_code || '').toLowerCase();
      const ndc11 = (d.ndc_11 || '').toLowerCase();
      const ingredients = d.active_ingredients || [];

      // 1. 상표명 / 대표성분명 / NDC 매칭
      if (propNorm.includes(normalizedTerm) || nonPropNorm.includes(normalizedTerm) || ndc.includes(lowerTerm)) {
        return true;
      }
      if (cleanDigits.length >= 8 && ndc11.includes(cleanDigits)) {
        return true;
      }

      // 2. active_ingredients 내 핵심 단어 토큰 매칭 (HYCLATE vs MONOHYDRATE 호환 해결)
      return ingredients.some(ing => {
        const ingNorm = normalizeString(ing.name || '');
        // 입력 토큰 중 단 하나라도(예: doxycycline) 성분명에 포함되면 매칭 성공
        return inputTokens.some(token => ingNorm.includes(token) || token.includes(ingNorm));
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
  console.log(`[seon] Tokenized Salt-Flexible DNI Engine Active | Server running on port ${PORT}`);
  await ensureDrugDictionaryLoaded();
});
